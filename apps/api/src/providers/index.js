import { AzureProvider } from './AzureProvider.js';
import { GoogleProvider } from './GoogleProvider.js';
import { ElevenLabsProvider } from './ElevenLabsProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { LocalModelProvider } from './LocalModelProvider.js';
import { MockProvider } from './MockProvider.js';

/** 환경 변수로 Provider 레지스트리 생성 */
export function createProviders(env = process.env) {
  const real = [
    new AzureProvider(env),
    new GoogleProvider(env),
    new ElevenLabsProvider(env),
    new OpenAIProvider(env),
    new LocalModelProvider(env),
  ];
  const mock = new MockProvider(env, { othersEnabled: real.some((p) => p.isEnabled()) });
  return new Map([...real, mock].map((p) => [p.name, p]));
}
