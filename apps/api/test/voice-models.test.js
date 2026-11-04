import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, approvedUser, ADMIN } from './helpers.js';

// 실제 RVC 대신: infer/cli.py 자리에 아무 파일, .venv/bin/python 자리에 인자를 기록하고 입력을 그대로 복사하는 스크립트
let rvcRoot;
let app;
let admin;
let user;

async function makeFakeRvc() {
  const root = await mkdtemp(path.join(tmpdir(), 'fake-rvc-'));
  await mkdir(path.join(root, 'infer'), { recursive: true });
  await mkdir(path.join(root, '.venv', 'bin'), { recursive: true });
  await writeFile(path.join(root, 'infer', 'cli.py'), '# fake');
  const py = path.join(root, '.venv', 'bin', 'python');
  await writeFile(
    py,
    `#!/bin/sh
echo "$@" >> "${root}/calls.log"
if [ -f "${root}/FAIL" ]; then echo "rvc-cli: error: boom" >&2; exit 1; fi
in=""; out=""; model=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift ;;
    # 실제 cli.py와 같이 .pth가 아니면 거절한다 (임시 파일 이름까지 확장자를 지켜야 한다)
    --list-speakers)
      case "$model" in
        *.pth) echo "0-0"; exit 0 ;;
        *) echo "rvc-cli: error: Model must be a .pth file: $model" >&2; exit 1 ;;
      esac ;;
    --input) in="$2"; shift ;;
    --output) out="$2"; shift ;;
  esac
  shift
done
cp "$in" "$out"
`,
  );
  await chmod(py, 0o755);
  return root;
}

const pth = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]);

