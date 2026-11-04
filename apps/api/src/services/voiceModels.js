import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { HttpError } from '../lib/errors.js';

export const PITCH_RANGE = [-24, 24];
export const NAME_MAX = 40;

const MB = 1024 * 1024;
const ID_RE = /^[0-9a-f]{16}$/;

/**
 * RVC 목소리 모델(.pth + 선택 .index) 보관소.
 * 파일은 storage/voice-models/<id>/model.pth, model.index — 메타데이터는 SQLite voice_models 테이블.
 *
 * 보안: .pth는 PyTorch pickle 파일이라 불러올 때 코드가 실행될 수 있다.
 * 그래서 업로드는 관리자 전용이고(라우트에서 requireAdmin), 회원은 목록에서 고르기만 한다.
 *
 * 공개 범위(owner_service): NULL이면 이 서비스 회원 모두가 고를 수 있는 공용 모델.
 * 값이 있으면 그 이름의 내부 서비스(INTERNAL_API_TOKENS)만 쓰는 전용 모델이라 회원 목록에는 나오지 않는다.
 * 관리자 개인 목소리처럼 다른 회원이 쓰면 안 되는 모델을 특정 프로젝트 전용으로 두기 위한 것.
 */
export class VoiceModels {
  constructor(store, dir, { maxModelBytes = 300 * MB, maxIndexBytes = 1024 * MB } = {}) {
    Object.assign(this, { store, dir, maxModelBytes, maxIndexBytes });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_models (
        id            CHAR(16) PRIMARY KEY,
        name          TEXT NOT NULL,
        default_pitch INTEGER NOT NULL DEFAULT 0,   -- 반음 단위 (기본 TTS가 여성 목소리라 남성 모델은 음수로)
        has_index     INTEGER NOT NULL DEFAULT 0,
        enabled       INTEGER NOT NULL DEFAULT 1,
        model_bytes   INTEGER NOT NULL DEFAULT 0,
        index_bytes   INTEGER NOT NULL DEFAULT 0,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,          -- 파일이 바뀌면 갱신 → 캐시 키에 포함
        owner_service TEXT                        -- NULL이면 회원 공용, 값이 있으면 그 내부 서비스 전용
      );
    `);
    const cols = store.db.prepare('PRAGMA table_info(voice_models)').all().map((c) => c.name);
    if (!cols.includes('owner_service')) store.db.exec('ALTER TABLE voice_models ADD COLUMN owner_service TEXT');
    // 모델별 변환 설정 (NULL이면 서버 기본값 RVC_INDEX_RATE / RVC_PROTECT)
    //   index_rate가 높으면 학습 녹음의 특징을 많이 섞어 음색은 닮지만 발음이 뭉개진다.
    //   2026-11-04 측정(노래 모델, MeloTTS 5문장, Whisper 받아쓰기 글자 오류율): 원본 4.3%, index 0 → 5.0%, 0.25 → 5.6%, 0.5 → 8~11%, 0.75 → 9.3%
    if (!cols.includes('index_rate')) store.db.exec('ALTER TABLE voice_models ADD COLUMN index_rate REAL');
    if (!cols.includes('protect')) store.db.exec('ALTER TABLE voice_models ADD COLUMN protect REAL');
  }

  static validateName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, '모델 이름을 입력하세요.', 'BAD_NAME');
    if ([...name.trim()].length > NAME_MAX) throw new HttpError(400, `모델 이름은 ${NAME_MAX}자 이하로 입력하세요.`, 'BAD_NAME');
    return name.trim();
  }

  static validatePitch(pitch) {
    const p = Number(pitch);
    if (!Number.isInteger(p) || p < PITCH_RANGE[0] || p > PITCH_RANGE[1]) {
      throw new HttpError(400, `피치는 ${PITCH_RANGE[0]}~${PITCH_RANGE[1]} 사이 정수여야 합니다.`, 'BAD_PITCH');
    }
    return p;
  }

  /** index 반영 비율 0~1. 비우면 서버 기본값(null) */
  static validateIndexRate(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, 'index 비율은 0~1 사이여야 합니다.', 'BAD_INDEX_RATE');
    return Math.round(n * 100) / 100;
  }

  /** 자음 보호 0~0.5 (낮을수록 무성 자음·숨소리를 원본 그대로 지킨다, 0.5는 끔). 비우면 서버 기본값(null) */
  static validateProtect(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 0.5) throw new HttpError(400, '자음 보호는 0~0.5 사이여야 합니다.', 'BAD_PROTECT');
    return Math.round(n * 100) / 100;
  }

  /** 내부 서비스 이름 (INTERNAL_API_TOKENS의 이름과 같은 규칙). 비우면 회원 공용(NULL) */
  static validateOwnerService(service) {
    if (service === undefined || service === null) return null;
    const s = String(service).trim();
    if (!s) return null;
    if (!/^[a-z0-9_-]{1,32}$/.test(s)) {
      throw new HttpError(400, '전용 서비스 이름은 영소문자·숫자·_·- 1~32자입니다.', 'BAD_OWNER_SERVICE');
    }
    return s;
  }

  modelDir(id) {
    if (!ID_RE.test(id)) return null;
    return path.join(this.dir, id);
  }

  paths(id) {
    const d = this.modelDir(id);
    return d && { pth: path.join(d, 'model.pth'), index: path.join(d, 'model.index') };
  }

  out(row) {
    return {
      id: row.id,
      name: row.name,
      ownerService: row.owner_service ?? null,
      defaultPitch: row.default_pitch,
      indexRate: row.index_rate ?? null,
      protect: row.protect ?? null,
      hasIndex: Boolean(row.has_index),
      enabled: Boolean(row.enabled),
      modelBytes: row.model_bytes,
      indexBytes: row.index_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 기본값은 "켜져 있는 회원 공용 모델"이다 — 범위를 넓히려면 부르는 쪽이 명시해야 한다(실수로 새어 나가지 않게).
   * @param {{includeDisabled?: boolean, ownerService?: string|null, includeAllServices?: boolean}} opts
   *   ownerService: 그 서비스 전용 모델 + 공용 모델. includeAllServices: 소유와 무관하게 전부(관리자 화면).
   */
  list({ includeDisabled = false, ownerService = null, includeAllServices = false } = {}) {
    const where = [];
    const params = [];
    if (!includeDisabled) where.push('enabled = 1');
    if (!includeAllServices) {
      const owner = VoiceModels.validateOwnerService(ownerService);
      if (owner === null) where.push('owner_service IS NULL');
      else {
        where.push('(owner_service IS NULL OR owner_service = ?)');
        params.push(owner);
      }
    }
    const rows = this.store.all(
      `SELECT * FROM voice_models ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE, created_at`,
      ...params,
    );
    return rows.map((r) => this.out(r));
  }

  get(id) {
    const row = ID_RE.test(String(id)) ? this.store.get('SELECT * FROM voice_models WHERE id = ?', id) : null;
    if (!row) throw new HttpError(404, '목소리 모델을 찾을 수 없습니다.', 'NOT_FOUND');
    return row;
  }

  /**
   * TTS에서 쓸 때: 켜져 있고, 부르는 쪽에 보이는 모델만. ownerService를 안 주면 회원(공용 모델)으로 본다.
   * 다른 서비스 전용 모델은 '사용 중지'가 아니라 아예 없는 것처럼 404 — 존재 자체를 알리지 않는다.
   */
  getUsable(id, { ownerService = null } = {}) {
    const row = this.get(id);
    const owner = row.owner_service ?? null;
    if (owner !== null && owner !== VoiceModels.validateOwnerService(ownerService)) {
      throw new HttpError(404, '목소리 모델을 찾을 수 없습니다.', 'NOT_FOUND');
    }
    if (!row.enabled) throw new HttpError(400, '사용 중지된 목소리 모델입니다.', 'MODEL_DISABLED');
    return { ...this.out(row), ...this.paths(row.id) };
  }

  /** 관리자 미리 듣기: 공개 범위·사용 여부와 무관하게, 설정 일부를 저장하지 않고 바꿔 본다 */
  getForPreview(id, { indexRate, protect } = {}) {
    const row = this.get(id);
    const m = { ...this.out(row), ...this.paths(row.id) };
    if (indexRate !== undefined) m.indexRate = VoiceModels.validateIndexRate(indexRate);
    if (protect !== undefined) m.protect = VoiceModels.validateProtect(protect);
    return m;
  }

  /**
   * 요청 본문을 메모리에 올리지 않고 바로 파일로 흘려 쓴다(pm2 메모리 한도 512MB 보호).
   * 한도를 넘으면 중단하고 413. 완료되면 임시 파일을 원자적으로 교체.
   */
  async #receive(req, dest, maxBytes, check) {
    // 검사(RVC infer/cli.py)가 확장자를 보므로 임시 파일도 원래 확장자로 끝나게 둔다 → model.<난수>.part.pth
    const ext = path.extname(dest);
    const tmp = `${dest.slice(0, dest.length - ext.length)}.${randomBytes(4).toString('hex')}.part${ext}`;
    try {
      const size = await receiveToFile(req, tmp, maxBytes);
      await check?.(tmp);
      await rename(tmp, dest);
      return size;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** 새 모델 등록 — 본문은 .pth 파일 그대로(application/octet-stream) */
  async create(req, { name, defaultPitch = 0, ownerService = null, indexRate = null, protect = null, actorId, verify }) {
    name = VoiceModels.validateName(name);
    defaultPitch = VoiceModels.validatePitch(defaultPitch);
    indexRate = VoiceModels.validateIndexRate(indexRate);
    protect = VoiceModels.validateProtect(protect);
    const owner = VoiceModels.validateOwnerService(ownerService);
    const id = randomBytes(8).toString('hex');
    const p = this.paths(id);
    mkdirSync(path.dirname(p.pth), { recursive: true, mode: 0o700 });
    try {
      const bytes = await this.#receive(req, p.pth, this.maxModelBytes, async (file) => {
        await assertTorchCheckpoint(file);
        await verify?.(file); // RVC로 실제로 열어 보는 검사 (관리자 업로드라 허용)
      });
      const now = Date.now();
      this.store.run(
        `INSERT INTO voice_models (id, name, default_pitch, index_rate, protect, model_bytes, owner_service, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, name, defaultPitch, indexRate, protect, bytes, owner, actorId ?? null, now, now,
      );
      return this.out(this.get(id));
    } catch (err) {
      await rm(path.dirname(p.pth), { recursive: true, force: true });
      throw err;
    }
  }

  /** .index 파일 추가·교체 (없어도 변환은 되지만 있으면 음색이 더 비슷해진다) */
  async putIndex(id, req) {
    const row = this.get(id);
    const p = this.paths(row.id);
    const bytes = await this.#receive(req, p.index, this.maxIndexBytes);
    this.store.run('UPDATE voice_models SET has_index = 1, index_bytes = ?, updated_at = ? WHERE id = ?', bytes, Date.now(), row.id);
    return this.out(this.get(row.id));
  }

  async removeIndex(id) {
    const row = this.get(id);
    await rm(this.paths(row.id).index, { force: true });
    this.store.run('UPDATE voice_models SET has_index = 0, index_bytes = 0, updated_at = ? WHERE id = ?', Date.now(), row.id);
    return this.out(this.get(row.id));
  }

  update(id, { name, defaultPitch, enabled, ownerService, indexRate, protect }) {
    const row = this.get(id);
    const next = {
      name: name === undefined ? row.name : VoiceModels.validateName(name),
      pitch: defaultPitch === undefined ? row.default_pitch : VoiceModels.validatePitch(defaultPitch),
      enabled: enabled === undefined ? row.enabled : enabled ? 1 : 0,
      owner: ownerService === undefined ? row.owner_service ?? null : VoiceModels.validateOwnerService(ownerService),
      indexRate: indexRate === undefined ? row.index_rate ?? null : VoiceModels.validateIndexRate(indexRate),
      protect: protect === undefined ? row.protect ?? null : VoiceModels.validateProtect(protect),
    };
    // 이름·사용 여부·공개 범위는 결과 음성에 영향이 없어 updated_at(캐시 키)을 건드리지 않는다.
    // index 비율·자음 보호는 결과를 바꾸지만 캐시 키에 따로 들어간다(tts.js)
    this.store.run(
      'UPDATE voice_models SET name = ?, default_pitch = ?, enabled = ?, owner_service = ?, index_rate = ?, protect = ? WHERE id = ?',
      next.name, next.pitch, next.enabled, next.owner, next.indexRate, next.protect, row.id,
    );
    return this.out(this.get(row.id));
  }

  async remove(id) {
    const row = this.get(id);
    this.store.run('DELETE FROM voice_models WHERE id = ?', row.id);
    await rm(this.modelDir(row.id), { recursive: true, force: true });
    return this.out(row);
  }
}

