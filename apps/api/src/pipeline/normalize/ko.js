// 한국어 텍스트 정규화: 숫자·날짜·단위·약어를 읽는 말로 푼다.
// 핵심 난제는 고유어 수사(세 개)와 한자어 수사(삼 층)의 구분 → 뒤따르는 단위 명사로 결정한다.

const SINO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const SINO_POS = ['', '십', '백', '천'];
const SINO_GROUPS = ['', '만', '억', '조', '경'];
const DIGIT_NAMES = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

const NATIVE_ONES = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_ONES_ATTR = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];

// 고유어 수사와 쓰는 단위 명사 (긴 것 먼저 매칭되도록 정렬)
const NATIVE_COUNTERS = [
  '시간', '마리', '사람', '그루', '켤레', '송이', '군데', '가지', '자루', '봉지', '그릇', '접시',
  '시', '개', '명', '살', '권', '잔', '병', '장', '대', '벌', '척', '채', '곳', '달', '통', '번', '줄', '쌍', '판', '컵', '캔',
];
// 고유어 단위와 앞부분이 겹치지만 한자어로 읽는 단위
const SINO_OVERRIDES = ['개월', '번지', '번선', '시즌', '대학', '장면', '달러', '통화'];

const LETTER_NAMES = {
  A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지', H: '에이치', I: '아이',
  J: '제이', K: '케이', L: '엘', M: '엠', N: '엔', O: '오', P: '피', Q: '큐', R: '알',
  S: '에스', T: '티', U: '유', V: '브이', W: '더블유', X: '엑스', Y: '와이', Z: '지',
};

const UNITS = {
  km: '킬로미터', kg: '킬로그램', cm: '센티미터', mm: '밀리미터', ml: '밀리리터', mL: '밀리리터',
  m: '미터', g: '그램', l: '리터', L: '리터', '%': '퍼센트', '℃': '도', '°C': '도',
  GB: '기가바이트', MB: '메가바이트', KB: '킬로바이트', TB: '테라바이트',
};
const CURRENCY_PREFIX = { $: '달러', '₩': '원', '€': '유로', '¥': '엔', '£': '파운드' };

/** 한자어 수사: 12345 → 만이천삼백사십오 */
export function sinoKorean(n) {
  if (n === 0) return '영';
  let out = '';
  for (let g = 0; n > 0; g++, n = Math.floor(n / 10000)) {
    const group = n % 10000;
    if (group === 0) continue;
    let s = '';
    for (let pos = 3; pos >= 0; pos--) {
      const d = Math.floor(group / 10 ** pos) % 10;
      if (d === 0) continue;
      s += (d === 1 && pos > 0 ? '' : SINO_DIGITS[d]) + SINO_POS[pos];
    }
    if (group === 1 && g === 1) s = ''; // 일만 → 만
    out = s + SINO_GROUPS[g] + out;
  }
  return out;
}

/** 고유어 수사 (1~99). attributive=true면 단위 앞 관형형(한, 두, 세, 네, 스무) */
export function nativeKorean(n, attributive = false) {
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (attributive && n === 20) return '스무';
  return NATIVE_TENS[tens] + (attributive ? NATIVE_ONES_ATTR : NATIVE_ONES)[ones];
}

/** "1,234.56" → 천이백삼십사 점 오육 */
function readNumber(str) {
  const [int, frac] = str.replace(/,/g, '').split('.');
  let s = sinoKorean(Number(int));
  if (frac) s += ' 점 ' + [...frac].map((d) => DIGIT_NAMES[d]).join('');
  return s;
}

function monthWord(m) {
  if (m === 6) return '유';
  if (m === 10) return '시';
  return sinoKorean(m);
}

const NUM = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeKo(text) {
  let s = text;

  // 전화번호: 010-1234-5678 → 공일공 일이삼사 오육칠팔
  s = s.replace(/(?<!\d)(0\d{1,2})-(\d{3,4})-(\d{4})(?!\d)/g, (...m) =>
    m.slice(1, 4).map((g) => [...g].map((d) => (d === '0' ? '공' : DIGIT_NAMES[d])).join('')).join(' '),
  );

  // 날짜: 2026-10-11, 2026.10.11, 2026/10/11
  s = s.replace(/(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/g, (_, y, m, d) =>
    `${sinoKorean(+y)} 년 ${monthWord(+m)}월 ${sinoKorean(+d)} 일`,
  );

  // 시각: 14:30 → 열네 시 삼십 분
  s = s.replace(/(?<!\d)([01]?\d|2[0-4]):([0-5]\d)(?!\d)/g, (_, h, mm) => {
    const hour = +h === 0 ? '영' : nativeKorean(+h, true);
    return `${hour} 시` + (+mm ? ` ${sinoKorean(+mm)} 분` : '');
  });

  // 통화 기호: $5 → 오 달러
  s = s.replace(new RegExp(`([$₩€¥£])\\s?(${NUM})`, 'g'), (_, cur, n) => `${readNumber(n)} ${CURRENCY_PREFIX[cur]}`);

  // 단위: 5km → 오 킬로미터, 30% → 삼십 퍼센트
  const unitKeys = Object.keys(UNITS).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  s = s.replace(new RegExp(`(${NUM})\\s?(${unitKeys})(?![A-Za-z])`, 'g'), (_, n, u) => `${readNumber(n)} ${UNITS[u]}`);

  // 서수: 제3장 → 제삼 장, 3번째 → 세 번째 (첫 번째)
  s = s.replace(/제\s?(\d+)/g, (_, n) => `제${sinoKorean(+n)} `);
  s = s.replace(/(\d+)\s?번째/g, (_, n) => {
    const v = +n;
    if (v === 1) return '첫 번째';
    return v < 100 ? `${nativeKorean(v, true)} 번째` : `${sinoKorean(v)} 번째`;
  });

  // 월: 6월 → 유월, 10월 → 시월
  s = s.replace(/(?<![\d.])(\d{1,2})\s?월/g, (m, n) => (+n >= 1 && +n <= 12 ? `${monthWord(+n)}월` : m));

  // 단위 명사에 따라 고유어/한자어 수사 선택
  const sinoOverride = SINO_OVERRIDES.join('|');
  const nativeCounters = NATIVE_COUNTERS.join('|');
  s = s.replace(new RegExp(`(${NUM})(\\s?)(${sinoOverride}|${nativeCounters})`, 'g'), (m, n, _sp, counter) => {
    const isInt = /^[\d,]+$/.test(n);
    const v = Number(n.replace(/,/g, ''));
    if (SINO_OVERRIDES.includes(counter) || !isInt || v < 1 || v > 99) return `${readNumber(n)} ${counter}`;
    return `${nativeKorean(v, true)} ${counter}`;
  });

  // 나머지 숫자는 한자어로
  s = s.replace(new RegExp(`(${NUM})`, 'g'), (n) => readNumber(n));

  // 영문 대문자 약어: AI → 에이아이
  s = s.replace(/(?<![A-Za-z])[A-Z]{2,5}(?![A-Za-z])/g, (w) => [...w].map((c) => LETTER_NAMES[c]).join(''));

  return s.replace(/[ \t]{2,}/g, ' ');
}
