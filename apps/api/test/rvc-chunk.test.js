import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWav, parseWav, splitWavAtSilence, concatWavs } from '../src/services/rvc.js';

const SR = 16000;
/** 소리(사인파) 구간과 무음 구간을 이어 만든 16비트 모노 WAV */
function makeWav(parts) {
  const frames = parts.reduce((n, p) => n + Math.round(p.sec * SR), 0);
  const data = Buffer.alloc(frames * 2);
  let f = 0;
  for (const p of parts) {
    const n = Math.round(p.sec * SR);
    for (let i = 0; i < n; i++, f++) data.writeInt16LE(p.loud ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * f) / SR)) : 0, f * 2);
  }
  return buildWav({ channels: 1, sampleRate: SR }, data);
}

test('짧은 WAV는 나누지 않는다', () => {
  assert.equal(splitWavAtSilence(makeWav([{ sec: 10, loud: true }]), 15), null);
});

test('16비트 PCM이 아니면 나누지 않는다 (원래대로 한 번에 변환)', () => {
  assert.equal(splitWavAtSilence(Buffer.from('not a wav file at all'), 15), null);
});

test('긴 WAV는 최대 길이 이하 조각으로, 무음에서 자르고, 이어 붙이면 원본과 같다', () => {
  // 4초 소리 + 0.25초 쉼을 반복 → 약 42초
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push({ sec: 4, loud: true }, { sec: 0.25, loud: false });
  const src = makeWav(parts);
  const chunks = splitWavAtSilence(src, 15);
  assert.ok(chunks.length >= 3);
  for (const c of chunks.slice(0, -1)) {
    const w = parseWav(c);
    const frames = w.data.length / 2;
    assert.ok(frames <= 15 * SR, '조각이 최대 길이를 넘지 않는다');
    assert.equal(w.data.readInt16LE((frames - 1) * 2), 0, '자른 곳 바로 앞이 무음');
  }
  assert.deepEqual(parseWav(concatWavs(chunks)).data, parseWav(src).data);
});

test('형식이 다른 조각은 이어 붙이지 않는다', () => {
  const a = buildWav({ channels: 1, sampleRate: 16000 }, Buffer.alloc(100));
  const b = buildWav({ channels: 1, sampleRate: 40000 }, Buffer.alloc(100));
  assert.throws(() => concatWavs([a, b]), /형식/);
});
