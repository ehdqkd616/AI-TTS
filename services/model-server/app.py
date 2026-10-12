"""무료 오픈소스 TTS 모델 서버 (MeloTTS + Kokoro, CPU).

Node API 서버의 LocalModelProvider가 호출한다.
  POST /synthesize  {text, locale, voice, speed} → audio/wav
  GET  /health      → 로드된 모델 목록
127.0.0.1에만 바인딩하고 외부에는 노출하지 않는다.
"""

import io
import logging
import os
import threading
import time
from collections import OrderedDict

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

log = logging.getLogger("model-server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# CPU 코어를 다른 서비스와 나눠 쓰도록 제한
torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "4")))

# voice id → (엔진, 엔진 언어, 화자)
# MeloTTS: 언어별 원어민 데이터로 학습된 개별 모델. 무료 경량 모델 중 한국어를 지원하는 거의 유일한 선택지.
#   단, 언어마다 BERT를 모듈 전역에 붙잡아 두어 모델을 내려도 메모리가 반환되지 않는다(언어당 약 +0.8~1GB).
#   이 서버는 RAM 여유가 적어 한국어에만 쓴다. 다른 언어를 켜려면 MELO_LANGS 환경 변수로 (예: KR,JP).
# Kokoro: 82M 경량 모델 하나를 모든 언어가 공유 → 언어를 늘려도 메모리가 거의 늘지 않는다.
MELO_VOICES = {
    "melo/KR": ("melo", "KR", "KR"),
    "melo/JP": ("melo", "JP", "JP"),
    "melo/ZH": ("melo", "ZH", "ZH"),
    "melo/ES": ("melo", "ES", "ES"),
    "melo/FR": ("melo", "FR", "FR"),
    "melo/EN-US": ("melo", "EN", "EN-US"),
    "melo/EN-BR": ("melo", "EN", "EN-BR"),
    "melo/EN-AU": ("melo", "EN", "EN-AU"),
    "melo/EN-IN": ("melo", "EN", "EN_INDIA"),
}
MELO_LANGS = {s.strip() for s in os.environ.get("MELO_LANGS", "KR").split(",") if s.strip()}
VOICES = {
    **{k: v for k, v in MELO_VOICES.items() if v[1] in MELO_LANGS},
    "kokoro/af_heart": ("kokoro", "a", "af_heart"),
    "kokoro/af_bella": ("kokoro", "a", "af_bella"),
    "kokoro/am_michael": ("kokoro", "a", "am_michael"),
    "kokoro/am_fenrir": ("kokoro", "a", "am_fenrir"),
    "kokoro/bf_emma": ("kokoro", "b", "bf_emma"),
    "kokoro/bm_george": ("kokoro", "b", "bm_george"),
    "kokoro/jf_alpha": ("kokoro", "j", "jf_alpha"),
    "kokoro/jm_kumo": ("kokoro", "j", "jm_kumo"),
    "kokoro/zf_xiaoxiao": ("kokoro", "z", "zf_xiaoxiao"),
    "kokoro/zm_yunxi": ("kokoro", "z", "zm_yunxi"),
    "kokoro/ef_dora": ("kokoro", "e", "ef_dora"),
    "kokoro/em_alex": ("kokoro", "e", "em_alex"),
    "kokoro/ff_siwis": ("kokoro", "f", "ff_siwis"),
    "kokoro/pf_dora": ("kokoro", "p", "pf_dora"),
    "kokoro/pm_alex": ("kokoro", "p", "pm_alex"),
}

# 마지막 요청 후 이 시간(분) 동안 쓰지 않으면 프로세스를 종료해 메모리를 돌려준다 (pm2가 빈 상태로 재시작).
# MeloTTS는 BERT를 모듈 전역에 붙잡아 두어 프로세스 종료 말고는 메모리를 확실히 회수할 방법이 없다. 0이면 끔.
IDLE_EXIT_MINUTES = float(os.environ.get("IDLE_EXIT_MINUTES", "10"))
_last_used = time.monotonic()
_models_loaded = False

# 모델을 새로 올리기 전 시스템 여유 메모리 확인 — 부족하면 올리지 않고 503.
# 이 서버는 다른 서비스와 RAM을 나눠 쓰고 스왑이 이미 가득 차 있어, 무리하게 올리면 커널 OOM이
# 다른 프로젝트 프로세스까지 죽인다(2026-10 실제 발생). 음성 생성 실패가 그보다 낫다.
LOAD_HEADROOM_MB = {"melo": 2300, "kokoro": 1700}  # 로드에 필요한 양 + 여유


