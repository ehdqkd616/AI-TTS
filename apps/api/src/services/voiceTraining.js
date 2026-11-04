import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError } from '../lib/errors.js';
import { runFfmpeg } from '../lib/ffmpeg.js';
import { VoiceModels, fileAsUpload, receiveToFile } from './voiceModels.js';

const MB = 1024 * 1024;
const ID_RE = /^[0-9a-f]{16}$/;
const SR = 40000; // RVC v2 40k (사전 학습 모델 f0G40k/f0D40k). 학습용 WAV도 이 샘플레이트로 맞춰 둔다
const WAV_BYTES_PER_SEC = SR * 2; // 모노 16비트
export const EPOCH_RANGE = [20, 1000];
// 기본 TTS(MeloTTS 한국어, Shorts 기본 보이스)의 말소리 중앙 음높이 — 2026-11-04 5문장 측정 207~235Hz, 중앙 224Hz.
// 녹음한 목소리의 중앙 음높이와 비교해 변환 피치를 자동으로 정한다 (반음 = 12·log2(목소리/TTS))
export const TTS_F0_HZ = 224;
// 자동 에포크: 녹음 길이와 상관없이 학습 스텝이 이 정도가 되게 (배치 1 기준 30분 녹음 ≈ 60에포크, 10분 ≈ 180)
const AUTO_TARGET_STEPS = 40_000;
const AUTO_EPOCH_RANGE = [30, 300];

/** 단계 이름 → 화면 표시, 전체 진행률에서 차지하는 비중(학습이 대부분) */
export const STAGES = [
  ['preprocess', '녹음 자르기', 0.03],
  ['f0', '음높이 추출', 0.04],
  ['feature', '발음 특징 추출', 0.03],
  ['train', '모델 학습', 0.85],
  ['index', 'index 만들기', 0.03],
  ['register', '목소리 모델 등록', 0.02],
];
const STAGE_KEYS = STAGES.map(([k]) => k);

class Canceled extends Error {}

/**
 * 말하기 목소리 RVC 학습 — 관리자가 올린 낭독 녹음으로 RVC 모델을 학습해 목소리 모델로 등록한다.
 *
 * 노래로 학습한 모델은 TTS(말소리) 위에 노래 발성(늘어진 모음)을 덮어 자음이 뭉개진다.
 * 같은 사람의 말하기 녹음으로 학습하면 음색은 같고 발음은 TTS 그대로 살아난다.
 *
 * 학습 엔진은 RVC 변환과 마찬가지로 RVC-Learning의 RVC WebUI 스크립트를 그대로 부른다(WebUI의 '학습' 탭과 같은 순서·인자):
 *   train/preprocess.py → train/dataset/extract_f0.py → train/dataset/extract_hubert_feature.py
 *   → filelist.txt·config.json 작성(여기서) → train/train.py → train/train_index.py
 * 실험 폴더는 $RVC_ROOT/logs/aitts-<id>, 결과는 $RVC_ROOT/assets/weights/aitts-<id>.pth.
 * 등록이 끝나면 둘 다 지운다(체크포인트만 수백 MB). 녹음(dataset)은 다시 학습할 수 있게 남긴다.
 *
 * GPU(GTX 1050 Ti 4GB)는 하나라 학습은 한 번에 하나씩만 돌린다.
 * 학습하는 동안 RVC 변환은 CPU로 돌려(rvc.cpuOnly) 회원·내부 서비스의 음성 생성이 멈추지 않게 한다.
 *
 * 각 단계는 끝날 때마다 stages_done에 기록한다. 중간에 멈추거나 서버가 재시작돼도 '이어서 학습'하면
 * 끝난 단계는 건너뛰고, train.py는 실험 폴더의 마지막 체크포인트(G_2333333.pth, save_every_epoch마다 저장)부터 잇는다.
 */
