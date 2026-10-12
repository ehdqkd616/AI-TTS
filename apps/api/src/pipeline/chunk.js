// 문장 경계 기준 분할. 단어 중간에서 자르면 억양이 끊기므로
// 문장 → 절(쉼표) → 단어 순으로만 쪼개고, maxChars 안에서 최대한 묶는다.

const CLAUSE_BREAK = /(?<=[,，、;；:：])/u;

function segments(text, locale, granularity) {
  const seg = new Intl.Segmenter(locale, { granularity });
  return [...seg.segment(text)].map((s) => s.segment);
}

function splitLong(piece, locale, maxChars) {
  if (piece.length <= maxChars) return [piece];
  const clauses = piece.split(CLAUSE_BREAK);
  const units = clauses.length > 1 ? clauses : segments(piece, locale, 'word');
  const out = [];
  let cur = '';
  for (const unit of units) {
    if (unit.length > maxChars) {
      if (cur) out.push(cur), (cur = '');
      if (clauses.length > 1) out.push(...splitLong(unit, locale, maxChars));
      else for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
    } else if ((cur + unit).length > maxChars) {
      out.push(cur);
      cur = unit;
    } else {
      cur += unit;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** @returns {string[]} 공백이 아닌 청크 목록 */
export function splitIntoChunks(text, locale, maxChars) {
  const sentences = text
    .split(/\n+/)
    .flatMap((para) => segments(para, locale, 'sentence'))
    .flatMap((s) => splitLong(s, locale, maxChars));

  const chunks = [];
  let cur = '';
  for (const sentence of sentences) {
    if (cur && (cur + sentence).length > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    cur += cur && !/\s$/.test(cur) && !/^\s/.test(sentence) ? ` ${sentence}` : sentence;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
