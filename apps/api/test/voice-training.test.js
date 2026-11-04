import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, approvedUser, ADMIN } from './helpers.js';
import { buildWav } from '../src/services/rvc.js';
import { VoiceTrainer } from '../src/services/voiceTraining.js';

// 실제 RVC 대신: 학습 스크립트마다 실제와 같은 위치에 결과 파일을 만드는 가짜 파이썬
//   FAIL_TRAIN 파일이 있으면 train.py가 실패, SLOW 파일이 있으면 train.py가 오래 걸린다(중지 시험용)
let rvcRoot;
let app;
let admin;
let user;

async function makeFakeRvc() {
  const root = await mkdtemp(path.join(tmpdir(), 'fake-rvc-train-'));
  for (const d of ['infer', 'train', 'train/dataset', 'configs/v1', 'assets/weights', '.venv/bin', 'logs/mute']) {
    await mkdir(path.join(root, d), { recursive: true });
  }
  for (const f of ['infer/cli.py', 'train/train.py', 'train/preprocess.py', 'train/train_index.py', 'train/dataset/extract_f0.py', 'train/dataset/extract_hubert_feature.py']) {
    await writeFile(path.join(root, f), '# fake');
  }
  await writeFile(path.join(root, 'configs/v1/40k.json'), '{"train":{}}');
  const py = path.join(root, '.venv', 'bin', 'python');
  await writeFile(
    py,
    `#!/bin/sh
echo "$(echo "$@" | sed "s/^-P //") cuda=\${CUDA_VISIBLE_DEVICES-unset}" >> "${root}/calls.log"
# 학습 스크립트는 -P(스크립트 폴더를 모듈 경로에 넣지 않음)로 실행한다
if [ "$1" = "-P" ]; then shift; fi
script="$1"; shift
case "$script" in
  -c) echo "F0=126.0" ;;  # 녹음 목소리 음높이 측정 → 12·log2(126/224) ≈ -10반음
  infer/cli.py)
    in=""; out=""; model=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --model) model="$2"; shift ;;
        --list-speakers) case "$model" in *.pth) echo "0-0"; exit 0 ;; *) exit 1 ;; esac ;;
        --input) in="$2"; shift ;;
        --output) out="$2"; shift ;;
      esac
      shift
    done
    cp "$in" "$out" ;;
  train/preprocess.py)
    mkdir -p "$4/0_gt_wavs"
    i=0; for f in "$1"/*.wav; do cp "$f" "$4/0_gt_wavs/0_$i.wav"; i=$((i+1)); done ;;
  train/dataset/extract_f0.py)
    mkdir -p "$5/2a_f0" "$5/2b-f0nsf"
    for f in "$5"/0_gt_wavs/*.wav; do n=$(basename "$f" .wav); : > "$5/2a_f0/$n.wav.npy"; : > "$5/2b-f0nsf/$n.wav.npy"; done ;;
  train/dataset/extract_hubert_feature.py)
    mkdir -p "$5/3_feature768"
    for f in "$5"/0_gt_wavs/*.wav; do n=$(basename "$f" .wav); : > "$5/3_feature768/$n.npy"; done ;;
  train/train.py)
    name=""; te=0
    while [ $# -gt 0 ]; do case "$1" in -e) name="$2"; shift ;; -te) te="$2"; shift ;; esac; shift; done
    if [ -f "${root}/FAIL_TRAIN" ]; then echo "RuntimeError: CUDA out of memory" >&2; exit 1; fi
    [ -f "logs/$name/filelist.txt" ] || { echo "no filelist" >&2; exit 1; }
    e=1; while [ $e -le $te ]; do
      echo "INFO ====> Epoch: $e [2026-11-04 08:00:00] | (0:00:01)" >> "logs/$name/train.log"
      if [ -f "${root}/SLOW" ]; then sleep 0.2; fi
      e=$((e+1))
    done
    printf 'PK\\003\\004fake' > "assets/weights/$name.pth" ;;
  train/train_index.py)
    echo index > "logs/$1/added_IVF1_Flat_nprobe_1_$1_v2.index" ;;
esac
`,
  );
  await chmod(py, 0o755);
  return root;
}

/** n초짜리 사인파 WAV */
function toneWav(seconds, sampleRate = 16000) {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 8000), i * 2);
  return buildWav({ channels: 1, sampleRate }, data);
}

