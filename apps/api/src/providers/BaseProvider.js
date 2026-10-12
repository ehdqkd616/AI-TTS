import { ProviderError } from '../lib/errors.js';

export class BaseProvider {
  /** @type {string} */
  name = 'base';
  /** 요청당 최대 글자 수 (청킹 기준, 업체 공식 한도보다 보수적으로) */
  maxChars = 1000;
  /** 엔진 자체 속도 조절 지원 여부. false면 후처리(ffmpeg atempo)로 조절 */
  supportsSpeed = false;
  /** 요청 타임아웃 (ms) */
  timeoutMs = 30_000;

  /** API 키 등 설정이 갖춰졌는지 */
  isEnabled() {
    return false;
  }

  /**
   * @param {string} text      정규화된 텍스트 (한 청크)
   * @param {string} locale    예: 'ko-KR'
   * @param {object} voice     voices.json의 보이스 항목 ({ voiceId, providerLocale?, ... })
   * @param {{speed?: number}} options
   * @returns {Promise<Buffer>} 오디오 데이터 (포맷 무관, 후처리에서 통일)
   */
  async synthesize(text, locale, voice, options = {}) {
    throw new Error('not implemented');
  }

  /** fetch 래퍼: 타임아웃 + 상태 코드별 재시도 가능 여부 판정 */
  async request(url, init) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ProviderError(this.name, `network error: ${err.message}`, { retryable: true });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(this.name, `HTTP ${res.status} ${body}`, { status: res.status, retryable });
    }
    return res;
  }
}
