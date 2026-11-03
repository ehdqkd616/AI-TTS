import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.js';

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // s16le mono

export const FORMATS = {
  mp3: { mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3'] },
  wav: { mime: 'audio/wav', args: ['-c:a', 'pcm_s16le', '-f', 'wav'] },
  ogg: { mime: 'audio/ogg', args: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg'] },
};

/** 엔진마다 다른 포맷(WAV/MP3/...)을 24kHz mono PCM으로 통일 */
async function decodeToPcm(buffer, dir, i) {
  const file = path.join(dir, `chunk-${i}`);
  await writeFile(file, buffer);
  return runFfmpeg(['-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1']);
}

/** atempo는 0.5~2.0 범위만 지원 → 범위를 넘으면 체인으로 연결 */
function atempoChain(speed) {
  const filters = [];
  let s = speed;
  while (s > 2) filters.push('atempo=2'), (s /= 2);
  while (s < 0.5) filters.push('atempo=0.5'), (s /= 0.5);
  filters.push(`atempo=${s.toFixed(3)}`);
  return filters;
}

/**
 * 청크 오디오 병합 → 무음 삽입 → (필요 시) 속도 조절 → 음량 정규화 → 최종 포맷 인코딩
 * @param {Buffer[]} buffers
 * @param {{format?: keyof FORMATS, gapMs?: number, tempo?: number}} options
 */
export async function mergeAudio(buffers, { format = 'mp3', gapMs = 200, tempo = 1 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tts-'));
  try {
    const pcms = await Promise.all(buffers.map((b, i) => decodeToPcm(b, dir, i)));
    const gap = Buffer.alloc(Math.round((SAMPLE_RATE * gapMs) / 1000) * BYTES_PER_SAMPLE);
    const joined = Buffer.concat(pcms.flatMap((p, i) => (i ? [gap, p] : [p])));

    const filters = [...(Math.abs(tempo - 1) > 0.001 ? atempoChain(tempo) : []), 'loudnorm=I=-16:TP=-1.5:LRA=11'];
    return await runFfmpeg(
      [
        '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
        '-af', filters.join(','), '-ar', String(SAMPLE_RATE), ...FORMATS[format].args, 'pipe:1',
      ],
      joined,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 이미 하나로 합쳐진 오디오(예: RVC 변환 결과 WAV)를 최종 포맷으로 인코딩.
 * RVC 출력은 40k/48kHz라 24kHz로 낮추지 않고 48kHz로 낸다
 * (loudnorm은 출력 샘플레이트를 지정하지 않으면 192kHz로 올려 버린다).
 */
export async function encodeAudio(buffer, { format = 'mp3' } = {}) {
  return runFfmpeg(
    ['-i', 'pipe:0', '-ac', '1', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', ...FORMATS[format].args, 'pipe:1'],
    buffer,
  );
}

/** ffmpeg 결과를 임시 파일로 받는다 — 파이프로 낸 WAV는 헤더의 길이 값이 비어 있어 일부 플레이어가 길이를 못 읽는다 */
async function ffmpegToFile(args, input, ext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tts-out-'));
  try {
    const out = path.join(dir, `out.${ext}`);
    await runFfmpeg([...args, out], input);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 오디오 길이(ms) — 8kHz로 디코딩한 샘플 수로 계산 */
export async function audioDurationMs(buffer) {
  const pcm = await runFfmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], buffer);
  return Math.round(pcm.length / BYTES_PER_SAMPLE / 8);
}

/**
 * 문장(세그먼트) 여러 개를 하나로 이어 붙이면서 문장별 시작·끝 시각을 기록한다 (내부 내레이션 API용).
 * @param {Buffer[][]} segmentBuffers 문장마다 청크 오디오 목록
 * @param {{gapMs?: number, chunkGapMs?: number, tempo?: number}} options gapMs: 문장 사이 무음, chunkGapMs: 한 문장 안 청크 사이 무음
 * @returns {Promise<{wav: Buffer, durationMs: number, timings: {startMs: number, endMs: number}[]}>}
 *   wav는 24kHz mono, 속도 조절(tempo)까지 반영. 음량 정규화는 하지 않는다(최종 인코딩에서 한 번만)
 */
export async function joinSegments(segmentBuffers, { gapMs = 250, chunkGapMs = 200, tempo = 1 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tts-seg-'));
  try {
    const silence = (ms) => Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * BYTES_PER_SAMPLE);
    const parts = [];
    const timings = [];
    let samples = 0;
    let n = 0;
    for (const [si, buffers] of segmentBuffers.entries()) {
      if (si > 0) {
        const g = silence(gapMs);
        parts.push(g);
        samples += g.length / BYTES_PER_SAMPLE;
      }
      const start = samples;
      for (const [ci, b] of buffers.entries()) {
        if (ci > 0) {
          const g = silence(chunkGapMs);
          parts.push(g);
          samples += g.length / BYTES_PER_SAMPLE;
        }
        const pcm = await decodeToPcm(b, dir, n++);
        parts.push(pcm);
        samples += pcm.length / BYTES_PER_SAMPLE;
      }
      timings.push({ start, end: samples });
    }
    const toMs = (s) => Math.round((s / SAMPLE_RATE) * 1000 / tempo);
    const filters = Math.abs(tempo - 1) > 0.001 ? ['-af', atempoChain(tempo).join(',')] : [];
    const wav = await ffmpegToFile(
      ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0', ...filters, '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le'],
      Buffer.concat(parts),
      'wav',
    );
    return {
      wav,
      durationMs: toMs(samples),
      timings: timings.map((t) => ({ startMs: toMs(t.start), endMs: toMs(t.end) })),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 최종 내레이션 WAV: 48kHz mono, −16 LUFS 정규화, 길이 값이 제대로 들어간 헤더 */
export async function finalizeNarrationWav(buffer) {
  return ffmpegToFile(['-i', 'pipe:0', '-ac', '1', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'pcm_s16le'], buffer, 'wav');
}
