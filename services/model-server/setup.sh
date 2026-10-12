#!/bin/bash
# 무료 TTS 모델 서버 설치 (MeloTTS 한국어 + Kokoro). Python 3.12, CPU 전용.
#   ./setup.sh && pm2 start ../../ecosystem.config.cjs --only ai-tts-models && pm2 save
set -euo pipefail
cd "$(dirname "$0")"

python3.12 -m venv .venv
.venv/bin/pip install -q --upgrade pip
# GPU(GTX 1050 Ti)는 RVC가 쓰고 최신 PyTorch가 지원하지 않아 CPU 빌드만 쓴다
.venv/bin/pip install -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -q -r requirements.lock.txt

# MeloTTS: requirements.txt가 Python 3.12에서 설치 불가능한 옛 버전을 고정하고 있어
# 코드만 설치하고(--no-deps) 의존성은 requirements.lock.txt의 호환 버전을 쓴다
if [ ! -d vendor/MeloTTS ]; then
  git clone -q https://github.com/myshell-ai/MeloTTS.git vendor/MeloTTS
fi
git -C vendor/MeloTTS checkout -q 209145371cff8fc3bd60d7be902ea69cbdb7965a
.venv/bin/pip install -q --no-deps -e vendor/MeloTTS

# 일본어 형태소 사전(MeCab UniDic, 약 800MB)과 영어 G2P용 NLTK 데이터
.venv/bin/python -m unidic download
.venv/bin/python -c "import nltk; nltk.download('averaged_perceptron_tagger_eng', quiet=True); nltk.download('cmudict', quiet=True)"

# 모델 가중치를 미리 받아 둔다 (운영은 HF_HUB_OFFLINE=1로 네트워크 없이 기동)
.venv/bin/python download_models.py
