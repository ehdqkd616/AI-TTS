import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, approvedUser, ADMIN } from './helpers.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import { ProviderError } from '../src/lib/errors.js';

/** 실제 Google을 부르지 않고 테스트 톤을 돌려주는 가짜 Google 엔진 */
class FakeGoogle extends MockProvider {
  name = 'google';
  maxChars = 1500;
  calls = 0;
  failTimes = 0;
  constructor() {
    super({ TTS_MOCK: 'true' });
  }
  async synthesize(text) {
    this.calls++;
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new ProviderError('google', 'HTTP 503', { status: 503, retryable: true });
    }
    return super.synthesize(text);
  }
}

async function setup(env) {
  const app = await startApp({ GOOGLE_TTS_API_KEY: 'test', ...env });
  const google = new FakeGoogle();
  app.providers.set('google', google);
  const admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  const user = await approvedUser(app, admin);
  const send = (text, locale = 'en-US') => user.json('POST', '/api/tts', { text, locale });
  return { app, google, admin, user, send };
}

test('① 일일 한도: 넘으면 무료 엔진으로 넘어가고, 대체가 없으면 429', async () => {
  const { app, google, admin, send } = await setup({ PAID_ENGINE_DAILY_CHAR_LIMIT: '25' });
  try {
    assert.equal((await send('Twenty chars of text')).body.voice.provider, 'google'); // 20자
    assert.equal(app.paidGuard.usage('google').today, 20);

    const second = (await send('Another ten.')).body; // 20 + 12 > 25
    assert.notEqual(second.voice.provider, 'google');
    assert.equal(google.calls, 1);
    assert.equal(app.paidGuard.usage('google').today, 20); // 무료 엔진 사용분은 Google에 안 잡힘

    app.providers.delete('mock'); // en-AU는 Chirp 3 HD 말고 대체가 없음
    const au = await send('G day mate, how are you?', 'en-AU');
    assert.equal(au.status, 429);
    assert.equal(au.body.error.code, 'ENGINE_QUOTA');

    const status = (await admin.json('GET', '/api/admin/paid-engines')).body;
    assert.deepEqual(status.engines.google, { today: 20, month: 20 });
    assert.equal(status.dailyLimit, 25);
  } finally {
    await app.close();
  }
});

test('② 월간 한도: 지난 날짜 사용분까지 합쳐 이번 달 한도를 넘으면 멈춤', async () => {
  const { app, google, send } = await setup({ PAID_ENGINE_MONTHLY_CHAR_LIMIT: '100' });
  try {
    // 같은 달의 다른 날짜에 이미 90자를 썼다고 가정 (이번 달 1일, 오늘과 다른 날)
    const firstOfMonth = app.store.get(`SELECT date('now', 'localtime', 'start of month') d`).d;
    const otherDay = firstOfMonth === app.store.get(`SELECT date('now', 'localtime') d`).d
      ? app.store.get(`SELECT date('now', 'localtime', 'start of month', '+1 day') d`).d
      : firstOfMonth;
    app.store.run(`INSERT INTO usage_daily (subject, usage_date, chars_used) VALUES ('engine:google', ?, 90)`, otherDay);
    // 지난달 사용분은 이번 달에 안 들어감
    app.store.run(`INSERT INTO usage_daily (subject, usage_date, chars_used) VALUES ('engine:google', date('now', 'localtime', 'start of month', '-1 day'), 99999)`);

    assert.equal(app.paidGuard.usage('google').month, 90);
    const r = (await send('Twenty chars of text')).body; // 90 + 20 > 100
    assert.notEqual(r.voice.provider, 'google');
    assert.equal(google.calls, 0);
  } finally {
    await app.close();
  }
});

test('③ 재시도도 매번 계측 (보내기 전에 먼저 차감)', async () => {
  const { app, google, send } = await setup({});
  try {
    google.failTimes = 2; // 두 번 실패 후 성공 → 3번 보냄
    const r = (await send('Twenty chars of text')).body;
    assert.equal(r.voice.provider, 'google');
    assert.equal(google.calls, 3);
    assert.equal(app.paidGuard.usage('google').today, 60); // 20자 × 3회
  } finally {
    await app.close();
  }
});

test('④ 긴급 차단 스위치: 즉시 상용 엔진 중지, 재시작해도 유지, 감사 로그', async () => {
  const { app, google, admin, user, send } = await setup({});
  try {
    assert.equal((await user.json('POST', '/api/admin/paid-engines/disabled', { disabled: true })).status, 403); // 일반 회원 불가
    const off = (await admin.json('POST', '/api/admin/paid-engines/disabled', { disabled: true })).body;
    assert.equal(off.disabled, true);

    const r = (await send('Twenty chars of text')).body;
    assert.notEqual(r.voice.provider, 'google');
    assert.equal(google.calls, 0);
    assert.equal(app.store.getSetting('paid_engines_disabled'), '1'); // DB에 저장 → 재시작해도 유지

    const audit = (await admin.json('GET', '/api/admin/audit?action=admin.paid_engines')).body.items;
    assert.equal(audit[0].action, 'admin.paid_engines.disable');

    await admin.json('POST', '/api/admin/paid-engines/disabled', { disabled: false });
    assert.equal((await send('Back on now, twenty.')).body.voice.provider, 'google');
  } finally {
    await app.close();
  }
});

test('⑤ 경고 메일: 월 50%·80%, 한도 도달 시 한 번씩만', async () => {
  const { app, send } = await setup({ PAID_ENGINE_MONTHLY_CHAR_LIMIT: '100', PAID_ENGINE_DAILY_CHAR_LIMIT: '1000' });
  const alerts = [];
  app.paidGuard.mailer = { sendAdminAlert: async (subject) => (alerts.push(subject), 'SENT') };
  try {
    await send('x'.repeat(55)); // 55% → 50% 알림
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /google 이번 달 사용량 55%/);
    await send('y'.repeat(5)); // 60% → 새 알림 없음
    assert.equal(alerts.length, 1);
    await send('z'.repeat(22)); // 82% → 80% 알림
    assert.equal(alerts.length, 2);
    await send('w'.repeat(17)); // 99% → 한도 도달(97% 이상) 알림 — 일 한도도 월 한도(100)로 고정돼 같이 도달
    assert.equal(alerts.length, 4);
    assert.ok(alerts.slice(2).some((a) => /이번 달 사용량 99%/.test(a)));
    assert.ok(alerts.slice(2).some((a) => /오늘 사용량 99%/.test(a)));
    await send('v'.repeat(1)); // 100% — 이미 알린 단계라 추가 메일 없음
    assert.equal(alerts.length, 4);
  } finally {
    await app.close();
  }
});

test('⑥ .env에 한도를 크게 잘못 넣어도 코드 상한(월 95만 자)으로 고정', async () => {
  const { app } = await setup({ PAID_ENGINE_MONTHLY_CHAR_LIMIT: '9000000', PAID_ENGINE_DAILY_CHAR_LIMIT: '5000000' });
  try {
    assert.equal(app.paidGuard.monthly, 950_000);
    assert.equal(app.paidGuard.daily, 950_000); // 일 한도도 월 한도를 넘을 수 없음
  } finally {
    await app.close();
  }
});
