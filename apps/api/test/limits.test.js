import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, approvedUser, ADMIN } from './helpers.js';

test('요청 제한·회원별 일일 한도·관리자 한도 조정·동시 작업 제한', async () => {
  const app = await startApp({ RATE_LIMIT_PER_MIN: '4', DAILY_CHAR_LIMIT_PER_USER: '30', DAILY_CHAR_LIMIT_GLOBAL: '1000' });
  try {
    const admin = app.client();
    await admin.login(ADMIN.username, ADMIN.password);
    const user = await approvedUser(app, admin);
    const send = (text) => user.req('POST', '/api/tts', { text, locale: 'en-US' });

    assert.equal((await send('Twenty chars of text')).status, 200); // 20자 사용
    const over = await send('Fifteen chars..'); // 20 + 15 > 30
    assert.equal(over.status, 429);
    assert.equal((await over.json()).error.code, 'QUOTA_EXCEEDED');
    assert.equal((await send('Twenty chars of text')).status, 200); // 캐시 적중은 엔진 비용이 없어 한도와 무관

    const me = (await user.json('GET', '/api/auth/me')).body;
    assert.deepEqual(me.usage, { usedToday: 20, dailyLimit: 30 });

    // 관리자가 한도를 늘리면 바로 반영
    const { body } = await admin.json('GET', '/api/admin/users?q=user1');
    await admin.json('PATCH', `/api/admin/users/${body.items[0].id}/quota`, { dailyCharLimit: 100 });
    assert.equal((await send('Fifteen chars..')).status, 200);

    const limited = await send('x');
    assert.equal(limited.status, 429); // 분당 4회 초과
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(app.store.getUsage('global'), 35);

    app.limits.jobs.active = app.limits.jobs.max; // 동시 작업이 꽉 찬 상태
    app.limits.synth.hits.clear();
    assert.equal((await send('busy')).status, 503);
  } finally {
    await app.close();
  }
});