async function upload(client, p, body, contentType = 'application/octet-stream') {
  const res = await fetch(client.origin + p, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const calls = async () => (await readFile(path.join(rvcRoot, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);

async function waitFor(id, statuses, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await admin.json('GET', '/api/admin/voice-trainings');
    const job = body.items.find((j) => j.id === id);
    if (statuses.includes(job.status)) return job;
    if (Date.now() > until) throw new Error(`timeout: ${job.status} ${job.stage} ${job.error ?? ''}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function newJob(body = {}) {
  const r = await admin.json('POST', '/api/admin/voice-trainings', { name: '루디 말하기', epochs: 20, ...body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  rvcRoot = await makeFakeRvc();
  app = await startApp({
    RVC_ROOT: rvcRoot,
    INTERNAL_API_TOKENS: `shorts:${'a'.repeat(40)}`,
    VOICE_TRAIN_MIN_SEC: '2',
    RVC_TRAIN_MIN_FREE_MB: '0',
    RVC_TRAIN_MIN_GPU_FREE_MB: '0',
    RVC_TRAIN_POLL_MS: '20',
  });
  admin = app.client();
  await admin.login(ADMIN.username, ADMIN.password);
  user = await approvedUser(app, admin);
});
after(async () => {
  await app.close();
  await rm(rvcRoot, { recursive: true, force: true });
});

test('관리자만 학습을 만들고 녹음을 올릴 수 있다', async () => {
  assert.equal((await user.json('GET', '/api/admin/voice-trainings')).status, 403);
  assert.equal((await user.json('POST', '/api/admin/voice-trainings', { name: 'x' })).status, 403);
  const job = await newJob();
  assert.equal((await upload(user, `/api/admin/voice-trainings/${job.id}/files?name=a.wav`, toneWav(3))).status, 403);
  const { body } = await admin.json('GET', '/api/admin/voice-trainings');
  assert.equal(body.enabled, true);
  assert.deepEqual(body.services, ['shorts']);
  await admin.json('DELETE', `/api/admin/voice-trainings/${job.id}`, {});
});

test('녹음 → 학습 → 목소리 모델 자동 등록 (index 포함, 학습 파일 정리)', async () => {
  const job = await newJob({ ownerService: 'shorts' });
  const bad = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=memo.txt`, Buffer.from('not audio at all'));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_AUDIO');

  // 너무 짧으면 시작할 수 없다
  let r = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=${encodeURIComponent('짧은.wav')}`, toneWav(1.5));
  assert.equal(r.status, 200);
  assert.equal((await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {})).body.error.code, 'DATASET_TOO_SHORT');

  r = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=${encodeURIComponent('낭독 1.wav')}`, toneWav(3));
  assert.equal(r.status, 200);
  assert.equal(r.body.files.length, 2);
  assert.equal(r.body.files[1].name, '낭독 1.wav');
  assert.ok(Math.abs(r.body.datasetSeconds - 4.5) < 0.05, String(r.body.datasetSeconds));
  // ffmpeg로 모노 40kHz WAV로 바꿔 둔다
  const ds = path.join(app.trainer.datasetDir(job.id));
  const wav = await readFile(path.join(ds, (await readdir(ds))[0]));
  assert.equal(wav.readUInt32LE(24), 40000);
  assert.equal(wav.readUInt16LE(22), 1);

  await writeFile(path.join(rvcRoot, 'calls.log'), '');
  const started = await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {});
  assert.equal(started.status, 200);
  const done = await waitFor(job.id, ['done', 'failed']);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.progress, 1);
  assert.equal(done.epoch, 20);

  // 단계 순서 + GPU 단계는 GPU 0번 (음높이 추출 뒤 목소리 음높이 측정 -c)
  const steps = (await calls()).map((l) => l.split(' ')[0]);
  assert.deepEqual(steps, [
    'train/preprocess.py',
    'train/dataset/extract_f0.py',
    '-c',
    'train/dataset/extract_hubert_feature.py',
    'train/train.py',
    'train/train_index.py',
    'infer/cli.py', // 등록 전 검사(--list-speakers)
  ]);
  const trainCall = (await calls()).find((l) => l.startsWith('train/train.py'));
  assert.match(trainCall, /-sr 40k -f0 1 -bs 1 -g 0 -te 20 -se 5 -pg assets\/pretrained_v2\/f0G40k\.pth -pd assets\/pretrained_v2\/f0D40k\.pth -l 1 -c 0 -sw 0 -v v2/);

  // 등록된 모델: 이름·공개 범위는 학습 설정 그대로, 피치는 녹음 음높이(126Hz)로 자동, index는 발음 우선(0.3)
  assert.equal(done.voiceF0, 126);
  assert.equal(done.pitch, -10);
  const models = (await admin.json('GET', '/api/admin/voice-models')).body.items;
  const model = models.find((m) => m.id === done.modelId);
  assert.ok(model);
  assert.equal(model.name, '루디 말하기');
  assert.equal(model.defaultPitch, -10);
  assert.equal(model.indexRate, 0.3);
  assert.equal(model.ownerService, 'shorts');
  assert.equal(model.hasIndex, true);

  // RVC 쪽 실험 폴더·결과 사본은 지우고, 녹음은 남긴다
  assert.equal(existsSync(app.trainer.expDir(job.id)), false);
  assert.equal(existsSync(app.trainer.weightFile(job.id)), false);
  assert.equal(existsSync(ds), true);
  assert.equal(app.rvc.cpuOnly, false);
});

