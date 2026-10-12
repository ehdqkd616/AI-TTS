import { BaseProvider } from './BaseProvider.js';

/** ElevenLabs REST. https://elevenlabs.io/docs/api-reference/text-to-speech */
export class ElevenLabsProvider extends BaseProvider {
  name = 'elevenlabs';
  maxChars = 2000;
  // ElevenLabs의 speed 설정은 허용 범위가 좁아 후처리(atempo)로 통일
  supportsSpeed = false;

  constructor(env = process.env) {
    super();
    this.apiKey = env.ELEVENLABS_API_KEY;
    this.modelId = env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
  }

  isEnabled() {
    return Boolean(this.apiKey);
  }

  async synthesize(text, locale, voice) {
    const res = await this.request(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.modelId }),
      },
    );
    return Buffer.from(await res.arrayBuffer());
  }
}
