import { createWriteStream, mkdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
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
        updated_at    INTEGER NOT NULL           -- 파일이 바뀌면 갱신 → 캐시 키에 포함
      );
    `);
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
      defaultPitch: row.default_pitch,
      hasIndex: Boolean(row.has_index),
      enabled: Boolean(row.enabled),
      modelBytes: row.model_bytes,
      indexBytes: row.index_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list({ includeDisabled = false } = {}) {
    const rows = this.store.all(
      `SELECT * FROM voice_models ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY name COLLATE NOCASE, created_at`,
    );
    return rows.map((r) => this.out(r));
  }

  get(id) {
    const row = ID_RE.test(String(id)) ? this.store.get('SELECT * FROM voice_models WHERE id = ?', id) : null;
    if (!row) throw new HttpError(404, '목소리 모델을 찾을 수 없습니다.', 'NOT_FOUND');
    return row;
  }

  /** 회원이 TTS에서 쓸 때: 켜져 있는 모델만 */
  getUsable(id) {
    const row = this.get(id);
    if (!row.enabled) throw new HttpError(400, '사용 중지된 목소리 모델입니다.', 'MODEL_DISABLED');
    return { ...this.out(row), ...this.paths(row.id) };
  }

  /**
   * 요청 본문을 메모리에 올리지 않고 바로 파일로 흘려 쓴다(pm2 메모리 한도 512MB 보호).
   * 한도를 넘으면 중단하고 413. 완료되면 임시 파일을 원자적으로 교체.
   */
  async #receive(req, dest, maxBytes, check) {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) throw tooLarge(maxBytes);
    // 검사(RVC infer/cli.py)가 확장자를 보므로 임시 파일도 원래 확장자로 끝나게 둔다 → model.<난수>.part.pth
    const ext = path.extname(dest);
    const tmp = `${dest.slice(0, dest.length - ext.length)}.${randomBytes(4).toString('hex')}.part${ext}`;
    let size = 0;
    const limiter = new Transform({
      transform(chunk, enc, cb) {
        size += chunk.length;
        cb(size > maxBytes ? tooLarge(maxBytes) : null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, createWriteStream(tmp, { mode: 0o600 }));
      if (size === 0) throw new HttpError(400, '파일이 비어 있습니다.', 'EMPTY_FILE');
      await check?.(tmp);
      await rename(tmp, dest);
      return size;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** 새 모델 등록 — 본문은 .pth 파일 그대로(application/octet-stream) */
  async create(req, { name, defaultPitch = 0, actorId, verify }) {
    name = VoiceModels.validateName(name);
    defaultPitch = VoiceModels.validatePitch(defaultPitch);
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
        `INSERT INTO voice_models (id, name, default_pitch, model_bytes, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, name, defaultPitch, bytes, actorId ?? null, now, now,
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

  update(id, { name, defaultPitch, enabled }) {
    const row = this.get(id);
    const next = {
      name: name === undefined ? row.name : VoiceModels.validateName(name),
      pitch: defaultPitch === undefined ? row.default_pitch : VoiceModels.validatePitch(defaultPitch),
      enabled: enabled === undefined ? row.enabled : enabled ? 1 : 0,
    };
    // 이름·사용 여부는 결과 음성에 영향이 없어 updated_at(캐시 키)을 건드리지 않는다
    this.store.run('UPDATE voice_models SET name = ?, default_pitch = ?, enabled = ? WHERE id = ?', next.name, next.pitch, next.enabled, row.id);
    return this.out(this.get(row.id));
  }

  async remove(id) {
    const row = this.get(id);
    this.store.run('DELETE FROM voice_models WHERE id = ?', row.id);
    await rm(this.modelDir(row.id), { recursive: true, force: true });
    return this.out(row);
  }
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