/** 쿠키를 붙여 파일 본문을 그대로 보낸다 */
async function upload(client, method, p, body, contentType = 'application/octet-stream') {
  const res = await fetch(client.origin + p, {
    method,
    headers: {
      'Content-Type': contentType,
      Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const calls = async () => (await readFile(path.join(rvcRoot, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

before(async () => {
  rvcRoot = await makeFakeRvc();
  app = await startApp({ RVC_ROOT: rvcRoot, VOICE_MODEL_MAX_MB: '1' });
  admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  user = await approvedUser(app, admin);
});
after(async () => {
  await app.close();
  await rm(rvcRoot, { recursive: true, force: true });
});

test('관리자만 목소리 모델을 올릴 수 있다', async () => {
  const r = await upload(user, 'POST', '/api/admin/voice-models?name=x', pth());
  assert.equal(r.status, 403);
  assert.equal((await upload(app.client(), 'POST', '/api/admin/voice-models?name=x', pth())).status, 401);
});

test('.pth가 아닌 파일·너무 큰 파일·이름 없음은 거절하고 찌꺼기를 남기지 않는다', async () => {
  assert.equal((await upload(admin, 'POST', '/api/admin/voice-models?name=x', Buffer.from('not a model'))).body.error.code, 'BAD_MODEL_FILE');
  assert.equal((await upload(admin, 'POST', '/api/admin/voice-models?name=x', Buffer.alloc(2 * 1024 * 1024))).status, 413);
  assert.equal((await upload(admin, 'POST', '/api/admin/voice-models', pth())).body.error.code, 'BAD_NAME');
  assert.equal((await upload(admin, 'POST', '/api/admin/voice-models?name=x', pth(), 'text/plain')).status, 415);
  assert.equal((await admin.json('GET', '/api/admin/voice-models')).body.items.length, 0);
});

test('업로드 → 회원이 골라서 변환 → 캐시 → 피치·index 반영 → 끄기·삭제', async () => {
  const created = await upload(admin, 'POST', '/api/admin/voice-models?name=' + encodeURIComponent('루디 목소리') + '&defaultPitch=-5', pth());
  assert.equal(created.status, 201);
  const model = created.body;
  assert.equal(model.name, '루디 목소리');
  assert.equal(model.defaultPitch, -5);
  assert.equal(model.hasIndex, false);
  assert.match((await calls()).at(-1), /--list-speakers/); // 업로드 직후 RVC로 열어 보는 검사

  // 회원 화면 목록에는 파일 정보 없이 보인다
  const list = await user.json('GET', '/api/voice-models');
  assert.deepEqual(list.body.items, [{ id: model.id, name: '루디 목소리', defaultPitch: -5, hasIndex: false }]);
  assert.equal((await user.json('GET', '/api/config')).body.rvcEnabled, true);

  // 피치를 안 주면 모델 기본 피치, index가 없으면 index-rate 0
  const r1 = await user.json('POST', '/api/tts', { text: '안녕하세요', locale: 'ko-KR', voiceModelId: model.id });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.voiceModel, { id: model.id, name: '루디 목소리', pitch: -5 });
  let last = (await calls()).at(-1);
  assert.match(last, /--pitch -5/);
  assert.match(last, /--index-rate 0/);
  const audio = await user.req('GET', r1.body.audioUrl);
  assert.equal(audio.status, 200);
  assert.ok((await audio.arrayBuffer()).byteLength > 100);

  // 같은 요청은 캐시 (RVC를 다시 부르지 않음)
  const before = (await calls()).length;
  const r2 = await user.json('POST', '/api/tts', { text: '안녕하세요', locale: 'ko-KR', voiceModelId: model.id });
  assert.equal(r2.body.cached, true);
  assert.equal((await calls()).length, before);

  // 변환 없이 만든 음성과 캐시가 섞이지 않는다
  const plain = await user.json('POST', '/api/tts', { text: '안녕하세요', locale: 'ko-KR' });
  assert.equal(plain.body.cached, false);
  assert.equal(plain.body.voiceModel, null);
  assert.notEqual(plain.body.audioUrl, r1.body.audioUrl);

  // index 올리면 index를 쓰고, 파일이 바뀌었으니 캐시도 새로
  const idx = await upload(admin, 'PUT', `/api/admin/voice-models/${model.id}/index`, Buffer.alloc(512, 1));
  assert.equal(idx.body.hasIndex, true);
  const r3 = await user.json('POST', '/api/tts', { text: '안녕하세요', locale: 'ko-KR', voiceModelId: model.id, pitch: 3 });
  assert.equal(r3.body.cached, false);
  last = (await calls()).at(-1);
  assert.match(last, /--pitch 3/);
  assert.match(last, /--index \S+model\.index --index-rate 0\.75/);

  // 잘못된 피치
  assert.equal((await user.json('POST', '/api/tts', { text: '하나', locale: 'ko-KR', voiceModelId: model.id, pitch: 99 })).body.error.code, 'BAD_PITCH');

  // 이력에 모델 이름이 남는다
  const hist = await user.json('GET', '/api/history');
  assert.equal(hist.body.items.find((h) => h.id === r3.body.id).voiceModel.name, '루디 목소리');

  // 끄면 회원 목록에서 사라지고 쓸 수 없다
  await admin.json('PATCH', `/api/admin/voice-models/${model.id}`, { enabled: false });
  assert.equal((await user.json('GET', '/api/voice-models')).body.items.length, 0);
  assert.equal((await user.json('POST', '/api/tts', { text: '둘', locale: 'ko-KR', voiceModelId: model.id })).body.error.code, 'MODEL_DISABLED');

  // 삭제하면 파일까지 지운다
  const dir = app.voiceModels.modelDir(model.id);
  assert.ok(existsSync(dir));
  assert.equal((await admin.json('DELETE', `/api/admin/voice-models/${model.id}`, {})).status, 200);
  assert.ok(!existsSync(dir));
  assert.equal((await user.json('POST', '/api/tts', { text: '셋', locale: 'ko-KR', voiceModelId: model.id })).status, 404);

  const audit = await admin.json('GET', '/api/admin/audit?limit=100');
  const actions = audit.body.items.map((a) => a.action);
  for (const a of ['create', 'index', 'update', 'delete']) assert.ok(actions.includes(`admin.voice_model.${a}`), a);
});

test('RVC가 실패하면 다른 TTS 보이스로 넘어가지 않고 실패로 남긴다', async () => {
  const created = await upload(admin, 'POST', '/api/admin/voice-models?name=fail', pth());
  await writeFile(path.join(rvcRoot, 'FAIL'), '');
  try {
    const r = await user.json('POST', '/api/tts', { text: '실패 테스트', locale: 'ko-KR', voiceModelId: created.body.id });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'RVC_FAILED');
    const hist = await user.json('GET', '/api/history');
    assert.equal(hist.body.items[0].status, 'failed');
  } finally {
    await rm(path.join(rvcRoot, 'FAIL'));
  }
});

test('RVC가 설정되지 않으면 업로드·변환 모두 503', async () => {
  const off = await startApp();
  try {
    const a = off.client();
    await a.login(ADMIN.username, ADMIN.password);
    assert.equal((await upload(a, 'POST', '/api/admin/voice-models?name=x', pth())).body.error.code, 'RVC_DISABLED');
    assert.equal((await a.json('GET', '/api/voice-models')).body.rvcEnabled, false);
  } finally {
    await off.close();
  }
});

test('서비스 전용 모델: 회원에게는 없는 것처럼, 그 서비스만 쓸 수 있다', async () => {
  const SHORTS = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const scoped = await startApp({ RVC_ROOT: rvcRoot, INTERNAL_API_TOKENS: `shorts:${SHORTS}, other:${OTHER}` });
  const svc = (method, p, body, token = SHORTS) =>
    fetch(scoped.origin + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Internal-Token': token },
      body: body ? JSON.stringify(body) : undefined,
    });
  const ids = (list) => list.map((v) => v.id).sort();
  try {
    const a = scoped.client();
    await a.login(ADMIN.username, ADMIN.password);
    const member = await approvedUser(scoped, a);

    // 관리자 화면은 전용으로 둘 수 있는 서비스 목록을 받는다 (토큰은 내보내지 않는다)
    assert.deepEqual((await a.json('GET', '/api/admin/voice-models')).body.services, ['shorts', 'other']);

    const mine = (await upload(a, 'POST', '/api/admin/voice-models?name=내목소리&ownerService=shorts', pth())).body;
    assert.equal(mine.ownerService, 'shorts');
    const shared = (await upload(a, 'POST', '/api/admin/voice-models?name=공용', pth())).body;
    assert.equal(shared.ownerService, null);
    assert.equal((await upload(a, 'POST', '/api/admin/voice-models?name=x&ownerService=BAD%20NAME', pth())).body.error.code, 'BAD_OWNER_SERVICE');

    // 관리자 목록에는 둘 다, 회원 목록에는 공용만
    assert.deepEqual(ids((await a.json('GET', '/api/admin/voice-models')).body.items), ids([mine, shared]));
    assert.deepEqual(ids((await member.json('GET', '/api/voice-models')).body.items), [shared.id]);

    // 회원이 id를 직접 넣어도 '사용 중지'가 아니라 404 — 존재 자체를 알리지 않는다
    const blocked = await member.json('POST', '/api/tts', { text: '하나', locale: 'ko-KR', voiceModelId: mine.id });
    assert.equal(blocked.status, 404);
    assert.equal(blocked.body.error.code, 'NOT_FOUND');

    // shorts: 전용 + 공용 둘 다 보이고 쓸 수 있다
    assert.deepEqual(ids((await (await svc('GET', '/api/internal/v1/catalog')).json()).voiceModels), ids([mine, shared]));
    const nar = await svc('POST', '/api/internal/v1/narrations', { segments: [{ id: 's1', text: '안녕하세요' }], locale: 'ko-KR', voiceModelId: mine.id });
    assert.equal(nar.status, 200, await nar.clone().text());
    assert.equal((await nar.json()).voiceModel.id, mine.id);

    // 다른 서비스: 공용만 — 전용 모델은 404
    assert.deepEqual(ids((await (await svc('GET', '/api/internal/v1/catalog', null, OTHER)).json()).voiceModels), [shared.id]);
    assert.equal((await svc('POST', '/api/internal/v1/narrations', { segments: [{ id: 's1', text: '둘' }], locale: 'ko-KR', voiceModelId: mine.id }, OTHER)).status, 404);

    // 공개 범위를 바꾸면 회원 목록에서 사라진다
    assert.equal((await a.json('PATCH', `/api/admin/voice-models/${shared.id}`, { ownerService: 'shorts' })).body.ownerService, 'shorts');
    assert.deepEqual((await member.json('GET', '/api/voice-models')).body.items, []);
    assert.equal((await a.json('PATCH', `/api/admin/voice-models/${mine.id}`, { ownerService: '' })).body.ownerService, null);
    assert.deepEqual(ids((await member.json('GET', '/api/voice-models')).body.items), [mine.id]);
  } finally {
    await scoped.close();
  }
});
