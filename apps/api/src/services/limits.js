import { HttpError } from '../lib/errors.js';

/** IP별 고정 윈도 요청 제한 (메모리). 단일 프로세스 기준 — 다중 인스턴스로 늘리면 Redis로 옮긴다. */
export class RateLimiter {
  constructor({ limit, windowMs = 60_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > this.limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw Object.assign(new HttpError(429, `요청이 너무 많습니다. ${retryAfter}초 후 다시 시도하세요.`, 'RATE_LIMITED'), { retryAfter });
    }
  }
}

/** 동시 합성 작업 수 제한 (ffmpeg·엔진 호출로 서버가 잠기지 않도록) */
export class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
  }

  async run(fn) {
    if (this.active >= this.max) {
      throw new HttpError(503, '지금 요청이 많아 처리할 수 없습니다. 잠시 후 다시 시도하세요.', 'BUSY');
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

/**
 * 일일 글자 수 한도 (회원별 + 서비스 전체). 사용량은 DB에 저장되어 재시작해도 유지된다.
 * 관리자는 회원별 한도를 받지 않지만 전체 한도(비용 상한)에는 포함된다.
 */
export class DailyQuota {
  constructor(store, { perUser, global }) {
    Object.assign(this, { store, perUser, global });
  }

  limitOf(user) {
    if (user.role === 'admin') return null;
    return user.daily_char_limit ?? this.perUser;
  }

  usageOf(user) {
    return { usedToday: this.store.getUsage(`user:${user.id}`), dailyLimit: this.limitOf(user) };
  }

  assertAvailable(user, chars) {
    if (this.store.getUsage('global') + chars > this.global) {
      throw new HttpError(429, '오늘 서비스 전체 사용 한도에 도달했습니다. 내일 다시 이용해 주세요.', 'GLOBAL_QUOTA');
    }
    const limit = this.limitOf(user);
    if (limit == null) return;
    const used = this.store.getUsage(`user:${user.id}`);
    if (used + chars > limit) {
      throw new HttpError(429, `오늘 사용 한도(${limit.toLocaleString()}자)를 넘습니다. 남은 글자 수: ${Math.max(0, limit - used).toLocaleString()}자`, 'QUOTA_EXCEEDED');
    }
  }

  record(user, chars) {
    this.store.addUsage('global', chars);
    this.store.addUsage(`user:${user.id}`, chars);
  }
}
