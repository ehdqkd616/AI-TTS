import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

export const quiet = { log() {}, warn() {}, error() {} };
export const ADMIN = { username: 'admin', password: 'AdminPass123' };

/** 테스트용 앱 서버 + 메일 기록 */
export async function startApp(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tts-test-'));
  const mails = [];
  const mailer = { sendSignupNotification: async (u) => (mails.push(u), 'SENT') };
  const ctx = await createApp({
    env: { TTS_MOCK: 'true', ADMIN_PASSWORD: ADMIN.password, RATE_LIMIT_PER_MIN: '1000', SIGNUP_LIMIT_PER_HOUR: '1000', ...env },
    storageDir: dir,
    logger: quiet,
    mailer,
  });
  const server = ctx.app.listen(0);
  const origin = `http://localhost:${server.address().port}`;
  return {
    ...ctx,
    origin,
    mails,
    client: () => new Client(origin),
    async close() {
      server.close();
      ctx.store.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 쿠키를 유지하는 브라우저 흉내 */
export class Client {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
  }

  async req(method, p, body, headers = {}) {
    const res = await fetch(this.origin + p, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v) this.cookies.set(k, v);
      else this.cookies.delete(k);
    }
    return res;
  }

  get(p) {
    return this.req('GET', p);
  }

  post(p, body = {}) {
    return this.req('POST', p, body);
  }

  async json(method, p, body) {
    const res = await this.req(method, p, body);
    return { status: res.status, body: await res.json().catch(() => null), res };
  }

  login(username, password) {
    return this.json('POST', '/api/auth/login', { username, password });
  }
}

/** 가입 → 관리자 승인 → 로그인까지 마친 회원 클라이언트 */
export async function approvedUser(app, admin, username = 'user1', password = 'UserPass123') {
  const c = app.client();
  await c.json('POST', '/api/auth/signup', { username, password, name: '홍길동', agreeTerms: true, agreePrivacy: true });
  const { body } = await admin.json('GET', `/api/admin/users?q=${encodeURIComponent(username)}`);
  await admin.json('POST', `/api/admin/users/${body.items[0].id}/approve`, {});
  await c.login(username, password);
  return c;
}