export class VoiceTrainer {
  constructor({ store, dir, rvc, voiceModels, env = {}, logger = console }) {
    Object.assign(this, { store, dir, rvc, voiceModels, logger });
    this.root = rvc.root;
    this.python = rvc.python;
    const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
    // GTX 1050 Ti(4GB, fp32)는 배치 2부터 CUDA OOM (2026-11-04 측정). RVC WebUI도 이 GPU의 기본값을 1로 잡는다
    this.batchSize = Math.min(16, Math.max(1, num(env.RVC_TRAIN_BATCH_SIZE, 1)));
    this.saveEvery = Math.max(1, num(env.RVC_TRAIN_SAVE_EVERY, 5));
    this.cpus = Math.max(1, num(env.RVC_TRAIN_CPUS, 4));
    this.minSeconds = num(env.VOICE_TRAIN_MIN_SEC, 180);
    this.maxSeconds = num(env.VOICE_TRAIN_MAX_SEC, 7200);
    this.maxFileBytes = num(env.VOICE_TRAIN_FILE_MAX_MB, 500) * MB;
    this.minFreeMb = num(env.RVC_TRAIN_MIN_FREE_MB, 2500); // 시스템 여유 RAM (0이면 검사 안 함)
    this.minGpuFreeMb = num(env.RVC_TRAIN_MIN_GPU_FREE_MB, 3000); // 여유 VRAM (0이면 검사 안 함)
    this.stepTimeoutMs = num(env.RVC_TRAIN_STEP_TIMEOUT_MIN, 60) * 60_000; // 학습 외 단계 하나의 시간 제한
    this.pollMs = num(env.RVC_TRAIN_POLL_MS, 3000);
    this.trainedIndexRate = Math.min(1, Math.max(0, num(env.RVC_TRAIN_INDEX_RATE, 0.3))); // 학습으로 등록하는 모델의 index 비율

    this.current = null; // { id, proc, cancel, tail, trainStart }
    this.working = false;
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    store.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_trainings (
        id            CHAR(16) PRIMARY KEY,
        name          TEXT NOT NULL,
        owner_service TEXT,                          -- 등록될 목소리 모델의 공개 범위 (NULL = 회원 공용)
        default_pitch INTEGER NOT NULL DEFAULT 0,
        epochs        INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'draft', -- draft | queued | running | done | failed | canceled
        stage         TEXT,                          -- 지금(또는 마지막으로) 돌던 단계
        stages_done   TEXT NOT NULL DEFAULT '',      -- 끝난 단계 (쉼표 구분) → 이어서 학습할 때 건너뜀
        epoch         INTEGER NOT NULL DEFAULT 0,
        pid           INTEGER,                       -- 돌고 있는 학습 프로세스 (재시작 후 남은 프로세스 정리용)
        error         TEXT,
        model_id      CHAR(16),                      -- 완료 후 등록된 voice_models.id
        auto_pitch    INTEGER NOT NULL DEFAULT 1,    -- 1이면 녹음의 음높이로 기본 피치를 정한다(default_pitch 무시)
        auto_epochs   INTEGER NOT NULL DEFAULT 1,    -- 1이면 녹음 길이로 에포크를 정한다(학습 단계 시작 때 epochs에 기록)
        voice_f0      REAL,                          -- 녹음 목소리의 중앙 음높이(Hz), 음높이 추출 단계 뒤 측정
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    INTEGER NOT NULL,
        started_at    INTEGER,
        finished_at   INTEGER
      );
      CREATE TABLE IF NOT EXISTS voice_training_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        training_id   CHAR(16) NOT NULL REFERENCES voice_trainings(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        seconds       REAL NOT NULL,
        bytes         INTEGER NOT NULL,
        mean_db       REAL,                          -- 평균 음량(dBFS) — 너무 작으면 경고
        max_db        REAL,                          -- 최대 음량(dBFS) — 0에 붙으면 클리핑(소리 깨짐) 경고
        created_at    INTEGER NOT NULL
      );
    `);
  }

  isEnabled() {
    return this.rvc.isEnabled() && existsSync(path.join(this.root, 'train', 'train.py'));
  }

  assertEnabled() {
    if (!this.isEnabled()) {
      throw new HttpError(503, '목소리 학습을 쓰려면 RVC(RVC_ROOT)가 설정돼 있어야 합니다.', 'RVC_DISABLED');
    }
  }

  // ───────── 경로 ─────────
  expName(id) {
    return `aitts-${id}`;
  }
  expDir(id) {
    return path.join(this.root, 'logs', this.expName(id));
  }
  weightFile(id) {
    return path.join(this.root, 'assets', 'weights', `${this.expName(id)}.pth`);
  }
  jobDir(id) {
    return path.join(this.dir, id);
  }
  datasetDir(id) {
    return path.join(this.jobDir(id), 'dataset');
  }

  // ───────── 조회 ─────────
  get(id) {
    const row = ID_RE.test(String(id)) ? this.store.get('SELECT * FROM voice_trainings WHERE id = ?', id) : null;
    if (!row) throw new HttpError(404, '학습 작업을 찾을 수 없습니다.', 'NOT_FOUND');
    return row;
  }

  files(id) {
    return this.store.all('SELECT id, original_name, seconds, bytes, mean_db, max_db, created_at FROM voice_training_files WHERE training_id = ? ORDER BY id', id);
  }

  out(row) {
    const files = this.files(row.id);
    const done = row.stages_done ? row.stages_done.split(',') : [];
    const job = { ...row, done };
    const live = this.current?.id === row.id ? this.current : null;
    return {
      id: row.id,
      name: row.name,
      ownerService: row.owner_service ?? null,
      defaultPitch: row.default_pitch,
      autoPitch: Boolean(row.auto_pitch),
      voiceF0: row.voice_f0 ?? null,
      // 등록될 피치: 자동이면 측정한 음높이로, 아직 측정 전이면 null
      pitch: row.auto_pitch ? (row.voice_f0 ? VoiceTrainer.pitchFor(row.voice_f0) : null) : row.default_pitch,
      epochs: row.auto_epochs && !row.epochs ? this.estimateEpochs(files.reduce((s, f) => s + f.seconds, 0)) : row.epochs,
      autoEpochs: Boolean(row.auto_epochs),
      status: row.status,
      stage: row.stage,
      stagesDone: done,
      epoch: row.epoch,
      error: row.error,
      modelId: row.model_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      datasetSeconds: files.reduce((s, f) => s + f.seconds, 0),
      files: files.map((f) => ({
        id: f.id, name: f.original_name, seconds: f.seconds, bytes: f.bytes, createdAt: f.created_at,
        meanDb: f.mean_db, maxDb: f.max_db, warnings: fileWarnings(f),
      })),
      progress: progressOf(job),
      etaSec: live ? this.#eta(row, live) : null,
      log: live ? live.tail.join('\n') : null,
    };
  }

  list() {
    return this.store.all('SELECT * FROM voice_trainings ORDER BY created_at DESC').map((r) => this.out(r));
  }

  #eta(row, live) {
    if (row.stage !== 'train' || !live.trainStart || row.epoch <= live.trainStart.epoch) return null;
    const perEpoch = (Date.now() - live.trainStart.at) / (row.epoch - live.trainStart.epoch);
    return Math.round(((row.epochs - row.epoch) * perEpoch) / 1000);
  }

  // ───────── 만들기·고치기 ─────────
  /** 녹음 목소리 음높이(Hz) → MeloTTS 음성을 그 목소리 높이로 옮기는 반음 수 */
  static pitchFor(voiceF0, ttsF0 = TTS_F0_HZ) {
    if (!(voiceF0 > 0)) return 0;
    return Math.max(-24, Math.min(24, Math.round(12 * Math.log2(voiceF0 / ttsF0)) || 0)); // -0 방지
  }

  /** 자동 에포크: 학습 조각 수(배치 1이면 에포크당 스텝 수)로 목표 스텝을 채운다 */
  static autoEpochs(slices, batchSize = 1) {
    const stepsPerEpoch = Math.max(1, Math.ceil((slices + 2) / batchSize));
    return Math.max(AUTO_EPOCH_RANGE[0], Math.min(AUTO_EPOCH_RANGE[1], Math.round(AUTO_TARGET_STEPS / stepsPerEpoch)));
  }

  /** 녹음 길이(초)로 미리 보는 에포크 — 실제 값은 녹음 자르기 뒤 조각 수로 다시 정한다 (조각 3초, 0.3초 겹침) */
  estimateEpochs(seconds) {
    return VoiceTrainer.autoEpochs(Math.max(1, Math.round(seconds / 2.7)), this.batchSize);
  }

  static validateEpochs(epochs) {
    const e = Number(epochs);
    if (!Number.isInteger(e) || e < EPOCH_RANGE[0] || e > EPOCH_RANGE[1]) {
      throw new HttpError(400, `에포크는 ${EPOCH_RANGE[0]}~${EPOCH_RANGE[1]} 사이 정수여야 합니다.`, 'BAD_EPOCHS');
    }
    return e;
  }

  /** defaultPitch·epochs를 비우면(null) 자동 — 피치는 녹음 음높이로, 에포크는 녹음 길이로 정한다 */
  create({ name, ownerService = null, defaultPitch = null, epochs = null, actorId = null }) {
    const id = randomBytes(8).toString('hex');
    const autoPitch = defaultPitch === null || defaultPitch === undefined || defaultPitch === '';
    const autoEpochs = epochs === null || epochs === undefined || epochs === '';
    this.store.run(
      `INSERT INTO voice_trainings (id, name, owner_service, default_pitch, auto_pitch, epochs, auto_epochs, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      VoiceModels.validateName(name),
      VoiceModels.validateOwnerService(ownerService),
      autoPitch ? 0 : VoiceModels.validatePitch(defaultPitch),
      autoPitch ? 1 : 0,
      autoEpochs ? 0 : VoiceTrainer.validateEpochs(epochs),
      autoEpochs ? 1 : 0,
      actorId,
      Date.now(),
    );
    mkdirSync(this.datasetDir(id), { recursive: true, mode: 0o700 });
    return this.out(this.get(id));
  }

