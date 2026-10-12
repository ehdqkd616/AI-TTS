import { mkdirSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const cacheKeyOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

export const USER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

/**
 * 음성 파일 캐시(파일시스템) + 회원·세션·생성 이력·사용량·감사 로그(SQLite).
 * 운영 규모가 커지면 오브젝트 스토리지(S3/R2) + MySQL/PostgreSQL로 교체한다.
 */
export class Store {
  constructor(dir) {
    this.audioDir = path.join(dir, 'audio');
    mkdirSync(this.audioDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, 'tts.sqlite'));
    // 이메일 가입 시절 DB: 컬럼 이름만 바꾸고 값(기존 아이디)은 그대로 둔다
    const userCols = this.db.prepare("SELECT name FROM pragma_table_info('users')").all().map((c) => c.name);
    if (userCols.includes('email') && !userCols.includes('username')) this.db.exec('ALTER TABLE users RENAME COLUMN email TO username');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS users (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        username         TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- 로그인 아이디 (예전 가입자는 이메일 형태 그대로)
        name             TEXT NOT NULL,
        pw_hash          TEXT NOT NULL,
        role             TEXT NOT NULL DEFAULT 'user',      -- user / admin
        status           TEXT NOT NULL DEFAULT 'pending',   -- pending / approved / rejected / suspended
        signup_note      TEXT,
        reject_reason    TEXT,
        daily_char_limit INTEGER,                           -- NULL이면 기본값(DAILY_CHAR_LIMIT_PER_USER)
        approved_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        approved_at      INTEGER,
        last_login_at    INTEGER,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_status ON users (status, id);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash  CHAR(64) PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_agent  TEXT,
        ip          TEXT,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action      TEXT NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        detail      TEXT,
        ip          TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (id);

      CREATE TABLE IF NOT EXISTS generations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        input_text  TEXT NOT NULL,
        normalized  TEXT NOT NULL,
        locale      TEXT NOT NULL,
        voice_id    TEXT NOT NULL,
        provider    TEXT NOT NULL,
        speed       REAL NOT NULL,
        format      TEXT NOT NULL,
        char_count  INTEGER NOT NULL,
        cache_key   CHAR(64) NOT NULL,
        cached      INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL,
        error       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_generations_created ON generations (created_at);
      CREATE INDEX IF NOT EXISTS idx_generations_cache ON generations (cache_key);

      CREATE TABLE IF NOT EXISTS usage_daily (
        subject     TEXT NOT NULL,
        usage_date  TEXT NOT NULL,
        chars_used  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (subject, usage_date)
      );
    `);
    // 회원 기능 이전 DB 마이그레이션
    const cols = this.db.prepare('PRAGMA table_info(generations)').all().map((c) => c.name);
    if (!cols.includes('user_id')) this.db.exec('ALTER TABLE generations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_generations_user ON generations (user_id, id)');
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── 음성 파일 ─────────────────────────────────────────

  audioPath(key, format) {
    if (!/^[0-9a-f]{64}$/.test(key) || !/^[a-z0-9]+$/.test(format)) return null;
    return path.join(this.audioDir, `${key}.${format}`);
  }

  async getAudio(key, format) {
    try {
      return await readFile(this.audioPath(key, format));
    } catch {
      return null;
    }
  }

  async putAudio(key, format, buffer) {
    const file = this.audioPath(key, format);
    await writeFile(`${file}.tmp`, buffer);
    await rename(`${file}.tmp`, file); // 원자적 교체: 반쯤 쓴 파일이 캐시로 읽히지 않도록
  }

  // ── 생성 이력 ─────────────────────────────────────────

  addGeneration(g) {
    const { lastInsertRowid } = this.run(
      `INSERT INTO generations (user_id, input_text, normalized, locale, voice_id, provider, speed, format, char_count, cache_key, cached, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.userId ?? null, g.text, g.normalized, g.locale, g.voiceId, g.provider, g.speed, g.format, g.charCount, g.cacheKey,
      g.cached ? 1 : 0, g.status, g.error ?? null,
    );
    return Number(lastInsertRowid);
  }

  /** 본인 이력만 — 다른 회원의 입력 텍스트가 노출되지 않도록 */
  listGenerations(userId, limit = 50) {
    return this.all(
      `SELECT id, input_text, locale, voice_id, provider, speed, format, char_count, cache_key, cached, status, error, created_at
       FROM generations WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      userId, limit,
    );
  }

  /** 이 음성 파일을 만든(또는 캐시로 받은) 적이 있는 회원인지 */
  ownsAudio(userId, cacheKey) {
    return Boolean(this.get(`SELECT 1 FROM generations WHERE user_id = ? AND cache_key = ? AND status = 'done' LIMIT 1`, userId, cacheKey));
  }

  // ── 사용량 ───────────────────────────────────────────

  getUsage(subject) {
    return this.get(`SELECT chars_used FROM usage_daily WHERE subject = ? AND usage_date = date('now', 'localtime')`, subject)?.chars_used ?? 0;
  }

  addUsage(subject, chars) {
    this.run(
      `INSERT INTO usage_daily (subject, usage_date, chars_used) VALUES (?, date('now', 'localtime'), ?)
       ON CONFLICT (subject, usage_date) DO UPDATE SET chars_used = chars_used + excluded.chars_used`,
      subject, chars,
    );
  }

  // ── 감사 로그 ─────────────────────────────────────────

  audit(action, { actorId = null, targetType = null, targetId = null, detail = null, ip = null } = {}) {
    this.run(
      'INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      actorId, action, targetType, targetId == null ? null : String(targetId), detail ? JSON.stringify(detail) : null, ip, Date.now(),
    );
  }
}
