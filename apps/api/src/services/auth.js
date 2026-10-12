import { randomBytes, scrypt, timingSafeEqual, createHash, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from '../lib/errors.js';
import { readCookie } from '../lib/cookies.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_COOKIE = 'tts_sid';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

// 없는 계정일 때도 해시 검증 시간을 맞추기 위한 더미 해시 (계정 존재 여부 노출 방지)
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`;

export async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = (stored ?? DUMMY_HASH).split('$');
  if (alg !== 'scrypt') return false;
  const h = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return timingSafeEqual(h, Buffer.from(hashHex, 'hex')) && stored != null;
}

// 아이디: 영문·숫자·_·- 3~32자 (모든 프로젝트 공통 규칙). 대소문자는 구분하지 않도록 소문자로 저장
export const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

export function usernameProblem(v) {
  return USERNAME_RE.test(v) ? null : '아이디는 영문, 숫자, _, - 조합 3~32자여야 합니다.';
}

/** 모든 프로젝트 공통 관리자 아이디 — 비밀번호는 .env의 ADMIN_PASSWORD로 관리 */
export const ADMIN_USERNAME = 'admin';
export const adminUsernameOf = () => ADMIN_USERNAME;

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    return '비밀번호는 8자 이상이어야 합니다.';
  }
  if (pw.length > 128) return '비밀번호가 너무 깁니다.';
  return null;
}

export function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  for (;;) {
    const pw = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
    if (!passwordProblem(pw)) return pw;
  }
}

export const STATUS_ERRORS = {
  pending: ['ACCOUNT_PENDING', '관리자 승인 대기 중입니다. 승인 후 이용할 수 있습니다.'],
  rejected: ['ACCOUNT_REJECTED', '가입이 거절되었습니다.'],
  suspended: ['ACCOUNT_SUSPENDED', '이용이 정지된 계정입니다. 관리자에게 문의하세요.'],
};

/** 아이디·IP별 로그인 실패 잠금 (메모리) */
export class LoginGuard {
  constructor({ maxFailures = 5, lockMinutes = 15 } = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMinutes * 60_000;
    this.fails = new Map();
  }

  #keys(username, ip) {
    return [`user:${username}`, `ip:${ip}`];
  }

  assertNotLocked(username, ip) {
    const now = Date.now();
    for (const key of this.#keys(username, ip)) {
      const f = this.fails.get(key);
      if (f && f.resetAt > now && f.count >= this.maxFailures) {
        const minutes = Math.ceil((f.resetAt - now) / 60_000);
        throw new HttpError(429, `로그인 시도가 너무 많습니다. 약 ${minutes}분 후 다시 시도하세요.`, 'LOGIN_LOCKED');
      }
    }
  }

  recordFailure(username, ip) {
    const now = Date.now();
    for (const key of this.#keys(username, ip)) {
      const f = this.fails.get(key);
      if (!f || f.resetAt <= now) this.fails.set(key, { count: 1, resetAt: now + this.lockMs });
      else f.count++;
    }
  }

  clear(username) {
    this.fails.delete(`user:${username}`);
  }
}

export class Sessions {
  constructor(store, { days = 7 } = {}) {
    this.store = store;
    this.ttlMs = days * 86_400_000;
  }

  create(req, res, userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.store.run('DELETE FROM sessions WHERE expires_at < ?', now);
    this.store.run(
      'INSERT INTO sessions (token_hash, user_id, user_agent, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token), userId, String(req.headers['user-agent'] ?? '').slice(0, 300), req.ip, now, now + this.ttlMs,
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: req.secure, // Caddy 뒤에서는 X-Forwarded-Proto=https → true
      sameSite: 'strict',
      path: '/',
      maxAge: this.ttlMs,
    });
  }

  destroy(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) this.store.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** 비밀번호 변경·정지 시 세션 무효화. exceptReq가 있으면 그 요청의 세션은 유지 */
  revokeUser(userId, exceptReq) {
    const keep = exceptReq ? readCookie(exceptReq, SESSION_COOKIE) : null;
    this.store.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keep ? sha256(keep) : '');
  }

  /** 미들웨어: 유효한 세션이면 req.user 설정 (승인된 회원만) */
  load = (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const user = this.store.get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'approved'`,
        sha256(token), Date.now(),
      );
      if (user) req.user = user;
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.', 'UNAUTHORIZED'));
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.', 'UNAUTHORIZED'));
  if (req.user.role !== 'admin') return next(new HttpError(403, '관리자만 접근할 수 있습니다.', 'FORBIDDEN'));
  next();
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

/**
 * 기동할 때마다 .env의 ADMIN_PASSWORD로 공통 관리자 계정 admin을 맞춘다.
 * 없으면 만들고, 있으면 관리자·승인 상태와 비밀번호를 .env 값으로 되돌린다 — 비밀번호는 .env가 기준.
 */
export async function ensureAdmin(store, env, logger = console) {
  const username = ADMIN_USERNAME;
  if (!env.ADMIN_PASSWORD) return;
  const existing = store.get('SELECT * FROM users WHERE username = ?', username);
  const now = Date.now();
  if (!existing) {
    store.run(
      `INSERT INTO users (username, name, pw_hash, role, status, approved_at, created_at) VALUES (?, '관리자', ?, 'admin', 'approved', ?, ?)`,
      username, await hashPassword(env.ADMIN_PASSWORD), now, now,
    );
    logger.log?.(`관리자 계정 생성: ${username}`);
    return;
  }
  const samePassword = await verifyPassword(env.ADMIN_PASSWORD, existing.pw_hash);
  if (samePassword && existing.role === 'admin' && existing.status === 'approved') return;
  store.run(
    `UPDATE users SET role = 'admin', status = 'approved', approved_at = COALESCE(approved_at, ?), pw_hash = ? WHERE id = ?`,
    now, samePassword ? existing.pw_hash : await hashPassword(env.ADMIN_PASSWORD), existing.id,
  );
  if (!samePassword) store.run('DELETE FROM sessions WHERE user_id = ?', existing.id); // 예전 비밀번호로 만든 세션 종료
  logger.log?.(`관리자 계정 동기화: ${username}`);
}
