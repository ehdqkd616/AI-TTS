import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/pipeline/normalize/index.js';
import { sinoKorean, nativeKorean } from '../src/pipeline/normalize/ko.js';
import { numberToWords, ordinalToWords, yearToWords } from '../src/pipeline/normalize/en.js';

test('한자어 수사', () => {
  assert.equal(sinoKorean(0), '영');
  assert.equal(sinoKorean(11), '십일');
  assert.equal(sinoKorean(2026), '이천이십육');
  assert.equal(sinoKorean(10000), '만');
  assert.equal(sinoKorean(1250000), '백이십오만');
  assert.equal(sinoKorean(100000000), '일억');
});

test('고유어 수사', () => {
  assert.equal(nativeKorean(3, true), '세');
  assert.equal(nativeKorean(20, true), '스무');
  assert.equal(nativeKorean(21, true), '스물한');
  assert.equal(nativeKorean(25), '스물다섯');
});

const KO_CASES = [
  ['사과 3개와 배 20개', '사과 세 개와 배 스무 개'],
  ['3층으로 오세요', '삼층으로 오세요'],
  ['2026-10-11에 만나요', '이천이십육 년 시월 십일 일에 만나요'],
  ['14:30에 출발', '열네 시 삼십 분에 출발'],
  ['5km 거리', '오 킬로미터 거리'],
  ['성공률 99.5%', '성공률 구십구 점 오 퍼센트'],
  ['AI 기술', '에이아이 기술'],
  ['6월과 10월', '유월과 시월'],
  ['12개월 동안', '십이 개월 동안'],
  ['3번째 시도, 1번째 시도', '세 번째 시도, 첫 번째 시도'],
  ['010-1234-5678', '공일공 일이삼사 오육칠팔'],
  ['$5 주세요', '오 달러 주세요'],
  ['3달러', '삼 달러'],
  ['학생 25명, 고양이 1마리', '학생 스물다섯 명, 고양이 한 마리'],
  ['3시간 뒤', '세 시간 뒤'],
  ['제3장', '제삼 장'],
];
for (const [input, expected] of KO_CASES) {
  test(`ko: ${input}`, () => assert.equal(normalize(input, 'ko-KR'), expected));
}

test('영어 숫자 읽기', () => {
  assert.equal(numberToWords(1234), 'one thousand two hundred thirty-four');
  assert.equal(ordinalToWords(21), 'twenty-first');
  assert.equal(ordinalToWords(12), 'twelfth');
  assert.equal(yearToWords(2026), 'twenty twenty-six');
  assert.equal(yearToWords(2005), 'two thousand five');
  assert.equal(yearToWords(1905), 'nineteen oh five');
  assert.equal(yearToWords(1900), 'nineteen hundred');
});

const EN_CASES = [
  ['Dr. Smith paid $5.50.', 'Doctor Smith paid five dollars and fifty cents.'],
  ['on 2026-10-11', 'on October eleventh, twenty twenty-six'],
  ['It is 3:05 pm. Meet at 4:00.', "It is three oh five P M. Meet at four o'clock."],
  ['grew 12.5% in 1999', 'grew twelve point five percent in nineteen ninety-nine'],
  ['The 21st runner ran 5km and 1 mi', 'The twenty-first runner ran five kilometers and one mile'],
  ['$3 million', 'three million dollars'],
  ['No. 7 in the 1990s', 'number seven in the nineteen nineties'],
];
for (const [input, expected] of EN_CASES) {
  test(`en-US: ${input}`, () => assert.equal(normalize(input, 'en-US'), expected));
}

test('en-GB: 날짜·단위 영국식', () => {
  assert.equal(normalize('on 2026-10-11, 5km away', 'en-GB'), 'on the eleventh of October, twenty twenty-six, five kilometres away');
});

test('ja: 단위만 변환', () => {
  assert.equal(normalize('5kmを30%で', 'ja-JP'), '5キロメートルを30パーセントで');
});

test('규칙 없는 언어는 공백 정리만', () => {
  assert.equal(normalize('  Hola   mundo 5  ', 'es-ES'), 'Hola mundo 5');
});
