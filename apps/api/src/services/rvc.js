import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpError } from '../lib/errors.js';

/**
 * RVC 목소리 변환 — RVC-Learning(RVC WebUI 포크)의 명령줄 도구 infer/cli.py를 그대로 호출한다.
 * 이미 설치된 RVC 가상환경(GPU용 PyTorch 포함)을 재사용하므로 이 프로젝트에 별도 설치가 없다.
 *
 * GTX 1050 Ti(4GB) 하나를 RVC WebUI·AI-Voice-Cover와 나눠 쓰므로, 이 서버 안에서는
 * 변환을 한 번에 하나씩만 돌리고(직렬 큐) 대기열이 차면 503으로 돌려보낸다.
 */
export class RvcConverter {
  constructor(env = {}, { logger = console } = {}) {
    this.root = env.RVC_ROOT || '';
    this.python = env.RVC_PYTHON || (this.root ? path.join(this.root, '.venv', 'bin', 'python') : '');
    this.timeoutMs = (Number(env.RVC_TIMEOUT_SEC) || 300) * 1000;
    this.maxQueue = Number(env.RVC_MAX_QUEUE) || 3;
    this.f0Method = env.RVC_F0_METHOD === 'pm' ? 'pm' : 'rmvpe';
    this.indexRate = clamp01(env.RVC_INDEX_RATE, 0.75);
    this.protect = Math.min(0.5, clamp01(env.RVC_PROTECT, 0.33));
    // 한 번에 변환할 최대 길이(초). 4GB GPU에서 20초는 되고 30초는 OOM이었다 (2026-11-04 측정)
    this.chunkSec = Math.min(60, Math.max(5, Number(env.RVC_CHUNK_SEC) || 15));
    this.logger = logger;
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  isEnabled() {
    return Boolean(this.root && existsSync(path.join(this.root, 'infer', 'cli.py')) && existsSync(this.python));
  }

  assertEnabled() {
    if (!this.isEnabled()) {
      throw new HttpError(503, '목소리 변환(RVC)이 설정되지 않았습니다. 관리자에게 문의하세요.', 'RVC_DISABLED');
    }
  }

  /** 직렬 큐: 앞 작업이 끝나야 다음 작업이 GPU를 쓴다 */
  #enqueue(fn) {
    if (this.pending >= this.maxQueue) {
      throw new HttpError(503, '목소리 변환 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.', 'RVC_BUSY');
    }
    this.pending++;
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {}).finally(() => this.pending--);
    return run;
  }

  #run(args, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.python, [path.join('infer', 'cli.py'), ...args], {
        cwd: this.root,
        // `python infer/cli.py`로 실행하면 sys.path[0]이 infer/라서 cli.py 안의 `from infer.…`가 실패한다 → RVC 루트를 모듈 경로에 넣는다
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: [this.root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`RVC 시간 초과 (${Math.round(timeoutMs / 1000)}초)`));
      }, timeoutMs);
      proc.stdout.on('data', (d) => (stdout = (stdout + d).slice(-4000)));
      proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(errorSummary(stderr, stdout) || `RVC exited ${code}`));
      });
    });
  }

  /** 업로드한 .pth를 RVC로 실제로 열어 보고 화자 정보를 읽는다 (CPU만 사용, 몇 초) */
  async verify(pthFile) {
    this.assertEnabled();
    try {
      return (await this.#run(['--model', pthFile, '--list-speakers'], 120_000)).trim();
    } catch (err) {
      throw new HttpError(400, `RVC가 이 모델을 열지 못했습니다: ${err.message}`, 'BAD_MODEL_FILE');
    }
  }

  /**
   * WAV 버퍼 → 목소리 변환된 WAV 버퍼
   * @param {Buffer} wav
   * @param {{pth: string, index: string, hasIndex: boolean}} model
   * @param {{pitch?: number}} options 반음 단위
   */
  convert(wav, model, { pitch = 0 } = {}) {
    this.assertEnabled();
    return this.#enqueue(async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'tts-rvc-'));
      try {
        // 긴 음성은 무음 지점에서 잘라 조각마다 cli.py를 따로 돌린 뒤 이어 붙인다.
        // RVC의 attention은 길이의 제곱으로 GPU 메모리를 쓰고 GTX 1050 Ti는 fp32라, 4GB에서 약 20초를 넘으면 CUDA OOM이 난다.
        // 폴더째 한 프로세스에 넘기면 첫 파일 뒤 GPU 메모리가 풀리지 않아 두 번째부터 OOM이 나므로 프로세스를 나눈다.
        const pieces = splitWavAtSilence(wav, this.chunkSec) ?? [wav];
        const common = ['--model', model.pth, '--pitch', String(pitch), '--f0-method', this.f0Method, '--protect', String(this.protect), '--format', 'wav', '--overwrite'];
        // .index가 없으면 index를 쓰지 않는다(없는데 지정하면 cli.py가 실패)
        if (model.hasIndex && existsSync(model.index)) common.push('--index', model.index, '--index-rate', String(this.indexRate));
        else common.push('--index-rate', '0');
        const started = Date.now();
        const outs = [];
        for (const [i, piece] of pieces.entries()) {
          const input = path.join(dir, `input-${i}.wav`);
          const output = path.join(dir, `output-${i}.wav`);
          await writeFile(input, piece);
          await this.#run([...common, '--input', input, '--output', output]);
          outs.push(await readFile(output));
        }
        this.logger.info?.(`RVC done in ${Date.now() - started}ms (pitch ${pitch}${pieces.length > 1 ? `, ${pieces.length} chunks` : ''})`);
        return pieces.length > 1 ? concatWavs(outs) : outs[0];
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

/** PCM WAV 읽기 — fmt·data 청크만 본다. 16비트 PCM이 아니면 null */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data || ![1, 0xfffe].includes(fmt.format) || fmt.bits !== 16) return null;
  return { channels: fmt.channels, sampleRate: fmt.sampleRate, bits: 16, data };
}

/** 16비트 PCM WAV 만들기 */
export function buildWav({ channels, sampleRate }, data) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * maxSec보다 긴 16비트 PCM WAV를 조각(WAV 버퍼 배열)으로 나눈다. 짧거나 읽을 수 없는 형식이면 null.
 * 자르는 곳은 각 조각 끝 maxSec-5초~maxSec 사이에서 20ms 구간 에너지가 가장 작은 곳 — 문장 사이 쉼(gapMs)에 걸린다.
 */
export function splitWavAtSilence(buf, maxSec) {
  const wav = parseWav(buf);
  if (!wav) return null;
  const frameBytes = wav.channels * 2;
  const totalFrames = Math.floor(wav.data.length / frameBytes);
  const maxFrames = Math.floor(maxSec * wav.sampleRate);
  if (totalFrames <= maxFrames) return null;
  const win = Math.max(1, Math.floor(wav.sampleRate * 0.02));
  const searchFrames = Math.min(Math.floor(5 * wav.sampleRate), maxFrames - win);
  const energy = (from) => {
    let sum = 0;
    for (let f = from; f < from + win; f++) {
      for (let c = 0; c < wav.channels; c++) sum += Math.abs(wav.data.readInt16LE((f * wav.channels + c) * 2));
    }
    return sum;
  };
  const chunks = [];
  let start = 0;
  while (totalFrames - start > maxFrames) {
    let best = start + maxFrames - win;
    let bestE = Infinity;
    for (let f = start + maxFrames - win; f >= start + maxFrames - searchFrames; f -= win) {
      const e = energy(f);
      if (e < bestE) {
        bestE = e;
        best = f;
      }
    }
    const cut = best + Math.floor(win / 2);
    chunks.push(buildWav(wav, wav.data.subarray(start * frameBytes, cut * frameBytes)));
    start = cut;
  }
  chunks.push(buildWav(wav, wav.data.subarray(start * frameBytes, totalFrames * frameBytes)));
  return chunks;
}

/** 같은 형식의 16비트 PCM WAV들을 순서대로 이어 붙인다 */
export function concatWavs(bufs) {
  const parts = bufs.map((b) => parseWav(b));
  if (parts.some((p) => !p)) throw new Error('RVC 결과 WAV 형식을 읽지 못했습니다.');
  const [first] = parts;
  if (parts.some((p) => p.sampleRate !== first.sampleRate || p.channels !== first.channels)) throw new Error('RVC 결과 조각의 형식이 서로 다릅니다.');
  return buildWav(first, Buffer.concat(parts.map((p) => p.data)));
}

function clamp01(v, d) {
  const n = Number(v);
  return v !== undefined && v !== '' && n >= 0 && n <= 1 ? n : d;
}

/**
 * 사람이 읽을 오류 한 줄만 고른다. cli.py는 예외를 stderr에 "rvc-cli: error: ..."로 남기고,
 * 변환 단계 실패(vc_single)는 stdout에 상태 문자열로 남긴다.
 */
function errorSummary(stderr, stdout) {
  const lines = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines(stderr);
  const pick = err.find((l) => l.startsWith('rvc-cli: error:')) ?? lines(stdout).at(-1) ?? err.at(-1) ?? '';
  return pick.slice(0, 300);
}
