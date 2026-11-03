import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../lib/errors.js';

export const INTERNAL_HEADER = 'x-internal-token';

/**
 * 서버 안 다른 프로젝트(예: Shorts Studio)가 부르는 내부 API 인증 — 모든 프로젝트 공통 규약.
 * .env의 INTERNAL_API_TOKENS=이름:토큰,이름2:토큰2 — 토큰이 맞으면 그 요청은 서비스 계정 사용자(service:이름)로 처리한다.
 * 인터넷에서 온 요청의 X-Internal-Token 헤더는 Caddy가 지우고(request_header -X-Internal-Token),
 * /api/internal/*은 Caddy에서 404로 막는다. 그래서 토큰이 새어 나가도 바깥에서는 쓸 수 없다.
 */
export class InternalAuth {
  constructor(env = {}, { dailyCharLimit } = {}) {
    // 길이가 달라도 비교 시간이 같도록 해시끼리 비교한다
    this.tokens = String(env.INTERNAL_API_TOKENS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const i = entry.indexOf(':');
        const name = i > 0 ? entry.slice(0, i).trim() : '';
        const token = i > 0 ? entry.slice(i + 1).trim() : '';
        return { name, digest: digest(token), valid: /^[a-z0-9_-]{1,32}$/.test(name) && token.length >= 32 };
      })
      .filter((t) => t.valid);
    this.dailyCharLimit = dailyCharLimit;
  }

  isEnabled() {
    return this.tokens.length > 0;
  }

  /** 토큰 → 서비스 이름 (없거나 틀리면 null). 모든 항목을 끝까지 비교한다 */
  match(token) {
    if (typeof token !== 'string' || !token) return null;
    const d = digest(token);
    let found = null;
    for (const t of this.tokens) if (timingSafeEqual(d, t.digest) && !found) found = t.name;
    return found;
  }

  /**
   * 미들웨어: CSRF 검사·세션 로딩보다 먼저. 헤더가 있으면 반드시 맞아야 한다(틀리면 401로 끝냄).
   * 맞으면 req.user = 서비스 계정 사용자, req.service = 이름.
   */
  load = (req, res, next) => {
    const token = req.headers[INTERNAL_HEADER];
    if (token === undefined) return next();
    const name = this.match(Array.isArray(token) ? token[0] : token);
    if (!name) return next(new HttpError(401, '내부 API 토큰이 올바르지 않습니다.', 'BAD_INTERNAL_TOKEN'));
    req.service = name;
    req.user = serviceUser(name, this.dailyCharLimit);
    next();
  };
}

/** 서비스 계정: DB의 users 행이 아니다. 사용량은 user:service:이름 으로 따로 쌓인다 */
export function serviceUser(name, dailyCharLimit) {
  return { id: `service:${name}`, username: `service:${name}`, name: `서비스 ${name}`, role: 'service', status: 'approved', daily_char_limit: dailyCharLimit };
}

export function requireService(req, res, next) {
  if (!req.service) return next(new HttpError(404, 'not found', 'NOT_FOUND'));
  next();
}

const digest = (s) => createHash('sha256').update(String(s)).digest();
