import { BaseProvider } from './BaseProvider.js';

/** Google Cloud Text-to-Speech REST (API 키). https://cloud.google.com/text-to-speech/docs/reference/rest */
export class GoogleProvider extends BaseProvider {
  name = 'google';
  // 요청 한도가 바이트 기준이라 CJK(3바이트/자)를 고려해 보수적으로 설정
  maxChars = 1500;
  supportsSpeed = true;

  constructor(env = process.env) {
    super();
    this.apiKey = env.GOOGLE_TTS_API_KEY;
  }

  isEnabled() {
    return Boolean(this.apiKey);
  }

  async synthesize(text, locale, voice, { speed = 1 } = {}) {
    const res = await this.request(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: voice.providerLocale ?? locale, name: voice.voiceId },
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: speed },
        }),
      },
    );
    const { audioContent } = await res.json();
    return Buffer.from(audioContent, 'base64');
  }
}