  #assertEditable(row) {
    if (row.status === 'running' || row.status === 'queued') {
      throw new HttpError(409, '학습 중에는 바꿀 수 없습니다. 먼저 중지하세요.', 'TRAINING_BUSY');
    }
  }

  /** defaultPitch·epochs에 null을 주면 자동으로 되돌린다 */
  update(id, { name, ownerService, defaultPitch, epochs }) {
    const row = this.get(id);
    this.#assertEditable(row);
    const pitch = defaultPitch === undefined ? [row.default_pitch, row.auto_pitch] : defaultPitch === null || defaultPitch === '' ? [0, 1] : [VoiceModels.validatePitch(defaultPitch), 0];
    const ep = epochs === undefined ? [row.epochs, row.auto_epochs] : epochs === null || epochs === '' ? [0, 1] : [VoiceTrainer.validateEpochs(epochs), 0];
    this.store.run(
      'UPDATE voice_trainings SET name = ?, owner_service = ?, default_pitch = ?, auto_pitch = ?, epochs = ?, auto_epochs = ? WHERE id = ?',
      name === undefined ? row.name : VoiceModels.validateName(name),
      ownerService === undefined ? row.owner_service : VoiceModels.validateOwnerService(ownerService),
      ...pitch,
      ...ep,
      row.id,
    );
    return this.out(this.get(row.id));
  }

  /** 녹음이 바뀌면 앞 단계 결과는 쓸 수 없다 → 처음부터 다시 */
  async #resetProgress(id) {
    this.store.run("UPDATE voice_trainings SET stages_done = '', stage = NULL, epoch = 0, voice_f0 = NULL, epochs = CASE WHEN auto_epochs = 1 THEN 0 ELSE epochs END WHERE id = ?", id);
    await rm(this.expDir(id), { recursive: true, force: true });
  }

  /**
   * 녹음 파일 하나 추가 — 본문은 파일 그대로. 어떤 형식이든(m4a, mp3, wav…) ffmpeg로 모노 40kHz WAV로 바꿔 둔다.
   * 바꾸지 못하면(오디오가 아니면) 400.
   */
  async addFile(id, req, originalName) {
    const row = this.get(id);
    this.#assertEditable(row);
    const name = String(originalName ?? '').trim().slice(0, 200) || '녹음';
    const dir = this.datasetDir(row.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.jobDir(row.id), `upload-${randomBytes(4).toString('hex')}`);
    const wavTmp = `${tmp}.wav`;
    try {
      await receiveToFile(req, tmp, this.maxFileBytes);
      try {
        // -bitexact: LIST 등 덧붙는 청크 없이 44바이트 헤더만 → 파일 크기로 길이를 바로 계산
        await runFfmpeg(['-i', tmp, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact', wavTmp]);
      } catch {
        throw new HttpError(400, `오디오 파일로 읽을 수 없습니다: ${name}`, 'BAD_AUDIO');
      }
      const { size } = await stat(wavTmp);
      const seconds = Math.max(0, (size - 44) / WAV_BYTES_PER_SEC);
      if (seconds < 1) throw new HttpError(400, `소리가 거의 없는 파일입니다: ${name}`, 'BAD_AUDIO');
      const total = this.files(row.id).reduce((s, f) => s + f.seconds, 0);
      if (total + seconds > this.maxSeconds) {
        throw new HttpError(400, `녹음은 모두 합쳐 ${Math.round(this.maxSeconds / 60)}분까지입니다.`, 'DATASET_TOO_LONG');
      }
      const vol = await volumeOf(wavTmp);
      const { lastInsertRowid } = this.store.run(
        'INSERT INTO voice_training_files (training_id, original_name, seconds, bytes, mean_db, max_db, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        row.id, name, seconds, size, vol.meanDb, vol.maxDb, Date.now(),
      );
      await copyFile(wavTmp, path.join(dir, `${Number(lastInsertRowid)}.wav`));
      await this.#resetProgress(row.id);
      return this.out(this.get(row.id));
    } finally {
      await rm(tmp, { force: true });
      await rm(wavTmp, { force: true });
    }
  }

  async removeFile(id, fileId) {
    const row = this.get(id);
    this.#assertEditable(row);
    const f = this.store.get('SELECT id FROM voice_training_files WHERE id = ? AND training_id = ?', Number(fileId), row.id);
    if (!f) throw new HttpError(404, '녹음 파일을 찾을 수 없습니다.', 'NOT_FOUND');
    this.store.run('DELETE FROM voice_training_files WHERE id = ?', f.id);
    await rm(path.join(this.datasetDir(row.id), `${f.id}.wav`), { force: true });
    await this.#resetProgress(row.id);
    return this.out(this.get(row.id));
  }

  async remove(id) {
    const row = this.get(id);
    this.#assertEditable(row);
    this.store.run('DELETE FROM voice_training_files WHERE training_id = ?', row.id);
    this.store.run('DELETE FROM voice_trainings WHERE id = ?', row.id);
    await rm(this.jobDir(row.id), { recursive: true, force: true });
    if (this.root) {
      await rm(this.expDir(row.id), { recursive: true, force: true });
      await rm(this.weightFile(row.id), { force: true });
    }
    return row;
  }

  // ───────── 시작·중지 ─────────
  /** 대기열에 넣는다. done 이후 다시 누르면 같은 녹음으로 처음부터 새로 학습한다. */
  async start(id) {
    this.assertEnabled();
    const row = this.get(id);
    if (row.status === 'running' || row.status === 'queued') return this.out(row);
    const total = this.files(row.id).reduce((s, f) => s + f.seconds, 0);
    if (total < this.minSeconds) {
      throw new HttpError(400, `녹음이 너무 짧습니다. 최소 ${Math.round(this.minSeconds / 60)}분(권장 10~30분)이 필요합니다.`, 'DATASET_TOO_SHORT');
    }
    if (row.status === 'done') await this.#resetProgress(row.id);
    this.store.run("UPDATE voice_trainings SET status = 'queued', error = NULL, model_id = CASE WHEN status = 'done' THEN NULL ELSE model_id END WHERE id = ?", row.id);
    this.#kick();
    return this.out(this.get(row.id));
  }

  cancel(id) {
    const row = this.get(id);
    if (row.status === 'queued') {
      this.store.run("UPDATE voice_trainings SET status = 'canceled' WHERE id = ?", row.id);
    } else if (row.status === 'running' && this.current?.id === row.id) {
      this.current.cancel = true;
      if (this.current.proc) killGroup(this.current.proc.pid);
    }
    return this.out(this.get(row.id));
  }

  /**
   * 서버 시작 시: 'running'으로 남은 작업은 지난 프로세스가 죽으면서 멈춘 것 → 남은 학습 프로세스를 정리하고 '중단됨'으로.
   * pm2가 Node를 SIGKILL로 내리면 분리된(detached) 파이썬 학습 프로세스는 살아남아 GPU를 붙잡고 있을 수 있다.
   */
  recover() {
    for (const row of this.store.all("SELECT id, pid FROM voice_trainings WHERE status = 'running'")) {
      if (row.pid && isOurPython(row.pid)) killGroup(row.pid, 'SIGKILL');
      this.store.run(
        "UPDATE voice_trainings SET status = 'failed', pid = NULL, error = ? WHERE id = ?",
        '서버가 다시 시작되어 중단됐습니다. "이어서 학습"을 누르면 마지막 저장 지점부터 이어집니다.',
        row.id,
      );
    }
    this.#kick();
  }

  /** 서버 종료 시 돌고 있는 학습 프로세스도 같이 내린다 (다음 기동 때 이어서 학습 가능) */
  shutdown() {
    if (this.current?.proc) killGroup(this.current.proc.pid, 'SIGKILL');
  }

  // ───────── 실행 ─────────
  #kick() {
    if (this.working) return;
    this.working = true;
    setImmediate(() => this.#work().finally(() => (this.working = false)));
  }

  async #work() {
    for (;;) {
      const row = this.store.get("SELECT * FROM voice_trainings WHERE status = 'queued' ORDER BY created_at LIMIT 1");
      if (!row) return;
      await this.#runJob(row);
    }
  }

  #set(id, fields) {
    const keys = Object.keys(fields);
    this.store.run(`UPDATE voice_trainings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
  }

  async #runJob(row) {
    const { id } = row;
    const live = { id, proc: null, cancel: false, tail: [], trainStart: null };
    this.current = live;
    this.#set(id, { status: 'running', error: null, started_at: Date.now(), finished_at: null });
    const done = new Set(row.stages_done ? row.stages_done.split(',') : []);
    try {
      this.#checkMemory();
      // GPU를 넘겨받는다: 새 변환은 CPU로, 이미 GPU에서 돌던 변환은 끝날 때까지 기다린다
      this.rvc.cpuOnly = true;
      await this.rvc.idle();
      await this.#checkGpu();
      for (const stage of STAGE_KEYS) {
        if (done.has(stage)) continue;
        if (live.cancel) throw new Canceled();
        this.#set(id, { stage });
        this.#log(live, `── ${STAGES.find(([k]) => k === stage)[1]} ──`);
        await this.#stage(stage, this.get(id), live);
        done.add(stage);
        this.#set(id, { stages_done: [...done].join(',') });
      }
      this.#set(id, { status: 'done', pid: null, finished_at: Date.now() });
      this.logger.info?.(`voice training ${id} done`);
      // 등록이 끝났으면 RVC 쪽 실험 폴더(체크포인트·특징, 수백 MB)와 결과 .pth 사본을 치운다
      await rm(this.expDir(id), { recursive: true, force: true });
      await rm(this.weightFile(id), { force: true });
    } catch (err) {
      const canceled = err instanceof Canceled || live.cancel;
      this.#set(id, {
        status: canceled ? 'canceled' : 'failed',
        pid: null,
        finished_at: Date.now(),
        error: canceled ? null : err.message.slice(0, 2000),
      });
      if (!canceled) this.logger.warn?.(`voice training ${id} failed: ${err.message}`);
    } finally {
      this.rvc.cpuOnly = false;
      this.current = null;
    }
  }

  #checkMemory() {
    if (!this.minFreeMb) return;
    let availMb = null;
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
      if (m) availMb = Number(m[1]) / 1024;
    } catch {}
    if (availMb !== null && availMb < this.minFreeMb) {
      throw new Error(`서버 여유 메모리가 부족합니다 (${Math.round(availMb)}MB < ${this.minFreeMb}MB). 다른 작업이 끝난 뒤 다시 시도하세요.`);
    }
  }

  async #checkGpu() {
    if (!this.minGpuFreeMb) return;
    const out = await new Promise((resolve) => {
      const p = spawn('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits']);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? s : null));
    });
    const free = out ? Number(out.trim().split('\n')[0]) : NaN;
    if (Number.isFinite(free) && free < this.minGpuFreeMb) {
      throw new Error(`GPU 여유 메모리가 부족합니다 (${free}MB < ${this.minGpuFreeMb}MB). RVC WebUI·AI-Voice-Cover 등 GPU를 쓰는 작업이 끝난 뒤 다시 시도하세요.`);
    }
  }

  #log(live, line) {
    for (const l of String(line).split(/\r?\n|\r/)) {
      if (!l.trim()) continue;
      live.tail.push(l.slice(0, 300));
      if (live.tail.length > 40) live.tail.shift();
    }
  }

  async #stage(stage, row, live) {
    const exp = this.expDir(row.id);
    const half = 'False'; // GTX 1050 Ti는 fp16이 느리거나 안 돼서 RVC 규칙상 fp32 (모르는 GPU에서도 fp32가 안전)
    switch (stage) {
      case 'preprocess':
        await rm(exp, { recursive: true, force: true });
        await mkdir(exp, { recursive: true });
        // 3.0초 조각: RVC가 4GB GPU에 쓰는 값(configs/config.py preprocess_per)
        return this.#py(live, ['train/preprocess.py', this.datasetDir(row.id), String(SR), String(this.cpus), exp, 'False', '3.0']);
      case 'f0':
        await this.#py(live, ['train/dataset/extract_f0.py', 'cuda', '1', '0', '0', exp, half]);
        return this.#measureVoiceF0(row, live);
      case 'feature':
        return this.#py(live, ['train/dataset/extract_hubert_feature.py', 'cuda', '1', '0', '0', exp, 'v2', half]);
      case 'train': {
        const slices = await this.#writeTrainFiles(row);
        if (row.auto_epochs && !row.epochs) {
          row.epochs = VoiceTrainer.autoEpochs(slices, this.batchSize);
          this.#set(row.id, { epochs: row.epochs });
          this.#log(live, `학습 조각 ${slices}개 → ${row.epochs}에포크 (자동)`);
        }
        return this.#train(row, live);
      }
      case 'index': {
        await this.#py(live, ['train/train_index.py', this.expName(row.id), 'v2', path.join(this.jobDir(row.id), 'indices'), String(this.cpus), 'single']);
        if (!(await this.#findIndex(row.id))) throw new Error('index 파일이 만들어지지 않았습니다.');
        return;
      }
      case 'register':
        return this.#register(row);
      default:
        throw new Error(`unknown stage ${stage}`);
    }
  }

  /** WebUI click_train과 같은 filelist.txt(학습 목록) + config.json(v2 40k는 v1/40k.json 사용) */
  async #writeTrainFiles(row) {
    const exp = this.expDir(row.id);
    const dirs = { gt: '0_gt_wavs', feat: '3_feature768', f0: '2a_f0', nsf: '2b-f0nsf' };
    const stems = async (d) => new Set((await readdir(path.join(exp, d)).catch(() => [])).map((n) => n.split('.')[0]));
    const sets = await Promise.all(Object.values(dirs).map(stems));
    const names = [...sets[0]].filter((n) => sets.every((s) => s.has(n))).sort();
    if (!names.length) throw new Error('학습할 조각이 없습니다. 녹음에 말소리가 있는지 확인하세요.');
    const lines = names.map(
      (n) => `${path.join(exp, dirs.gt, `${n}.wav`)}|${path.join(exp, dirs.feat, `${n}.npy`)}|${path.join(exp, dirs.f0, `${n}.wav.npy`)}|${path.join(exp, dirs.nsf, `${n}.wav.npy`)}|0`,
    );
    const mute = path.join(this.root, 'logs', 'mute');
    const muteLine = `${path.join(mute, '0_gt_wavs', 'mute40k.wav')}|${path.join(mute, '3_feature768', 'mute.npy')}|${path.join(mute, '2a_f0', 'mute.wav.npy')}|${path.join(mute, '2b-f0nsf', 'mute.wav.npy')}|0`;
    lines.push(muteLine, muteLine);
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    await writeFile(path.join(exp, 'filelist.txt'), lines.join('\n'));
    const configFile = path.join(exp, 'config.json');
    if (!existsSync(configFile)) await copyFile(path.join(this.root, 'configs', 'v1', '40k.json'), configFile);
    return names.length;
  }

  /**
   * 녹음 목소리의 중앙 음높이(Hz) — extract_f0.py가 남긴 2b-f0nsf/*.npy(프레임별 Hz, 무성=0)의 유성 구간 중앙값.
   * 이 값으로 등록할 때 기본 피치를 정한다(자동 피치). 측정이 실패해도 학습은 계속한다.
   */
  async #measureVoiceF0(row, live) {
    const code = [
      'import sys, glob, numpy as np',
      'xs = [np.load(f).ravel() for f in glob.glob(sys.argv[1] + "/2b-f0nsf/*.npy")]',
      'v = np.concatenate(xs) if xs else np.zeros(0)',
      'v = v[(v > 50) & (v < 1000)]',
      'print("F0=%.1f" % (float(np.median(v)) if v.size else 0))',
    ].join('; ');
    try {
      await this.#py(live, ['-c', code, this.expDir(row.id)]);
      const m = live.tail.map((l) => /^F0=([\d.]+)/.exec(l)).filter(Boolean).at(-1);
      const f0 = m ? Number(m[1]) : 0;
      if (f0 > 0) {
        this.#set(row.id, { voice_f0: f0 });
        this.#log(live, `목소리 음높이 ${f0.toFixed(0)}Hz → 기본 피치 ${VoiceTrainer.pitchFor(f0)} (MeloTTS ${TTS_F0_HZ}Hz 기준)`);
      }
    } catch (err) {
      if (err instanceof Canceled) throw err;
      this.#log(live, `음높이 측정 실패(학습은 계속): ${err.message}`);
    }
  }

  async #train(row, live) {
    const exp = this.expDir(row.id);
    const logFile = path.join(exp, 'train.log');
    const pre = (k) => path.join('assets', 'pretrained_v2', `f0${k}40k.pth`);
    const args = [
      'train/train.py', '-e', this.expName(row.id), '-sr', '40k', '-f0', '1', '-bs', String(this.batchSize), '-g', '0',
      '-te', String(row.epochs), '-se', String(this.saveEvery), '-pg', pre('G'), '-pd', pre('D'),
      '-l', '1', '-c', '0', '-sw', '0', '-v', 'v2',
    ];
    // 진행률: train.py는 에포크마다 train.log에 "====> Epoch: N ..."(언어는 로캘에 따라 다름)을 남긴다
    const poll = setInterval(async () => {
      const epoch = await lastEpoch(logFile);
      if (epoch === null) return;
      // 처음 본 에포크 시각을 기준으로, 그 뒤 에포크가 오르는 속도로 남은 시간을 잰다(모델 로드 시간 제외)
      live.trainStart ??= { epoch, at: Date.now() };
      this.#set(row.id, { epoch });
    }, this.pollMs);
    try {
      await this.#py(live, args, { timeoutMs: 0, env: { RVC_CUDA_GRAPH: '0' } });
    } finally {
      clearInterval(poll);
    }
    const epoch = await lastEpoch(logFile);
    if (epoch !== null) this.#set(row.id, { epoch });
    if (!existsSync(this.weightFile(row.id))) throw new Error('학습이 끝났지만 결과 모델(.pth)이 없습니다. 로그를 확인하세요.');
  }

  async #findIndex(id) {
    const exp = this.expDir(id);
    const name = (await readdir(exp).catch(() => [])).find((n) => n.startsWith('added_') && n.endsWith('.index'));
    return name ? path.join(exp, name) : null;
  }

  async #register(row) {
    const model = await this.voiceModels.create(await fileAsUpload(this.weightFile(row.id)), {
      name: row.name,
      defaultPitch: row.auto_pitch && row.voice_f0 ? VoiceTrainer.pitchFor(row.voice_f0) : row.default_pitch,
      // 말하기 녹음으로 만든 index라도 비율이 높으면 발음이 흐려진다(위 voiceModels.js 측정 참고) → 발음 우선으로 낮게 시작
      indexRate: this.trainedIndexRate,
      ownerService: row.owner_service,
      actorId: row.created_by,
      verify: (file) => this.rvc.verify(file),
    });
    const index = await this.#findIndex(row.id);
    if (index) await this.voiceModels.putIndex(model.id, await fileAsUpload(index));
    this.#set(row.id, { model_id: model.id });
    this.store.audit('admin.voice_model.create', {
      actorId: row.created_by,
      targetType: 'voice_model',
      targetId: model.id,
      detail: { name: model.name, bytes: model.modelBytes, ownerService: model.ownerService, via: 'voice-training', trainingId: row.id },
    });
  }

  /** RVC 파이썬 스크립트 실행 (cwd = RVC 루트). 자기 프로세스 그룹으로 띄워 중지할 때 자식까지 한 번에 내린다 */
  #py(live, args, { timeoutMs = this.stepTimeoutMs, env = {} } = {}) {
    if (live.cancel) return Promise.reject(new Canceled());
    return new Promise((resolve, reject) => {
      // -P: 스크립트 폴더(train/)를 모듈 경로 맨 앞에 넣지 않는다. 넣으면 `from train import utils`가
      // train/ 패키지 대신 train/train.py를 잡아 순환 import로 실패한다. 모든 import는 PYTHONPATH(RVC 루트) 기준
      const proc = spawn(this.python, ['-P', ...args], {
        cwd: this.root,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONPATH: [this.root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
          ...env,
        },
      });
      live.proc = proc;
      this.#set(live.id, { pid: proc.pid ?? null });
      const timer = timeoutMs
        ? setTimeout(() => {
            this.#log(live, `시간 초과 (${Math.round(timeoutMs / 60000)}분)`);
            killGroup(proc.pid, 'SIGKILL');
          }, timeoutMs)
        : null;
      proc.stdout.on('data', (d) => this.#log(live, d));
      proc.stderr.on('data', (d) => this.#log(live, d));
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        live.proc = null;
        if (live.cancel) return reject(new Canceled());
        if (code === 0) return resolve();
        const last = live.tail.filter((l) => /error|exception|traceback|out of memory/i.test(l)).slice(-3);
        const oom = last.some((l) => /out of memory/i.test(l))
          ? ` — GPU 메모리 부족: GPU를 쓰는 다른 작업(RVC WebUI 등)을 끄거나 .env의 RVC_TRAIN_BATCH_SIZE(지금 ${this.batchSize})를 줄인 뒤 '이어서 학습'하세요.`
          : '';
        reject(new Error(`${path.basename(args[0])} 실패 (종료 코드 ${code})${last.length ? `: ${last.join(' / ')}` : ''}${oom}`));
      });
    });
  }
}

/** 전체 진행률 0~1: 끝난 단계의 비중 + 학습 단계는 에포크 비율만큼 */
function progressOf(job) {
  if (job.status === 'done') return 1;
  let p = 0;
  for (const [k, , w] of STAGES) {
    if (job.done.includes(k)) p += w;
    else if (k === 'train' && job.stage === 'train' && job.epochs) p += w * Math.min(1, job.epoch / job.epochs);
  }
  return Math.min(0.999, p);
}

/** train.log 끝부분에서 마지막 에포크 번호 */
async function lastEpoch(file) {
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, 64 * 1024);
    const { buffer } = await fh.read(Buffer.alloc(len), 0, len, size - len);
    const all = [...buffer.toString('utf8').matchAll(/====>\s*[^:：\d]*[:：]\s*(\d+)/g)];
    return all.length ? Number(all.at(-1)[1]) : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

function killGroup(pid, signal = 'SIGTERM') {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  if (signal !== 'SIGKILL') {
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }, 5000).unref();
  }
}

/** 재시작 후 DB에 남은 pid가 다른 프로그램으로 재사용됐을 수 있다 → 파이썬일 때만 정리 */
function isOurPython(pid) {
  try {
    return /python/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return false;
  }
}

/** ffmpeg volumedetect → 평균·최대 음량(dBFS). 실패하면 null */
function volumeOf(file) {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    p.on('error', () => resolve({ meanDb: null, maxDb: null }));
    p.on('close', () => {
      const n = (k) => {
        const m = new RegExp(`${k}:\\s*(-?[\\d.]+) dB`).exec(err);
        return m ? Number(m[1]) : null;
      };
      resolve({ meanDb: n('mean_volume'), maxDb: n('max_volume') });
    });
  });
}

/** 녹음 품질 경고 — 학습 전에 다시 녹음할지 판단하게 */
function fileWarnings(f) {
  const w = [];
  if (f.max_db != null && f.max_db > -0.5) w.push('소리가 깨졌을 수 있습니다(클리핑). 마이크를 조금 떨어뜨리거나 입력 볼륨을 낮춰 다시 녹음하세요.');
  if (f.mean_db != null && f.mean_db < -40) w.push('소리가 너무 작습니다. 마이크에 조금 더 가까이에서 녹음하세요.');
  return w;
}
