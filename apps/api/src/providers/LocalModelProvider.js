import { BaseProvider } from './BaseProvider.js';

/**
 * 오픈소스 모델 서버(Python FastAPI 등) 호출.
 * 계약: POST {MODEL_SERVER_URL}/synthesize  JSON {text, locale, voice, speed} → 오디오 바이트(WAV 권장)
 */
export class LocalModelProvider extends BaseProvider {
  name = 'local';
  maxChars = 500;
  supportsSpeed = true;
  // 모델 서버는 CPU로 한 번에 하나씩 처리하고, 쉬다가 첫 요청이면 모델 로드(10~30초)도 기다려야 한다
  timeoutMs = 180_000;

  constructor(env = process.env) {
    super();
    this.baseUrl = env.MODEL_SERVER_URL?.replace(/\/$/, '');
  }

  isEnabled() {
    return Boolean(this.baseUrl);
  }

  async synthesize(text, locale, voice, { speed = 1 } = {}) {
    const res = await this.request(`${this.baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, locale, voice: voice.voiceId, speed }),
    });
    return Buffer.from(await res.arrayBuffer());
  }
}
