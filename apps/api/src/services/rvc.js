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
        const input = path.join(dir, 'input.wav');
        const output = path.join(dir, 'output.wav');
        await writeFile(input, wav);
        const args = [
          '--model', model.pth,
          '--input', input,
          '--output', output,
          '--pitch', String(pitch),
          '--f0-method', this.f0Method,
          '--protect', String(this.protect),
          '--format', 'wav',
          '--overwrite',
        ];
        // .index가 없으면 index를 쓰지 않는다(없는데 지정하면 cli.py가 실패)
        if (model.hasIndex && existsSync(model.index)) args.push('--index', model.index, '--index-rate', String(this.indexRate));
        else args.push('--index-rate', '0');
        const started = Date.now();
        await this.#run(args);
        this.logger.info?.(`RVC done in ${Date.now() - started}ms (pitch ${pitch})`);
        return await readFile(output);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
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
