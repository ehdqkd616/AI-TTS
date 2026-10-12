import { franc } from 'franc-min';

// franc(ISO 639-3) → 언어 코드. 라틴 문자권만 franc에 맡긴다.
const FRANC_LANGS = { eng: 'en', spa: 'es', fra: 'fr', deu: 'de', por: 'pt' };

const SCRIPTS = [
  ['hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/gu],
  ['kana', /[぀-ヿㇰ-ㇿ]/gu],
  ['han', /\p{Script=Han}/gu],
  ['latin', /\p{Script=Latin}/gu],
];

const countMatches = (text, re) => text.match(re)?.length ?? 0;

/**
 * 입력 문장의 언어를 추정한다. 결과는 "추천값"이며 사용자가 바꿀 수 있어야 한다.
 * @returns {{ language: string|null, confidence: 'high'|'medium'|'low', alternatives: string[] }}
 */
export function detectLanguage(text) {
  const counts = Object.fromEntries(SCRIPTS.map(([name, re]) => [name, countMatches(text, re)]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return { language: null, confidence: 'low', alternatives: [] };

  // 1차: 문자 체계로 판별
  if (counts.hangul > 0 && counts.hangul >= counts.kana) {
    return { language: 'ko', confidence: counts.hangul / total > 0.3 ? 'high' : 'medium', alternatives: [] };
  }
  if (counts.kana > 0) {
    return { language: 'ja', confidence: 'high', alternatives: [] };
  }
  if (counts.han > counts.latin) {
    // 한자만으로 된 문장은 일본어일 수도 있다
    return { language: 'zh', confidence: counts.han < 6 ? 'low' : 'medium', alternatives: ['ja'] };
  }

  // 2차: 라틴 문자권은 통계 모델
  const latin = text.replace(/[^\p{Script=Latin}\s'’-]/gu, ' ');
  const code = franc(latin, { only: Object.keys(FRANC_LANGS), minLength: 3 });
  if (code === 'und') return { language: 'en', confidence: 'low', alternatives: [] };
  return {
    language: FRANC_LANGS[code],
    confidence: counts.latin >= 25 ? 'medium' : 'low',
    alternatives: [],
  };
}
