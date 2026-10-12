// English text normalization: numbers, dates, currency, units, abbreviations.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

function under1000(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

/** 1234 → one thousand two hundred thirty-four */
export function numberToWords(n) {
  if (n === 0) return 'zero';
  const parts = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(under1000(chunk) + (SCALES[i] ? ` ${SCALES[i]}` : ''));
  }
  return parts.join(' ');
}

const ORDINAL_IRREGULAR = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** 21 → twenty-first */
export function ordinalToWords(n) {
  return numberToWords(n).replace(/([a-z]+)$/, (w) =>
    ORDINAL_IRREGULAR[w] ?? (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`),
  );
}

/** 2026 → twenty twenty-six, 2005 → two thousand five, 1905 → nineteen oh five */
export function yearToWords(y) {
  if (y >= 2000 && y < 2010) return numberToWords(y);
  if (y < 1000 || y % 1000 === 0) return numberToWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${numberToWords(hi)} hundred`;
  return `${numberToWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

function readNumber(str) {
  const [int, frac] = str.replace(/,/g, '').split('.');
  let s = numberToWords(Number(int));
  if (frac) s += ' point ' + [...frac].map((d) => ONES[d]).join(' ');
  return s;
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

const UNITS = {
  km: ['kilometer', 'kilometre'], cm: ['centimeter', 'centimetre'], mm: ['millimeter', 'millimetre'],
  m: ['meter', 'metre'], kg: ['kilogram'], g: ['gram'], ml: ['milliliter', 'millilitre'],
  mi: ['mile'], lb: ['pound'], lbs: ['pound'], ft: ['foot'], '°C': ['degree Celsius'], '℃': ['degree Celsius'],
  '°F': ['degree Fahrenheit'], GB: ['gigabyte'], MB: ['megabyte'],
};
const pluralize = (word, n) => {
  if (n === 1) return word;
  if (word === 'foot') return 'feet';
  return word.replace(/^(\w+)/, '$1s');
};

const CURRENCIES = { $: ['dollar', 'cent'], '£': ['pound', 'penny'], '€': ['euro', 'cent'] };

const ABBREVIATIONS = [
  [/\bDr\.(?=\s+[A-Z])/g, 'Doctor'],
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bMs\.(?=\s)/g, 'Miz'],
  [/\bProf\.(?=\s+[A-Z])/g, 'Professor'],
  [/\betc\./g, 'et cetera'],
  [/\bvs\.?(?=\s)/g, 'versus'],
  [/\be\.g\.,?/g, 'for example,'],
  [/\bi\.e\.,?/g, 'that is,'],
  [/\bNo\.\s?(?=\d)/g, 'number '],
];

export function normalizeEn(text, locale = 'en-US') {
  const british = locale === 'en-GB';
  let s = text;

  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);

  // ISO 날짜: 2026-10-11
  s = s.replace(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, (m, y, mo, d) => {
    const month = MONTHS[+mo - 1];
    if (!month || +d < 1 || +d > 31) return m;
    return british
      ? `the ${ordinalToWords(+d)} of ${month}, ${yearToWords(+y)}`
      : `${month} ${ordinalToWords(+d)}, ${yearToWords(+y)}`;
  });

  // 연도 문맥: in 1999, since 2020
  s = s.replace(/\b(in|since|by|from|until|of|year|circa)\s+(1[1-9]\d\d|20\d\d)\b/gi, (_, p, y) => `${p} ${yearToWords(+y)}`);
  s = s.replace(/\b(1[1-9]\d\d|20\d\d)s\b/g, (_, y) => yearToWords(+y).replace(/y$/, 'ie') + 's');

  // 시각: 3:30 pm
  // "pm." 처럼 점이 하나만 붙은 경우 그 점은 문장 끝 마침표로 보고 남긴다
  s = s.replace(/(?<!\d)(\d{1,2}):([0-5]\d)(?:\s*([ap])(\.)?m\b(\.)?)?(?![\w:])/gi, (_, h, mm, ap, innerDot, endDot) => {
    let t = numberToWords(+h);
    if (+mm === 0) t += ap ? '' : " o'clock";
    else t += ` ${+mm < 10 ? `oh ${ONES[+mm]}` : numberToWords(+mm)}`;
    if (!ap) return t;
    return `${t} ${ap.toUpperCase()} M${endDot && !innerDot ? '.' : ''}`;
  });

  // 통화: $5.50, $3 million
  s = s.replace(
    new RegExp(`([$£€])\\s?(${NUM})(?:\\s+(thousand|million|billion|trillion))?`, 'g'),
    (_, cur, n, scale) => {
      const [major, minor] = CURRENCIES[cur];
      const [int, frac] = n.replace(/,/g, '').split('.');
      if (scale) return `${readNumber(n)} ${scale} ${major}s`;
      let out = `${numberToWords(+int)} ${pluralize(major, +int)}`;
      if (frac && +frac.padEnd(2, '0').slice(0, 2)) {
        const c = +frac.padEnd(2, '0').slice(0, 2);
        out += ` and ${numberToWords(c)} ${minor === 'penny' ? (c === 1 ? 'penny' : 'pence') : pluralize(minor, c)}`;
      }
      return out;
    },
  );

  // 퍼센트
  s = s.replace(new RegExp(`(${NUM})\\s?%`, 'g'), (_, n) => `${readNumber(n)} percent`);

  // 단위
  const unitKeys = Object.keys(UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  s = s.replace(new RegExp(`(${NUM})\\s?(${unitKeys})(?![A-Za-z])`, 'g'), (_, n, u) => {
    const [us, gb] = UNITS[u];
    const word = british && gb ? gb : us;
    return `${readNumber(n)} ${pluralize(word, Number(n.replace(/,/g, '')))}`;
  });

  // 서수: 1st, 22nd
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n) => ordinalToWords(+n));

  // 나머지 숫자
  s = s.replace(new RegExp(`(?<![\\w.])(${NUM})`, 'g'), (n) => readNumber(n));

  return s.replace(/[ \t]{2,}/g, ' ');
}
