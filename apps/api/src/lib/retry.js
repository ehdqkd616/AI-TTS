const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 지수 백오프 재시도. err.retryable === false 이면 즉시 실패 */
export async function withRetry(fn, { retries = 2, baseMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.retryable === false || attempt === retries) break;
      await sleep(baseMs * 2 ** attempt + Math.random() * 100);
    }
  }
  throw lastErr;
}
