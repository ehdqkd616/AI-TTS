import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoChunks } from '../src/pipeline/chunk.js';

test('짧은 글은 한 청크', () => {
  assert.deepEqual(splitIntoChunks('Hello world. How are you?', 'en-US', 100), ['Hello world. How are you?']);
});

test('문장 경계에서 분할하고 maxChars 내로 묶음', () => {
  const chunks = splitIntoChunks('First sentence here. Second sentence here. Third one.', 'en-US', 45);
  assert.deepEqual(chunks, ['First sentence here. Second sentence here.', 'Third one.']);
});

test('한국어·일본어 문장 분할', () => {
  assert.deepEqual(splitIntoChunks('안녕하세요. 반갑습니다.', 'ko-KR', 8), ['안녕하세요.', '반갑습니다.']);
  assert.deepEqual(splitIntoChunks('こんにちは。元気ですか。', 'ja-JP', 7), ['こんにちは。', '元気ですか。']);
});

test('긴 문장은 쉼표 → 단어 단위로만 자름 (단어 중간 절단 없음)', () => {
  const text = 'alpha beta gamma, delta epsilon zeta, eta theta iota kappa lambda mu nu';
  const chunks = splitIntoChunks(text, 'en-US', 20);
  for (const c of chunks) assert.ok(c.length <= 20, c);
  const words = text.replace(/,/g, '').split(' ');
  assert.deepEqual(chunks.join(' ').replace(/,/g, '').split(/\s+/), words);
});

test('모든 청크가 한도 이내', () => {
  const text = '가나다라마바사아자차카타파하'.repeat(10);
  for (const c of splitIntoChunks(text, 'ko-KR', 30)) assert.ok(c.length <= 30);
});
