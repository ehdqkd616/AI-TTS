"""운영 서버는 HF_HUB_OFFLINE=1로 뜨므로, 쓰는 모델·보이스 파일을 모두 미리 받아 둔다."""
from huggingface_hub import hf_hub_download

import app

# Kokoro: 공용 모델 + 보이스마다 별도 파일
for f in ("config.json", "kokoro-v1_0.pth"):
    hf_hub_download("hexgrad/Kokoro-82M", f)
for voice, (engine, _, speaker) in app.VOICES.items():
    if engine == "kokoro":
        hf_hub_download("hexgrad/Kokoro-82M", f"voices/{speaker}.pt")
        print("ready", voice)

# MeloTTS: 모델 + 언어별 BERT는 한 번 합성해 보는 것으로 받는다 (코드가 내부에서 내려받음)
for voice, (engine, _, _) in app.VOICES.items():
    if engine == "melo":
        app.synthesize(voice, "test", 1.0)
        print("ready", voice)
