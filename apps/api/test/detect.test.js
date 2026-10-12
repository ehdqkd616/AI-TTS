import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage } from '../src/pipeline/detectLanguage.js';

const CASES = [
  ['안녕하세요, 반갑습니다.', 'ko'],
  ['こんにちは、元気ですか', 'ja'],
  ['東京へ行きます', 'ja'],
  ['我们今天去公园散步吧', 'zh'],
  ['Hello, how are you doing today? I hope everything is fine.', 'en'],
  ['Hola, ¿cómo estás? Me llamo Juan y vivo en Madrid.', 'es'],
  ["Bonjour, je suis très content de vous voir aujourd'hui.", 'fr'],
  ['Guten Tag, wie geht es Ihnen heute?', 'de'],
  ['오늘 OpenAI API를 테스트했다', 'ko'],
];
for (const [text, lang] of CASES) {
  test(`detect ${lang}: ${text}`, () => assert.equal(detectLanguage(text).language, lang));
}

test('한자만 있는 문장은 일본어를 대안으로 제시', () => {
  assert.deepEqual(detectLanguage('学生').alternatives, ['ja']);
});

test('문자가 없으면 감지 실패', () => {
  assert.equal(detectLanguage('12345 !!').language, null);
});