test('실패 후 이어서 학습하면 끝난 단계는 건너뛴다', async () => {
  const job = await newJob();
  await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=a.wav`, toneWav(3));
  await writeFile(path.join(rvcRoot, 'FAIL_TRAIN'), '');
  await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {});
  const failed = await waitFor(job.id, ['done', 'failed']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /train\.py 실패.*out of memory/);
  assert.deepEqual(failed.stagesDone, ['preprocess', 'f0', 'feature']);
  assert.equal(app.rvc.cpuOnly, false);

  await rm(path.join(rvcRoot, 'FAIL_TRAIN'));
  await writeFile(path.join(rvcRoot, 'calls.log'), '');
  await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {});
  const done = await waitFor(job.id, ['done', 'failed']);
  assert.equal(done.status, 'done', done.error);
  const steps = (await calls()).map((l) => l.split(' ')[0]);
  assert.equal(steps[0], 'train/train.py');
  assert.ok(!steps.includes('train/preprocess.py'));
});

test('학습 중에는 목소리 변환이 CPU로 돌고, 중지할 수 있다', async () => {
  const job = await newJob({ epochs: 200 });
  await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=a.wav`, toneWav(3));
  await writeFile(path.join(rvcRoot, 'SLOW'), '');
  try {
    await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {});
    // 학습 단계에 들어가 에포크가 오를 때까지
    const until = Date.now() + 10_000;
    let cur;
    do {
      await new Promise((r) => setTimeout(r, 50));
      cur = (await admin.json('GET', '/api/admin/voice-trainings')).body.items.find((j) => j.id === job.id);
    } while (!(cur.stage === 'train' && cur.epoch >= 2) && Date.now() < until);
    assert.equal(cur.status, 'running');
    assert.ok(cur.progress > 0.1 && cur.progress < 1, String(cur.progress));
    assert.ok(cur.log.includes('모델 학습'));
    assert.equal(app.rvc.cpuOnly, true);

    // 학습 중에는 녹음·설정을 바꿀 수 없다
    assert.equal((await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=b.wav`, toneWav(3))).status, 409);
    assert.equal((await admin.json('DELETE', `/api/admin/voice-trainings/${job.id}`, {})).status, 409);

    // 변환 요청은 CUDA를 숨긴 채(CPU) 실행된다
    const wav = toneWav(1);
    const model = (await admin.json('GET', '/api/admin/voice-models')).body.items[0];
    await app.rvc.convert(wav, { ...app.voiceModels.paths(model.id), hasIndex: false });
    assert.ok((await calls()).some((l) => l.startsWith('infer/cli.py') && l.includes('--input') && l.endsWith('cuda=')));

    await admin.json('POST', `/api/admin/voice-trainings/${job.id}/cancel`, {});
    const canceled = await waitFor(job.id, ['canceled', 'failed', 'done']);
    assert.equal(canceled.status, 'canceled');
    assert.equal(app.rvc.cpuOnly, false);
  } finally {
    await rm(path.join(rvcRoot, 'SLOW'), { force: true });
  }
  // 중지 후에는 녹음을 지울 수 있고, 녹음이 바뀌면 처음부터 다시
  const job2 = (await admin.json('GET', '/api/admin/voice-trainings')).body.items.find((j) => j.id === job.id);
  const removed = await admin.json('DELETE', `/api/admin/voice-trainings/${job.id}/files/${job2.files[0].id}`, {});
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.stagesDone, []);
  assert.equal(existsSync(app.trainer.expDir(job.id)), false);
});

test('서버 재시작 후 돌던 작업은 중단됨으로 표시된다', async () => {
  const job = await newJob();
  app.store.run("UPDATE voice_trainings SET status = 'running', stage = 'train', pid = NULL WHERE id = ?", job.id);
  app.trainer.recover();
  const { body } = await admin.json('GET', '/api/admin/voice-trainings');
  const j = body.items.find((x) => x.id === job.id);
  assert.equal(j.status, 'failed');
  assert.match(j.error, /이어서 학습/);
});

test('에포크·이름 검증', async () => {
  assert.equal((await admin.json('POST', '/api/admin/voice-trainings', { name: 'x', epochs: 5 })).body.error.code, 'BAD_EPOCHS');
  assert.equal((await admin.json('POST', '/api/admin/voice-trainings', { name: '', epochs: 100 })).body.error.code, 'BAD_NAME');
  assert.equal((await admin.json('POST', '/api/admin/voice-trainings', { name: 'x', ownerService: 'BAD NAME' })).body.error.code, 'BAD_OWNER_SERVICE');
});

test('피치·에포크를 직접 정하면 자동 대신 그 값을 쓴다', async () => {
  const job = await newJob({ defaultPitch: -6, epochs: 20 });
  assert.equal(job.autoPitch, false);
  assert.equal(job.pitch, -6);
  await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=a.wav`, toneWav(3));
  await admin.json('POST', `/api/admin/voice-trainings/${job.id}/start`, {});
  const done = await waitFor(job.id, ['done', 'failed']);
  assert.equal(done.status, 'done', done.error);
  const model = (await admin.json('GET', '/api/admin/voice-models')).body.items.find((m) => m.id === done.modelId);
  assert.equal(model.defaultPitch, -6);
});

