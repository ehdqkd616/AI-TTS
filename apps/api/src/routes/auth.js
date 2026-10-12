import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import {
  hashPassword, verifyPassword, passwordProblem, usernameProblem, publicUser, requireUser, STATUS_ERRORS,
} from '../services/auth.js';

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (message, code = 'VALIDATION_ERROR') => new HttpError(400, message, code);

export function authRouter({ store, sessions, loginGuard, limits, mailer, logger, adminUsername }) {
  const router = Router();
  const rate = (limiter) => (req, res, next) => {
    limiter.check(req.ip);
    next();
  };

  router.post('/signup', rate(limits.signup), async (req, res) => {
    const username = str(req.body?.username, 254).toLowerCase();
    const name = str(req.body?.name, 50);
    const note = str(req.body?.signupNote, 1000) || null;
    const password = req.body?.password;
    const idProblem = usernameProblem(username);
    if (idProblem) throw bad(idProblem);
    if (!name) throw bad('이름을 입력하세요.');
    const pwProblem = passwordProblem(password);
    if (pwProblem) throw bad(pwProblem);
    if (!req.body?.agreeTerms || !req.body?.agreePrivacy) throw bad('이용약관과 개인정보 처리방침에 동의해 주세요.');
    if (store.get('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, '이미 사용 중인 아이디입니다.', 'USERNAME_TAKEN');

    const now = Date.now();
    const pwHash = await hashPassword(password);
    const { lastInsertRowid: id } = store.run(
      `INSERT INTO users (username, name, pw_hash, signup_note, created_at) VALUES (?, ?, ?, ?, ?)`,
      username, name, pwHash, note, now,
    );
    store.audit('user.signup', { actorId: Number(id), targetType: 'user', targetId: id, ip: req.ip });
    // 관리자 승인 전에는 로그인할 수 없으므로 세션을 만들지 않는다.
    // 알림 메일은 응답과 분리해서 보낸다 — SMTP가 느리거나 실패해도 가입은 그대로 성공.
    void mailer.sendSignupNotification({ username, name, note, createdAt: now }).catch((err) => logger.error?.(err));
    res.status(201).json({ status: 'pending', message: '가입 신청이 완료되었습니다. 관리자 승인 후 이용할 수 있습니다.' });
  });

  router.post('/login', rate(limits.login), async (req, res) => {
    // 아이디 형식은 검사하지 않는다 — 예전 가입자는 이메일 형태 아이디를 그대로 쓴다
    const username = str(req.body?.username, 254).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 128) : '';
    loginGuard.assertNotLocked(username, req.ip);

    const user = store.get('SELECT * FROM users WHERE username = ?', username);
    if (!(await verifyPassword(password, user?.pw_hash))) {
      loginGuard.recordFailure(username, req.ip);
      store.audit('login.failure', { actorId: user?.id, targetType: 'user', targetId: user?.id, detail: { username }, ip: req.ip });
      throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.', 'INVALID_CREDENTIALS');
    }
    loginGuard.clear(username);

    // 비밀번호가 맞을 때만 계정 상태를 알려준다
    if (user.status !== 'approved') {
      const [code, message] = STATUS_ERRORS[user.status];
      store.audit('login.blocked', { actorId: user.id, targetType: 'user', targetId: user.id, detail: { status: user.status }, ip: req.ip });
      const err = new HttpError(403, message, code);
      if (user.status === 'rejected' && user.reject_reason) err.reason = user.reject_reason;
      throw err;
    }

    sessions.create(req, res, user.id);
    const now = Date.now();
    store.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
    store.audit('login.success', { actorId: user.id, targetType: 'user', targetId: user.id, ip: req.ip });
    res.json({ user: publicUser({ ...user, last_login_at: now }) });
  });

  router.post('/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  router.get('/me', requireUser, (req, res) => {
    res.json({ user: publicUser(req.user), passwordManaged: req.user.username === adminUsername, usage: limits.quota.usageOf(req.user) });
  });

  router.patch('/password', requireUser, async (req, res) => {
    if (req.user.username === adminUsername) {
      throw new HttpError(409, '관리자 비밀번호는 서버 .env의 ADMIN_PASSWORD로 관리합니다.', 'ADMIN_PASSWORD_MANAGED');
    }
    const { currentPassword, newPassword } = req.body ?? {};
    if (!(await verifyPassword(String(currentPassword ?? '').slice(0, 128), req.user.pw_hash))) {
      throw bad('현재 비밀번호가 올바르지 않습니다.', 'INVALID_CREDENTIALS');
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw bad(problem);
    store.run('UPDATE users SET pw_hash = ? WHERE id = ?', await hashPassword(newPassword), req.user.id);
    sessions.revokeUser(req.user.id, req); // 다른 기기의 세션은 종료
    store.audit('user.password_change', { actorId: req.user.id, targetType: 'user', targetId: req.user.id, ip: req.ip });
    res.json({ ok: true });
  });

  return router;
}