class NotEnoughMemory(Exception):
    pass


def mem_available_mb() -> int:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    return 0


def ensure_memory(engine: str):
    need, have = LOAD_HEADROOM_MB[engine], mem_available_mb()
    if have < need:
        raise NotEnoughMemory(f"{engine} 로드에 메모리 {need}MB 필요, 여유 {have}MB")


MAX_MELO_MODELS = int(os.environ.get("MAX_MELO_MODELS", str(len(MELO_LANGS))))
KOKORO_SR = 24000

# 추론은 한 번에 하나씩 (CPU 경합·메모리 급증 방지)
_lock = threading.Lock()
_melo: "OrderedDict[str, object]" = OrderedDict()
_kokoro_model = None
_kokoro_pipelines: dict = {}


def melo_model(lang: str):
    """언어별 MeloTTS 모델 (LRU로 최대 MAX_MELO_MODELS개만 메모리에 유지)"""
    from melo.api import TTS

    if lang in _melo:
        _melo.move_to_end(lang)
        return _melo[lang]
    ensure_memory("melo")
    while len(_melo) >= MAX_MELO_MODELS:
        evicted, _ = _melo.popitem(last=False)
        log.info("unload melo %s", evicted)
    log.info("load melo %s", lang)
    _melo[lang] = TTS(language=lang, device="cpu")
    return _melo[lang]


def kokoro_pipeline(lang: str):
    global _kokoro_model
    from kokoro import KModel, KPipeline

    if _kokoro_model is None:
        ensure_memory("kokoro")
        log.info("load kokoro model")
        _kokoro_model = KModel(repo_id="hexgrad/Kokoro-82M").eval()
    if lang not in _kokoro_pipelines:
        _kokoro_pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", model=_kokoro_model)
    return _kokoro_pipelines[lang]


def synthesize(voice: str, text: str, speed: float) -> tuple[np.ndarray, int]:
    global _models_loaded
    _models_loaded = True
    engine, lang, speaker = VOICES[voice]
    if engine == "melo":
        model = melo_model(lang)
        audio = model.tts_to_file(text, model.hps.data.spk2id[speaker], output_path=None, speed=speed, quiet=True)
        return audio, model.hps.data.sampling_rate
    pipeline = kokoro_pipeline(lang)
    parts = [a.numpy() if hasattr(a, "numpy") else a for _, _, a in pipeline(text, voice=speaker, speed=speed) if a is not None]
    if not parts:
        raise ValueError("no audio produced")
    return np.concatenate(parts), KOKORO_SR


class SynthesizeIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    locale: str | None = None
    voice: str
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health():
    return {"ok": True, "melo": list(_melo), "kokoro": list(_kokoro_pipelines), "voices": list(VOICES)}


@app.post("/synthesize")
def synthesize_endpoint(body: SynthesizeIn):
    if body.voice not in VOICES:
        raise HTTPException(400, f"unknown voice: {body.voice}")
    global _last_used
    with _lock:
        _last_used = time.monotonic()
        try:
            audio, sr = synthesize(body.voice, body.text, body.speed)
        except NotEnoughMemory as e:
            log.warning("refused: %s", e)
            raise HTTPException(503, "server memory low")
        except Exception:
            log.exception("synthesis failed (%s)", body.voice)
            raise HTTPException(500, "synthesis failed")
        finally:
            _last_used = time.monotonic()
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")


def _warmup():
    # WARMUP_VOICES에 지정한 모델을 미리 올린다 (기본은 없음 — 메모리 절약을 위해 요청 시 로드)
    for voice in os.environ.get("WARMUP_VOICES", "").split(","):
        voice = voice.strip()
        if voice in VOICES:
            with _lock:
                try:
                    synthesize(voice, "warm up.", 1.0)
                    log.info("warmed up %s", voice)
                except Exception:
                    log.exception("warmup failed (%s)", voice)


def _idle_watchdog():
    while True:
        time.sleep(30)
        idle = time.monotonic() - _last_used
        if _models_loaded and idle > IDLE_EXIT_MINUTES * 60 and _lock.acquire(blocking=False):
            log.info("idle %.0f min — exiting to free model memory (pm2 restarts empty)", idle / 60)
            logging.shutdown()
            os._exit(0)


@app.on_event("startup")
def _startup():
    threading.Thread(target=_warmup, daemon=True).start()
    if IDLE_EXIT_MINUTES > 0:
        threading.Thread(target=_idle_watchdog, daemon=True).start()
