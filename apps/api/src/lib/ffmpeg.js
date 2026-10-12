import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** ffmpeg 실행 → stdout 버퍼 반환 */
export function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    const out = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
    });
    if (input) proc.stdin.end(input);
    else proc.stdin.end();
  });
}
