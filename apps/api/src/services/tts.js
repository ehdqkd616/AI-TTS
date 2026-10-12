import { detectLanguage } from '../pipeline/detectLanguage.js';
import { normalize } from '../pipeline/normalize/index.js';
import { splitIntoChunks } from '../pipeline/chunk.js';
import { mergeAudio, FORMATS } from '../pipeline/mergeAudio.js';
import { withRetry } from '../lib/retry.js';
import { HttpError } from '../lib/errors.js';
import { cacheKeyOf } from './store.js';

export const SPEED_RANGE = [0.5, 2.0];

export class TtsService {
  constructor({ providers, voices, store, maxTextLength = 5000, gapMs = 200, logger = console }) {
    Object.assign(this, { providers, voices, store, maxTextLength, gapMs, logger });
  }

  validate({ text, speed, format }) {
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '텍스트를 입력하세요.', 'EMPTY_TEXT');
    if ([...text].length > this.maxTextLength) {
      throw new HttpError(400, `텍스트는 ${this.maxTextLength}자 이하로 입력하세요.`, 'TEXT_TOO_LONG');
    }
    if (typeof speed !== 'number' || !(speed >= SPEED_RANGE[0] && speed <= SPEED_RANGE[1])) {
      throw new HttpError(400, `속도는 ${SPEED_RANGE[0]}~${SPEED_RANGE[1]} 사이여야 합니다.`, 'BAD_SPEED');
    }
    if (!FORMATS[format]) throw new HttpError(400, `지원 포맷: ${Object.keys(FORMATS).join(', ')}`, 'BAD_FORMAT');
  }

  /** ① 언어 감지 — 사용자가 고른 로케일이 항상 우선 */
  detect(text) {
    const result = detectLanguage(text);
    return { ...result, locale: this.voices.localeForLanguage(result.language) };
  }

  resolveLocale(text, locale) {
    if (locale) return locale;
    const detected = this.detect(text);
    if (!detected.locale) throw new HttpError(400, '언어를 감지하지 못했습니다. 언어를 직접 선택하세요.', 'DETECT_FAILED');
    return detected.locale;
  }

  /** ② 정규화 미리보기 */
  preview({ text, locale }) {
    const resolved = this.resolveLocale(text, locale);
    return { locale: resolved, normalized: normalize(text, resolved) };
  }

  /**
   * 전체 파이프라인.
   * @param {{text: string, locale?: string, voiceId?: string, speed?: number, format?: string, normalizedText?: string}} req
   *   normalizedText: 사용자가 미리보기에서 직접 고친 정규화 결과 (있으면 자동 정규화 생략)
   * @param {{beforeEngine?: (chars: number) => void}} hooks
   *   beforeEngine: 캐시에 없어 엔진을 실제로 부르기 직전 호출 (사용량 한도 검사용, 던지면 중단)
   */
  async synthesize({ text, locale, voiceId, speed = 1, format = 'mp3', normalizedText, userId }, { beforeEngine } = {}) {
    this.validate({ text, speed, format });
    if (normalizedText != null) this.validate({ text: normalizedText, speed, format });

    const resolvedLocale = this.resolveLocale(text, locale);
    const candidates = this.voices.resolve(resolvedLocale, voiceId); // ④ 보이스 매핑 (+ fallback 순서)
    const normalized = normalizedText?.trim() || normalize(text, resolvedLocale); // ②

    const keyFor = (voice) => cacheKeyOf({ normalized, locale: resolvedLocale, voice: voice.id, speed, format });
    const base = { text, normalized, locale: resolvedLocale, speed, format, charCount: [...normalized].length, userId };

    // 캐시 조회: 1순위 보이스 기준
    const primaryKey = keyFor(candidates[0]);
    if (await this.store.getAudio(primaryKey, format)) {
      const id = this.store.addGeneration({ ...base, voiceId: candidates[0].id, provider: candidates[0].provider, cacheKey: primaryKey, cached: true, status: 'done' });
      return { id, ...this.#result(base, candidates[0], primaryKey), cached: true };
    }

    beforeEngine?.(base.charCount);

    const errors = [];
    for (const voice of candidates) {
      const provider = this.providers.get(voice.provider);
      try {
        const chunks = splitIntoChunks(normalized, resolvedLocale, provider.maxChars); // ③
        const engineSpeed = provider.supportsSpeed ? speed : 1;
        const buffers = [];
        for (const chunk of chunks) {
          // ⑤ Provider 호출 (순차: 업체 동시 요청 한도 보호)
          buffers.push(await withRetry(() => provider.synthesize(chunk, resolvedLocale, voice, { speed: engineSpeed })));
        }
        // ⑥ 병합·후처리
        const audio = await mergeAudio(buffers, { format, gapMs: this.gapMs, tempo: provider.supportsSpeed ? 1 : speed });
        const key = keyFor(voice);
        await this.store.putAudio(key, format, audio);
        const id = this.store.addGeneration({ ...base, voiceId: voice.id, provider: voice.provider, cacheKey: key, cached: false, status: 'done' });
        return {
          id,
          ...this.#result(base, voice, key),
          cached: false,
          charCount: base.charCount,
          chunks: chunks.length,
          fallbackFrom: voice === candidates[0] ? undefined : candidates[0].id,
        };
      } catch (err) {
        this.logger.warn?.(`TTS failed with ${voice.id}: ${err.message}`);
        errors.push(`${voice.id}: ${err.message}`);
      }
    }

    this.store.addGeneration({ ...base, voiceId: candidates[0].id, provider: candidates[0].provider, cacheKey: primaryKey, cached: false, status: 'failed', error: errors.join(' | ').slice(0, 1000) });
    throw new HttpError(502, '음성 생성에 실패했습니다. 잠시 후 다시 시도하세요.', 'SYNTHESIS_FAILED');
  }

  #result(base, voice, key) {
    return {
      locale: base.locale,
      voice: { id: voice.id, provider: voice.provider, name: voice.name },
      normalized: base.normalized,
      format: base.format,
      audioUrl: `/api/audio/${key}.${base.format}`,
    };
  }
}