test('자동 에포크는 학습 조각 수로 정한다', async () => {
  const r = await admin.json('POST', '/api/admin/voice-trainings', { name: '자동' });
  assert.equal(r.body.autoEpochs, true);
  assert.equal(r.body.autoPitch, true);
  assert.equal(r.body.pitch, null); // 측정 전
  await upload(admin, `/api/admin/voice-trainings/${r.body.id}/files?name=a.wav`, toneWav(3));
  await admin.json('POST', `/api/admin/voice-trainings/${r.body.id}/start`, {});
  const done = await waitFor(r.body.id, ['done', 'failed'], 30_000);
  assert.equal(done.status, 'done', done.error);
  // 가짜 전처리는 파일당 조각 1개 → 에포크당 3스텝(+무음 2) → 상한 300
  assert.equal(done.epochs, 300);
});

test('자동 피치·에포크 계산', () => {
  assert.equal(VoiceTrainer.pitchFor(224), 0);
  assert.equal(VoiceTrainer.pitchFor(112), -12);
  assert.equal(VoiceTrainer.pitchFor(126), -10);
  assert.equal(VoiceTrainer.pitchFor(0), 0);
  assert.ok(Object.is(VoiceTrainer.pitchFor(222.8), 0));
  // 30분 녹음 ≈ 667조각 → 60에포크, 10분 ≈ 222조각 → 179에포크, 아주 짧으면 상한 300, 아주 길면 하한 30
  assert.equal(VoiceTrainer.autoEpochs(667), 60);
  assert.equal(VoiceTrainer.autoEpochs(222), 179);
  assert.equal(VoiceTrainer.autoEpochs(10), 300);
  assert.equal(VoiceTrainer.autoEpochs(5000), 30);
});

test('녹음 품질 경고: 클리핑·너무 작은 소리', async () => {
  const job = await newJob();
  // 최대치에 붙은 사각파(클리핑) + 아주 작은 사인파
  const n = 16000 * 2;
  const loud = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) loud.writeInt16LE(i % 40 < 20 ? 32767 : -32768, i * 2);
  let r = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=loud.wav`, buildWav({ channels: 1, sampleRate: 16000 }, loud));
  assert.match(r.body.files[0].warnings.join(), /클리핑/);
  const quiet = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) quiet.writeInt16LE(Math.round(Math.sin(i / 10) * 100), i * 2);
  r = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=quiet.wav`, buildWav({ channels: 1, sampleRate: 16000 }, quiet));
  assert.match(r.body.files[1].warnings.join(), /너무 작/);
  r = await upload(admin, `/api/admin/voice-trainings/${job.id}/files?name=ok.wav`, toneWav(2));
  assert.deepEqual(r.body.files[2].warnings, []);
});
