import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers/index.js';
import { VoiceCatalog } from '../src/services/voices.js';

test('무료 모델 서버가 켜지면 무료 보이스가 1순위, mock은 꺼짐', () => {
  const voices = new VoiceCatalog(createProviders({ MODEL_SERVER_URL: 'http://127.0.0.1:8020', TTS_MOCK: 'auto' }));
  assert.equal(voices.resolve('ko-KR')[0].id, 'local:melo/KR');
  assert.equal(voices.resolve('en-US')[0].id, 'local:kokoro/af_heart');
  assert.ok(!voices.resolve('ko-KR').some((v) => v.provider === 'mock'));
});

test('쓸 수 있는 보이스가 없는 언어는 목록에서 숨김', () => {
  const voices = new VoiceCatalog(createProviders({ MODEL_SERVER_URL: 'http://127.0.0.1:8020', TTS_MOCK: 'false' }));
  const locales = voices.list().map((l) => l.locale);
  assert.ok(locales.includes('ko-KR'));
  assert.ok(!locales.includes('de-DE')); // 무료 독일어 보이스 없음
  assert.throws(() => voices.resolve('de-DE'), /사용 가능한 TTS 엔진이 없습니다/);
});

test('유료 키가 있으면 유료 보이스는 같은 언어의 fallback으로', () => {
  const voices = new VoiceCatalog(createProviders({ MODEL_SERVER_URL: 'http://x', AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'r' }));
  const ko = voices.resolve('ko-KR');
  assert.equal(ko[0].provider, 'local');
  assert.equal(ko[1].provider, 'azure');
});
