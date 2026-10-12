import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
