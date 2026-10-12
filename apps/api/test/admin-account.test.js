import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, ADMIN, quiet } from './helpers.js';
import { ensureAdmin, hashPassword } from '../src/services/auth.js';

let app;
before(async () => {
  app = await startApp();
});
after(() => app.close());

test('관리자 비밀번호는 .env가 기준 — 화면에서 바꿀 수 없고, 기동할 때 .env 값으로 맞춘다', async () => {
  const admin = app.client();
  assert.equal((await admin.login('admin', ADMIN.password)).status, 200);
  assert.equal((await admin.json('GET', '/api/auth/me')).body.passwordManaged, true);
  const change = await admin.json('PATCH', '/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'Other1234' });
  assert.equal(change.status, 409);

  await ensureAdmin(app.store, { ADMIN_PASSWORD: 'Changed123' }, quiet);
  assert.equal((await app.client().login('admin', 'Changed123')).status, 200);
  assert.equal((await app.client().login('admin', ADMIN.password)).status, 401);
  assert.equal((await admin.json('GET', '/api/auth/me')).status, 401); // 예전 비밀번호로 만든 세션은 종료
});

test('이메일로 가입했던 기존 회원은 그 이메일을 아이디로 로그인한다', async () => {
  const now = Date.now();
  app.store.run(
    `INSERT INTO users (username, name, pw_hash, status, created_at) VALUES ('old@example.com', '기존 회원', ?, 'approved', ?)`,
    await hashPassword('OldPass123'), now,
  );
  const r = await app.client().login('Old@Example.com', 'OldPass123');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'old@example.com');
});
