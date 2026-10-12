import { readFileSync } from 'node:fs';
import { HttpError } from '../lib/errors.js';

const DEFAULT_CONFIG_PATH = new URL('../config/voices.json', import.meta.url);

/** voices.json 기반 보이스 카탈로그. 재배포 없이 파일만 바꿔 엔진·보이스를 교체할 수 있다. */
export class VoiceCatalog {
  constructor(providers, configPath = process.env.VOICES_CONFIG || DEFAULT_CONFIG_PATH) {
    this.providers = providers;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    this.defaultLocaleByLanguage = config.defaultLocaleByLanguage;
    this.locales = Object.fromEntries(
      Object.entries(config.locales).map(([locale, { label, voices }]) => {
        const list = voices.map((v) => ({ ...v, id: `${v.provider}:${v.voiceId}`, locale }));
        // 개발용 mock 보이스는 모든 로케일에 마지막 순위로 추가
        list.push({ provider: 'mock', voiceId: `test-tone-${locale}`, id: `mock:${locale}`, name: '테스트 톤 (실제 음성 아님)', gender: 'neutral', locale });
        return [locale, { label, voices: list }];
      }),
    );
  }

  isActive(voice) {
    return this.providers.get(voice.provider)?.isEnabled() ?? false;
  }

  localeForLanguage(language) {
    return language ? (this.defaultLocaleByLanguage[language] ?? null) : null;
  }

  /** 프론트엔드용 목록 (비활성 엔진 보이스는 available=false, mock은 비활성이면 숨김, 쓸 수 있는 보이스가 없는 언어는 숨김) */
  list() {
    const entries = Object.entries(this.locales).filter(([, { voices }]) => voices.some((v) => this.isActive(v)));
    return entries.map(([locale, { label, voices }]) => ({
      locale,
      label,
      voices: voices
        .filter((v) => v.provider !== 'mock' || this.isActive(v))
        .map(({ id, provider, name, gender }) => ({ id, provider, name, gender, available: this.isActive({ provider }) })),
    }));
  }

  /**
   * 사용할 보이스 + fallback 후보 순서 결정.
   * 사용자가 고른 보이스가 맨 앞, 그다음 같은 로케일의 다른 엔진 보이스.
   */
  resolve(locale, voiceId) {
    const entry = this.locales[locale];
    if (!entry) throw new HttpError(400, `지원하지 않는 언어입니다: ${locale}`, 'UNSUPPORTED_LOCALE');
    const active = entry.voices.filter((v) => this.isActive(v));
    if (!active.length) throw new HttpError(503, `${locale}에 사용 가능한 TTS 엔진이 없습니다. API 키 설정을 확인하세요.`, 'NO_PROVIDER');

    if (!voiceId) return active;
    const chosen = entry.voices.find((v) => v.id === voiceId);
    if (!chosen) throw new HttpError(400, `이 언어에 없는 보이스입니다: ${voiceId}`, 'UNKNOWN_VOICE');
    if (!this.isActive(chosen)) throw new HttpError(503, `선택한 보이스의 엔진(${chosen.provider})이 설정되지 않았습니다.`, 'PROVIDER_DISABLED');
    // fallback은 다른 엔진 보이스만 (같은 엔진이 실패했으면 같은 엔진은 대개 또 실패)
    return [chosen, ...active.filter((v) => v.provider !== chosen.provider)];
  }
}
