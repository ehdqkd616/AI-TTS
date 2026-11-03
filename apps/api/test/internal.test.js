import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, ADMIN } from './helpers.js';

const TOKEN = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
let app;
let rvcRoot;

async function makeFakeRvc() {
  const root = await mkdtemp(path.join(tmpdir(), 'fake-rvc-'));
  await mkdir(path.join(root, 'infer'), { recursive: true });
  await mkdir(path.join(root, '.venv', 'bin'), { recursive: true });
  await writeFile(path.join(root, 'infer', 'cli.py'), '# fake');
  const py = path.join(root, '.venv', 'bin', 'python');
  // 입력을 그대로 복사 (실제 RVC처럼 길이 유지)
  await writeFile(py, `#!/bin/sh
echo "$@" >> "${root}/calls.log"
in=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list-speakers) echo "0-0"; exit 0 ;;
    --input) in="$2"; shift ;;
    --output) out="$2"; shift ;;
  esac
  shift
done
cp "$in" "$out"
`);
  await chmod(py, 0o755);
  return root;
}

const svc = (method, p, body, token = TOKEN) =>
  fetch(app.origin + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Internal-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const SEGMENTS = [
  { id: 's1', text: '윈도우 캡처, 아직도 이렇게 하세요?' },
  { id: 's2', text: '단축키 하나면 끝나요.' },
  { id: 's3', text: '자세한 방법은 블로그에 정리해 뒀어요.' },
];

before(async () => {
  rvcRoot = await makeFakeRvc();
  app = await startApp({ INTERNAL_API_TOKENS: `shorts:${TOKEN}, bad:short`, INTERNAL_DAILY_CHAR_LIMIT: '200', RVC_ROOT: rvcRoot });
});
after(async () => {
  await app.close();
  await rm(rvcRoot, { recursive: true, force: true });
});

test('내부 API: 토큰이 없으면 존재하지 않는 것처럼 404, 틀리면 401', async () => {
  assert.equal((await svc('GET', '/api/internal/v1/health', null, null)).status, 404);
  assert.equal((await svc('GET', '/api/internal/v1/health', null, OTHER)).status, 401);
  // 너무 짧은 토큰(bad:short)은 설정에서 무시된다
  assert.equal((await svc('GET', '/api/internal/v1/health', null, 'short')).status, 401);
  // 로그인한 관리자라도 쿠키로는 내부 API를 쓸 수 없다
  const admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  assert.equal((await admin.get('/api/internal/v1/health')).status, 404);
  const ok = await svc('GET', '/api/internal/v1/health');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.caller, 'shorts');
  assert.equal(body.features.rvc, true);
});

test('내부 API: 서비스 토큰 요청은 CSRF(JSON·Origin) 검사 대상이 아니지만 관리자 권한은 없다', async () => {
  const res = await fetch(app.origin + '/api/internal/v1/narrations', {
    method: 'POST',
    headers: { 'X-Internal-Token': TOKEN, 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.notEqual(res.status, 403);
  assert.notEqual(res.status, 415);
  assert.equal((await svc('GET', '/api/admin/users')).status, 403);
});

test('catalog: 보이스 목록과 RVC 상태', async () => {
  const body = await (await svc('GET', '/api/internal/v1/catalog')).json();
  assert.ok(body.locales.some((l) => l.locale === 'ko-KR'));
  assert.equal(body.rvcEnabled, true);
  assert.deepEqual(body.voiceModels, []);
});

test('narrations: 문장별 시작·끝 시각, 48kHz WAV, 같은 요청은 캐시', async () => {
  const res = await svc('POST', '/api/internal/v1/narrations', { locale: 'ko-KR', segments: SEGMENTS, gapMs: 300 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cached, false);
  assert.equal(body.segments.length, 3);
  assert.deepEqual(body.segments.map((s) => s.id), ['s1', 's2', 's3']);
  assert.equal(body.segments[0].startMs, 0);
  for (let i = 0; i < 3; i++) {
    const s = body.segments[i];
    assert.ok(s.endMs > s.startMs, 'end > start');
    if (i > 0) assert.ok(Math.abs(s.startMs - body.segments[i - 1].endMs - 300) <= 2, '문장 사이 무음 300ms');
  }
  assert.ok(Math.abs(body.durationMs - body.segments[2].endMs) <= 30, '전체 길이 ≈ 마지막 문장 끝');
  assert.equal(body.sampleRate, 48000);
  assert.match(body.audioUrl, /^\/api\/internal\/v1\/narrations\/[0-9a-f]{64}\.wav$/);

  const wav = Buffer.from(await (await svc('GET', body.audioUrl)).arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 48000);
  assert.notEqual(wav.readUInt32LE(4), 0xffffffff, '헤더 길이 값이 채워져 있어야 한다');

  const again = await (await svc('POST', '/api/internal/v1/narrations', { locale: 'ko-KR', segments: SEGMENTS, gapMs: 300 })).json();
  assert.equal(again.cached, true);
  assert.deepEqual(again.segments, body.segments);
  // 토큰 없이 파일을 받을 수 없다
  assert.equal((await svc('GET', body.audioUrl, null, null)).status, 404);
});

test('narrations: 입력 검증', async () => {
  const bad = async (payload, code) => {
    const res = await svc('POST', '/api/internal/v1/narrations', { locale: 'ko-KR', ...payload });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, code);
  };
  await bad({ segments: [] }, 'EMPTY_TEXT');
  await bad({ segments: [{ id: 's1', text: '가' }, { id: 's1', text: '나' }] }, 'BAD_SEGMENT_ID');
  await bad({ segments: [{ id: '../x', text: '가' }] }, 'BAD_SEGMENT_ID');
  await bad({ segments: [{ id: 's1', text: '  ' }] }, 'EMPTY_TEXT');
  await bad({ segments: Array.from({ length: 61 }, (_, i) => ({ id: `s${i}`, text: '가' })) }, 'TOO_MANY_SEGMENTS');
  await bad({ segments: SEGMENTS, gapMs: 5000 }, 'BAD_GAP');
});

test('narrations: 목소리 모델을 고르면 RVC를 한 번만 돌린다', async () => {
  const admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  const pth = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]);
  const up = await fetch(`${app.origin}/api/admin/voice-models?name=${encodeURIComponent('루디')}&defaultPitch=-3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: pth,
  });
  assert.equal(up.status, 201, await up.clone().text());
  const modelId = (await up.json()).id;
  const before = (await readFile(path.join(rvcRoot, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const res = await svc('POST', '/api/internal/v1/narrations', { locale: 'ko-KR', segments: SEGMENTS.slice(0, 2), voiceModelId: modelId });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.voiceModel.id, modelId);
  assert.equal(body.voiceModel.pitch, -3);
  const calls = (await readFile(path.join(rvcRoot, 'calls.log'), 'utf8')).split('\n').filter(Boolean);
  assert.equal(calls.length - before, 1, 'RVC 호출은 문장 수와 상관없이 1회');
  assert.match(calls.at(-1), /--pitch -3/);
});

test('narrations: 서비스 계정 일일 한도', async () => {
  const long = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, text: `한도 확인용 문장 ${i}번입니다 하나 둘 셋` }));
  const res = await svc('POST', '/api/internal/v1/narrations', { locale: 'ko-KR', segments: long });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'QUOTA_EXCEEDED');
});
