export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Provider 호출 실패. retryable이면 재시도 대상 */
export class ProviderError extends Error {
  constructor(provider, message, { status, retryable = false } = {}) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}
