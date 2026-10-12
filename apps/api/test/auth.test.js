import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN } from './helpers.js';

let app, admin;
before(async () => {
  app = await startApp();
  admin = app.client();
  assert.equal((await admin.login(ADMIN.username, ADMIN.password)).status, 200);
});
after(() => app.close());

const signup = (c, over = {}) =>
  c.json('POST', '/api/auth/signup', {
    username: 'newuser', password: 'Passw0rd!', name: '김철수', signupNote: '팀 업무용', agreeTerms: true, agreePrivacy: true, ...over,
  });
const findUser = async (username) => (await admin.json('GET', `/api/admin/users?q=${encodeURIComponent(username)}`)).body.items[0];

test('.env 관리자 계정 자동 생성', async () => {
  const { body } = await admin.json('GET', '/api/auth/me');
  assert.equal(body.user.role, 'admin');
  assert.equal(body.usage.dailyLimit, null);
});

test('가입 검증', async () => {
  const c = app.client();
  assert.equal((await signup(c, { username: 'a@b.com' })).status, 400); // 이메일 형태 아이디는 새로 만들 수 없다
  assert.equal((await signup(c, { username: 'ab' })).status, 400);
  assert.equal((await signup(c, { username: 'a'.repeat(33) })).status, 400);
  assert.equal((await signup(c, { password: 'short1' })).status, 400);
  assert.equal((await signup(c, { name: '  ' })).status, 400);
  assert.equal((await signup(c, { agreePrivacy: false })).status, 400);
});

test('가입 → 알림 메일 → 승인 대기 로그인 차단 → 승인 → 로그인', async () => {
  const c = app.client();
  const r = await signup(c, { username: 'Flowuser' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending');
  assert.equal(c.cookies.size, 0); // 승인 전에는 세션 없음

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.mails.at(-1), { username: 'flowuser', name: '김철수', note: '팀 업무용', createdAt: app.mails.at(-1).createdAt });

  assert.equal((await signup(app.client(), { username: 'flowuser' })).status, 409);

  const pending = await c.login('flowuser', 'Passw0rd!');
  assert.equal(pending.status, 403);
  assert.equal(pending.body.error.code, 'ACCOUNT_PENDING');

  const u = await findUser('flowuser');
  assert.equal(u.status, 'pending');
  assert.equal(u.signupNote, '팀 업무용');
  assert.equal((await admin.json('POST', `/api/admin/users/${u.id}/approve`, {})).body.user.status, 'approved');

  const ok = await c.login('FLOWuser', 'Passw0rd!');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'flowuser');
  assert.match(ok.res.headers.get('set-cookie'), /tts_sid=.*HttpOnly.*SameSite=Strict/i);
  assert.equal((await c.json('GET', '/api/voices')).status, 200);
});

test('거절 사유 표시, 정지 시 즉시 로그아웃, 해제', async () => {
  const c = app.client();
  await signup(c, { username: 'rejuser' });
  const u = await findUser('rejuser');
  await admin.json('POST', `/api/admin/users/${u.id}/reject`, { reason: '용도 불명확' });
  const rejected = await c.login('rejuser', 'Passw0rd!');
  assert.equal(rejected.body.error.code, 'ACCOUNT_REJECTED');
  assert.equal(rejected.body.error.reason, '용도 불명확');

  await admin.json('POST', `/api/admin/users/${u.id}/approve`, {}); // 거절 → 재승인 가능
  await c.login('rejuser', 'Passw0rd!');
  assert.equal((await c.json('GET', '/api/auth/me')).status, 200);

  await admin.json('POST', `/api/admin/users/${u.id}/suspend`, {});
  assert.equal((await c.json('GET', '/api/auth/me')).status, 401);
  assert.equal((await c.login('rejuser', 'Passw0rd!')).body.error.code, 'ACCOUNT_SUSPENDED');

  await admin.json('POST', `/api/admin/users/${u.id}/unsuspend`, {});
  assert.equal((await c.login('rejuser', 'Passw0rd!')).status, 200);
});

test('관리자 보호 규칙', async () => {
  const me = (await admin.json('GET', '/api/auth/me')).body.user;
  assert.equal((await admin.json('POST', `/api/admin/users/${me.id}/suspend`, {})).status, 409);
  assert.equal((await admin.json('POST', `/api/admin/users/${me.id}/temp-password`, {})).status, 409);
  assert.equal((await admin.json('POST', '/api/admin/users/99999/approve', {})).status, 404);
});

