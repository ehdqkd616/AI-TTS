import { BaseProvider } from './BaseProvider.js';

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** Azure AI Speech REST (SSML). https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech */
export class AzureProvider extends BaseProvider {
  name = 'azure';
  maxChars = 2000;
  supportsSpeed = true;

  constructor(env = process.env) {
    super();
    this.key = env.AZURE_SPEECH_KEY;
    this.region = env.AZURE_SPEECH_REGION;
  }

  isEnabled() {
    return Boolean(this.key && this.region);
  }

  async synthesize(text, locale, voice, { speed = 1 } = {}) {
    const rate = `${Math.round((speed - 1) * 100)}%`;
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
      `<voice name="${voice.voiceId}"><prosody rate="${rate}">${escapeXml(text)}</prosody></voice></speak>`;

    const res = await this.request(`https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
        'User-Agent': 'ai-tts',
      },
      body: ssml,
    });
    return Buffer.from(await res.arrayBuffer());
  }
}
