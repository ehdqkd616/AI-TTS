import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignupMail, createMailer, formatKst } from '../src/services/mailer.js';

test('KST 표기', () => {
  assert.equal(formatKst(Date.UTC(2026, 9, 5, 5, 3, 22)), '2026년 10월 5일 14시 03분 22초');
});

test('가입 알림 메일: 승인 링크 + HTML 이스케이프', () => {
  const m = buildSignupMail({ username: 'kim1234', name: '<script>x</script>', note: 'memo', createdAt: 0 }, 'https://ai-tts.example/');
  assert.match(m.html, /https:\/\/ai-tts\.example\/admin\?tab=users/);
  assert.ok(!m.html.includes('<script>x'));
  assert.match(m.text, /가입 메모: memo/);
  assert.match(m.subject, /승인해 주세요/);
});

test('SMTP 미설정이면 건너뜀', async () => {
  const mailer = createMailer({}, { warn() {} });
  assert.equal(await mailer.sendSignupNotification({ username: 'kim1234', name: 'n', createdAt: 0 }), 'SKIPPED');
});