/**
 * 요청 본문을 메모리에 올리지 않고 바로 파일로 흘려 쓴다(pm2 메모리 한도 512MB 보호).
 * 한도를 넘으면 중단하고 413, 비어 있으면 400. 실패해도 file은 지우지 않는다(부르는 쪽 몫).
 */
export async function receiveToFile(req, file, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw tooLarge(maxBytes);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      cb(size > maxBytes ? tooLarge(maxBytes) : null, chunk);
    },
  });
  await pipeline(req, limiter, createWriteStream(file, { mode: 0o600 }));
  if (size === 0) throw new HttpError(400, '파일이 비어 있습니다.', 'EMPTY_FILE');
  return size;
}

/** 서버에 있는 파일을 업로드 요청처럼(헤더 + 읽기 스트림) 감싼다 — create/putIndex에 req 대신 넘긴다 */
export async function fileAsUpload(file) {
  const st = await stat(file);
  if (!st.isFile()) throw new Error(`파일이 아닙니다: ${file}`);
  const stream = createReadStream(file);
  stream.headers = { 'content-length': String(st.size) };
  return stream;
}

function tooLarge(maxBytes) {
  return new HttpError(413, `파일이 너무 큽니다 (최대 ${Math.round(maxBytes / MB)}MB).`, 'FILE_TOO_LARGE');
}

/** torch.save 형식(zip, "PK\x03\x04")인지 앞 4바이트만 확인 — 엉뚱한 파일을 빨리 걸러내는 용도 */
async function assertTorchCheckpoint(file) {
  const fh = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4 || buffer.readUInt32BE(0) !== 0x504b0304) {
      throw new HttpError(400, 'RVC 모델(.pth) 파일이 아닙니다.', 'BAD_MODEL_FILE');
    }
  } finally {
    await fh.close();
  }
}
