import { BaseProvider } from './BaseProvider.js';

/** OpenAI Audio Speech. https://platform.openai.com/docs/api-reference/audio/createSpeech */
export class OpenAIProvider extends BaseProvider {
  name = 'openai';
  maxChars = 2000;
  supportsSpeed = true;

  constructor(env = process.env) {
    super();
    this.apiKey = env.OPENAI_API_KEY;
    this.model = env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  }

  isEnabled() {
    return Boolean(this.apiKey);
  }

  async synthesize(text, locale, voice, { speed = 1 } = {}) {
    const res = await this.request('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, voice: voice.voiceId, input: text, speed, response_format: 'wav' }),
    });
    return Buffer.from(await res.arrayBuffer());
  }
}
