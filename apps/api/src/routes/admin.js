import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { hashPassword, requireAdmin, tempPassword } from '../services/auth.js';
import { USER_STATUSES } from '../services/store.js';

const conflict = (message) => new HttpError(409, message, 'INVALID_STATE');
const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const ACTION = {
  approved: (old) => (old === 'suspended' ? 'unsuspend' : 'approve'),
  rejected: () => 'reject',
  suspended: () => 'suspend',
};

export function adminRouter({ store, sessions, limits, adminUsername }) {
  const router = Router();
  router.use(requireAdmin);

  const userOut = (u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    status: u.status,
    signupNote: u.signup_note,
    rejectReason: u.reject_reason,
    dailyCharLimit: u.daily_char_limit,
    effectiveDailyLimit: limits.quota.limitOf(u),
    usedToday: store.getUsage(`user:${u.id}`),
    generationCount: u.generation_count ?? undefined,
    approvedAt: u.approved_at,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  });

  const getUser = (id) => {
    const u = store.get('SELECT * FROM users WHERE id = ?', Number(id));
    if (!u) throw new HttpError(404, '회원을 찾을 수 없습니다.', 'NOT_FOUND');
    return u;
  };

  function changeStatus(req, user, next, reason = null) {
    if (user.id === req.user.id) throw conflict('자기 자신의 상태는 바꿀 수 없습니다.');
    if (user.role === 'admin' && next !== 'approved') throw conflict('관리자 계정은 거절·정지할 수 없습니다.');
    const now = Date.now();
    store.run(
      `UPDATE users SET status = ?,
         approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
         approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END,
         reject_reason = CASE WHEN ? = 'rejected' THEN ? WHEN ? = 'approved' THEN NULL ELSE reject_reason END
       WHERE id = ?`,
      next, next, req.user.id, next, now, next, reason, next, user.id,
    );
    if (next === 'rejected' || next === 'suspended') sessions.revokeUser(user.id); // 즉시 로그아웃
    store.audit(`admin.user.${ACTION[next](user.status)}`, {
      actorId: req.user.id, targetType: 'user', targetId: user.id,
      detail: { from: user.status, to: next, ...(reason ? { reason } : {}) }, ip: req.ip,
    });
    return getUser(user.id);
  }

  router.get('/stats', (req, res) => {
    const byStatus = Object.fromEntries(store.all('SELECT status, COUNT(*) n FROM users GROUP BY status').map((r) => [r.status, r.n]));
    const today = store.get(
      `SELECT COUNT(*) total, SUM(status = 'failed') failed, SUM(cached) cached
       FROM generations WHERE date(created_at, 'localtime') = date('now', 'localtime')`,
    );
    const week = store.all(
      `SELECT usage_date date, chars_used chars FROM usage_daily
       WHERE subject = 'global' AND usage_date >= date('now', 'localtime', '-6 days') ORDER BY usage_date`,
    );
    const topUsers = store.all(
      `SELECT u.id, u.username, u.name, d.chars_used chars FROM usage_daily d JOIN users u ON d.subject = 'user:' || u.id
       WHERE d.usage_date = date('now', 'localtime') ORDER BY d.chars_used DESC LIMIT 5`,
    );
    res.json({
      users: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, pending: byStatus.pending ?? 0 },
      today: {
        generations: today.total ?? 0,
        failed: today.failed ?? 0,
        cached: today.cached ?? 0,
        chars: store.getUsage('global'),
        globalLimit: limits.quota.global,
      },
      week,
      topUsers,
    });
  });

  router.get('/users', (req, res) => {
    const { status, q } = req.query;
    const where = [];
    const params = [];
    if (status && USER_STATUSES.includes(status)) where.push('u.status = ?'), params.push(status);
    if (q) where.push(`(u.username LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')`), params.push(like(q), like(q));
    const rows = store.all(
      `SELECT u.*, (SELECT COUNT(*) FROM generations g WHERE g.user_id = u.id) generation_count FROM users u
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (u.status = 'pending') DESC, u.id DESC LIMIT ?`,
      ...params, int(req.query.limit, 200),
    );
    res.json({ items: rows.map(userOut) });
  });

  router.get('/users/:id', (req, res) => {
    const u = getUser(req.params.id);
    const generations = store.all(
      `SELECT id, input_text text, locale, voice_id voiceId, provider, char_count charCount, cached, status, created_at createdAt
       FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT 50`, u.id,
    );
    const logins = store.all(
      `SELECT action, ip, created_at createdAt FROM audit_log
       WHERE target_type = 'user' AND target_id = ? AND action LIKE 'login.%' ORDER BY id DESC LIMIT 20`, String(u.id),
    );
    res.json({ user: userOut(u), generations, logins });
  });

  router.post('/users/:id/approve', (req, res) => {
    const u = getUser(req.params.id);
    if (!['pending', 'rejected'].includes(u.status)) throw conflict('대기 또는 거절 상태의 회원만 승인할 수 있습니다.');
    res.json({ user: userOut(changeStatus(req, u, 'approved')) });
  });

  router.post('/users/:id/reject', (req, res) => {
    const u = getUser(req.params.id);
    if (u.status !== 'pending') throw conflict('승인 대기 중인 회원만 거절할 수 있습니다.');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) || null : null;
    res.json({ user: userOut(changeStatus(req, u, 'rejected', reason)) });
  });

  router.post('/users/:id/suspend', (req, res) => {
    const u = getUser(req.params.id);
    if (u.status !== 'approved') throw conflict('승인된 회원만 정지할 수 있습니다.');
    res.json({ user: userOut(changeStatus(req, u, 'suspended')) });
  });

  router.post('/users/:id/unsuspend', (req, res) => {
    const u = getUser(req.params.id);
    if (u.status !== 'suspended') throw conflict('정지된 회원만 해제할 수 있습니다.');
    res.json({ user: userOut(changeStatus(req, u, 'approved')) });
  });

  router.post('/users/bulk-approve', (req, res) => {
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number).filter(Number.isInteger).slice(0, 200) : [];
    if (!ids.length) throw new HttpError(400, '승인할 회원을 선택하세요.', 'VALIDATION_ERROR');
    const approved = store.tx(() =>
      ids
        .map((id) => store.get(`SELECT * FROM users WHERE id = ? AND status = 'pending'`, id))
        .filter(Boolean)
        .map((u) => changeStatus(req, u, 'approved')),
    );
    res.json({ approved: approved.length });
  });

  // 회원별 일일 글자 수 한도 (null이면 기본값)
  router.patch('/users/:id/quota', (req, res) => {
    const u = getUser(req.params.id);
    const v = req.body?.dailyCharLimit;
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 10_000_000)) {
      throw new HttpError(400, '한도는 0~10,000,000 사이 정수 또는 기본값(null)이어야 합니다.', 'VALIDATION_ERROR');
    }
    store.run('UPDATE users SET daily_char_limit = ? WHERE id = ?', v, u.id);
    store.audit('admin.user.quota', { actorId: req.user.id, targetType: 'user', targetId: u.id, detail: { from: u.daily_char_limit, to: v }, ip: req.ip });
    res.json({ user: userOut(getUser(u.id)) });
  });

  // 임시 비밀번호 발급 — 응답으로 한 번만 보여 준다
  router.post('/users/:id/temp-password', async (req, res) => {
    const u = getUser(req.params.id);
    if (u.id === req.user.id) throw conflict('본인 비밀번호는 내 정보에서 변경하세요.');
    if (u.username === adminUsername) throw conflict('관리자 비밀번호는 서버 .env의 ADMIN_PASSWORD로 관리합니다.');
    const pw = tempPassword();
    store.run('UPDATE users SET pw_hash = ? WHERE id = ?', await hashPassword(pw), u.id);
    sessions.revokeUser(u.id);
    store.audit('admin.user.temp_password', { actorId: req.user.id, targetType: 'user', targetId: u.id, ip: req.ip });
    res.json({ tempPassword: pw });
  });

  router.get('/generations', (req, res) => {
    const { q, status, userId } = req.query;
    const where = [];
    const params = [];
    if (status === 'done' || status === 'failed') where.push('g.status = ?'), params.push(status);
    if (userId) where.push('g.user_id = ?'), params.push(Number(userId));
    if (q) where.push(`(g.input_text LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')`), params.push(like(q), like(q));
    const rows = store.all(
      `SELECT g.id, g.input_text text, g.locale, g.voice_id voiceId, g.provider, g.speed, g.format, g.char_count charCount,
              g.cache_key cacheKey, g.cached, g.status, g.error, g.created_at createdAt, u.id userId, u.username userUsername, u.name userName
       FROM generations g LEFT JOIN users u ON u.id = g.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY g.id DESC LIMIT ?`,
      ...params, int(req.query.limit, 100),
    );
    res.json({
      items: rows.map(({ cacheKey, ...r }) => ({
        ...r,
        cached: Boolean(r.cached),
        audioUrl: r.status === 'done' ? `/api/audio/${cacheKey}.${r.format}` : null,
      })),
    });
  });

  router.get('/audit', (req, res) => {
    const { action } = req.query;
    const rows = store.all(
      `SELECT a.id, a.action, a.target_type targetType, a.target_id targetId, a.detail, a.ip, a.created_at createdAt,
              u.username actorUsername
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       ${action ? `WHERE a.action LIKE ? ESCAPE '\\'` : ''} ORDER BY a.id DESC LIMIT ?`,
      ...(action ? [`${String(action).replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : []), int(req.query.limit, 200),
    );
    res.json({ items: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
  });

  return router;
}
