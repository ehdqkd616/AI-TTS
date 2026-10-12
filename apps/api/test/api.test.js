import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BaseProvider } from '../src/providers/BaseProvider.js';
import { ProviderError } from '../src/lib/errors.js';
import { startApp, approvedUser, ADMIN } from './helpers.js';

let app, admin, user;

before(async () => {
  app = await startApp();
  admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  user = await approvedUser(app, admin);
});
after(() => app.close());

test('로그인하지 않으면 TTS 기능 사용 불가', async () => {
  const anon = app.client();
  for (const [m, p] of [['GET', '/api/voices'], ['POST', '/api/tts'], ['POST', '/api/detect'], ['GET', '/api/history'], ['GET', '/api/config']]) {
    const r = await anon.req(m, p, m === 'POST' ? { text: 'hi' } : undefined);
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test('보이스 목록: 키 없는 엔진은 available=false', async () => {
  const { body } = await user.json('GET', '/api/voices');
  const ko = body.locales.find((l) => l.locale === 'ko-KR');
  assert.ok(ko.voices.some((v) => v.provider === 'azure' && !v.available));
  assert.ok(ko.voices.some((v) => v.provider === 'mock' && v.available));
});

test('언어 감지 API', async () => {
  const { body } = await user.json('POST', '/api/detect', { text: '안녕하세요' });
  assert.equal(body.locale, 'ko-KR');
});

test('TTS 생성 → 다운로드 → 캐시 적중 → 이력', async () => {
  const req = { text: '사과 3개를 샀어요. 정말 맛있어요!', format: 'mp3', speed: 1.25 };
  const first = (await user.json('POST', '/api/tts', req)).body;
  assert.equal(first.locale, 'ko-KR');
  assert.equal(first.normalized, '사과 세 개를 샀어요. 정말 맛있어요!');
  assert.equal(first.cached, false);

  const audio = await user.get(`${first.audioUrl}?download=1`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.match(audio.headers.get('content-disposition'), /attachment/);
  assert.ok((await audio.arrayBuffer()).byteLength > 1000);

  const second = (await user.json('POST', '/api/tts', req)).body;
  assert.equal(second.cached, true);
  assert.equal(second.audioUrl, first.audioUrl);

  const { body } = await user.json('GET', '/api/history');
  assert.equal(body.items[0].cached, true);
  assert.equal(body.items[1].cached, false);
});

test('다른 회원의 이력·음성 파일은 볼 수 없음 (관리자는 가능)', async () => {
  const other = await approvedUser(app, admin, 'other1', 'OtherPass123');
  const mine = (await user.json('POST', '/api/tts', { text: 'Private sentence.', locale: 'en-US' })).body;
  assert.equal((await other.json('GET', '/api/history')).body.items.length, 0);
  assert.equal((await other.get(mine.audioUrl)).status, 404);
  assert.equal((await admin.get(mine.audioUrl)).status, 200);
});

test('WAV 출력 + 사용자가 수정한 정규화 텍스트 사용', async () => {
  const r = (await user.json('POST', '/api/tts', { text: 'AI', locale: 'ko-KR', normalizedText: '에이 아이', format: 'wav' })).body;
  assert.equal(r.normalized, '에이 아이');
  const audio = Buffer.from(await (await user.get(r.audioUrl)).arrayBuffer());
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
});

test('긴 텍스트는 여러 청크로 나뉘어 병합', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}.`).join(' ');
  const r = (await user.json('POST', '/api/tts', { text, locale: 'en-US' })).body;
  assert.ok(r.chunks > 1, `chunks=${r.chunks}`);
});

test('입력 검증', async () => {
  const post = (body) => user.req('POST', '/api/tts', body);
  assert.equal((await post({ text: '' })).status, 400);
  assert.equal((await post({ text: 'hi', speed: 5 })).status, 400);
  assert.equal((await post({ text: 'hi', format: 'flac' })).status, 400);
  assert.equal((await post({ text: 'hi', locale: 'xx-XX' })).status, 400);
  assert.equal((await post({ text: 'x'.repeat(5001) })).status, 400);
  assert.equal((await post({ text: 'hi', locale: 'en-US', voiceId: 'azure:en-US-JennyNeural' })).status, 503);
  assert.equal((await user.get('/api/audio/..%2F..%2Fetc%2Fpasswd')).status, 404);
});

test('1순위 엔진 실패 시 다른 엔진으로 fallback', async () => {
  class Failing extends BaseProvider {
    name = 'azure';
    isEnabled() { return true; }
    async synthesize() { throw new ProviderError('azure', 'boom', { retryable: false }); }
  }
  app.providers.set('azure', new Failing());
  try {
    const r = (await user.json('POST', '/api/tts', { text: 'Hello there.', locale: 'en-US' })).body;
    assert.equal(r.voice.provider, 'mock');
    assert.equal(r.fallbackFrom, 'azure:en-US-JennyNeural');
  } finally {
    app.providers.delete('azure');
  }
});

test('보안 헤더', async () => {
  const res = await fetch(`${app.origin}/api/health`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('CSRF: 다른 출처·폼 전송 거부', async () => {
  const evil = await user.req('POST', '/api/tts', { text: 'hi' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const form = await user.req('POST', '/api/auth/logout', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
});
