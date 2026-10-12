import { normalizeKo } from './ko.js';
import { normalizeEn } from './en.js';
import { normalizeJa } from './ja.js';

const RULES = { ko: normalizeKo, en: normalizeEn, ja: normalizeJa };

/** 공통 정리 + 언어별 규칙. 규칙이 없는 언어는 엔진 자체 정규화에 맡긴다. */
export function normalize(text, locale) {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  const rule = RULES[locale.split('-')[0]];
  return rule ? rule(cleaned, locale).trim() : cleaned;
}