test('일반 회원은 관리자 API 접근 불가', async () => {
  const c = app.client();
  await signup(c, { username: 'plainuser' });
  await admin.json('POST', `/api/admin/users/${(await findUser('plainuser')).id}/approve`, {});
  await c.login('plainuser', 'Passw0rd!');
  assert.equal((await c.json('GET', '/api/admin/users')).status, 403);
  assert.equal((await app.client().json('GET', '/api/admin/users')).status, 401);
});

test('일괄 승인', async () => {
  for (const e of ['b1user', 'b2user']) await signup(app.client(), { username: e });
  const ids = [(await findUser('b1user')).id, (await findUser('b2user')).id];
  assert.equal((await admin.json('POST', '/api/admin/users/bulk-approve', { userIds: ids })).body.approved, 2);
  assert.equal((await findUser('b2user')).status, 'approved');
});

test('비밀번호 변경: 현재 비밀번호 확인, 다른 기기 세션 종료', async () => {
  await signup(app.client(), { username: 'pwuser' });
  await admin.json('POST', `/api/admin/users/${(await findUser('pwuser')).id}/approve`, {});
  const a = app.client();
  const b = app.client();
  await a.login('pwuser', 'Passw0rd!');
  await b.login('pwuser', 'Passw0rd!');

  assert.equal((await a.json('PATCH', '/api/auth/password', { currentPassword: 'wrong', newPassword: 'NewPass123' })).status, 400);
  assert.equal((await a.json('PATCH', '/api/auth/password', { currentPassword: 'Passw0rd!', newPassword: 'weak' })).status, 400);
  assert.equal((await a.json('PATCH', '/api/auth/password', { currentPassword: 'Passw0rd!', newPassword: 'NewPass123' })).status, 200);
  assert.equal((await a.json('GET', '/api/auth/me')).status, 200);
  assert.equal((await b.json('GET', '/api/auth/me')).status, 401);
  assert.equal((await app.client().login('pwuser', 'NewPass123')).status, 200);
});

test('임시 비밀번호 발급', async () => {
  await signup(app.client(), { username: 'tmpuser' });
  const u = await findUser('tmpuser');
  await admin.json('POST', `/api/admin/users/${u.id}/approve`, {});
  const { body } = await admin.json('POST', `/api/admin/users/${u.id}/temp-password`, {});
  assert.match(body.tempPassword, /^[A-Za-z0-9]{12}$/);
  assert.equal((await app.client().login('tmpuser', 'Passw0rd!')).status, 401);
  assert.equal((await app.client().login('tmpuser', body.tempPassword)).status, 200);
});

test('로그인 5회 실패 시 잠금 (이메일·IP 기준)', async () => {
  app.loginGuard.fails.clear(); // 앞선 테스트의 같은 IP 실패 기록 제거
  const c = app.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.login('lockuser', 'bad')).status, 401);
  const locked = await c.login('lockuser', 'bad');
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'LOGIN_LOCKED');
  // 같은 IP에서는 다른 계정도 잠김 (무차별 대입 방지)
  assert.equal((await c.login(ADMIN.username, ADMIN.password)).status, 429);
  app.loginGuard.fails.clear();
});

test('로그아웃', async () => {
  const c = app.client();
  await c.login(ADMIN.username, ADMIN.password);
  await c.post('/api/auth/logout');
  assert.equal((await c.json('GET', '/api/auth/me')).status, 401);
});

test('관리자 통계·생성 내역·감사 로그', async () => {
  const stats = (await admin.json('GET', '/api/admin/stats')).body;
  assert.ok(stats.users.total >= 2);
  assert.equal(typeof stats.today.globalLimit, 'number');

  const audit = (await admin.json('GET', '/api/admin/audit?action=admin.user.')).body.items;
  assert.ok(audit.some((a) => a.action === 'admin.user.reject' && a.detail.reason === '용도 불명확'));
  assert.ok(audit.every((a) => a.action.startsWith('admin.user.')));

  const detail = (await admin.json('GET', `/api/admin/users/${(await findUser('flowuser')).id}`)).body;
  assert.ok(detail.logins.some((l) => l.action === 'login.success'));
  assert.equal((await admin.json('GET', '/api/admin/generations')).status, 200);
});

test('가입 요청 IP별 시간당 제한', async () => {
  const limited = await startApp({ SIGNUP_LIMIT_PER_HOUR: '2' });
  try {
    for (const e of ['r1user', 'r2user']) assert.equal((await signup(limited.client(), { username: e })).status, 201);
    assert.equal((await signup(limited.client(), { username: 'r3user' })).status, 429);
  } finally {
    await limited.close();
  }
});
