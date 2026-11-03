import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProviders } from './providers/index.js';
import { VoiceCatalog } from './services/voices.js';
import { Store } from './services/store.js';
import { TtsService } from './services/tts.js';
import { RateLimiter, Semaphore, DailyQuota } from './services/limits.js';
import { PaidEngineGuard } from './services/paidGuard.js';
import { Sessions, LoginGuard, ensureAdmin, adminUsernameOf } from './services/auth.js';
import { createMailer } from './services/mailer.js';
import { ttsRouter } from './routes/tts.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { voiceModelsAdminRouter } from './routes/voiceModels.js';
import { VoiceModels } from './services/voiceModels.js';
import { RvcConverter } from './services/rvc.js';
import { securityHeaders, csrfGuard } from './lib/securityHeaders.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createApp({ env = process.env, storageDir, logger = console, mailer } = {}) {
  const providers = createProviders(env);
  const voices = new VoiceCatalog(providers, env.VOICES_CONFIG || undefined);
  const storageRoot = storageDir ?? (env.STORAGE_DIR || path.join(here, '..', 'storage'));
  const store = new Store(storageRoot);
  await ensureAdmin(store, env, logger);
  const mb = (v, d) => (Number(v) > 0 ? Number(v) : d) * 1024 * 1024;
  const voiceModels = new VoiceModels(store, path.join(storageRoot, 'voice-models'), {
    maxModelBytes: mb(env.VOICE_MODEL_MAX_MB, 300),
    maxIndexBytes: mb(env.VOICE_INDEX_MAX_MB, 1024),
  });
  const rvc = new RvcConverter(env, { logger });
  const tts = new TtsService({
    providers,
    voices,
    store,
    voiceModels,
    rvc,
    logger,
    maxTextLength: Number(env.MAX_TEXT_LENGTH) || 5000,
  });

  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const limits = {
    synth: new RateLimiter({ limit: num(env.RATE_LIMIT_PER_MIN, 10) }),
    light: new RateLimiter({ limit: num(env.LIGHT_RATE_LIMIT_PER_MIN, 120) }),
    login: new RateLimiter({ limit: 30 }),
    signup: new RateLimiter({ limit: num(env.SIGNUP_LIMIT_PER_HOUR, 10), windowMs: 3_600_000 }),
    jobs: new Semaphore(num(env.MAX_CONCURRENT_JOBS, 3)),
    quota: new DailyQuota(store, {
      perUser: num(env.DAILY_CHAR_LIMIT_PER_USER, 20_000),
      global: num(env.DAILY_CHAR_LIMIT_GLOBAL, 200_000),
    }),
  };
  const sessions = new Sessions(store, { days: num(env.SESSION_DAYS, 7) });
  const loginGuard = new LoginGuard({ maxFailures: 5, lockMinutes: 15 });
  mailer ??= createMailer(env, logger);
  // 상용 엔진 자동 결제 방지: Google Chirp 3 HD 무료 사용량 월 100만 자 기준
  //   일 3만 자(31일 × 3만 = 93만), 월 90만 자(10% 여유 — 서버 시간과 Google 청구 기준 시간대 차이 포함)
  //   .env 값을 잘못 넣어도(예: 0 하나 더) 무료 사용량을 넘지 못하게 코드에서 상한을 고정한다
  const PAID_MONTHLY_HARD_CAP = 950_000;
  const monthly = Math.min(num(env.PAID_ENGINE_MONTHLY_CHAR_LIMIT, 900_000), PAID_MONTHLY_HARD_CAP);
  const daily = Math.min(num(env.PAID_ENGINE_DAILY_CHAR_LIMIT, 30_000), monthly);
  if (monthly < num(env.PAID_ENGINE_MONTHLY_CHAR_LIMIT, 0)) {
    logger.warn?.(`PAID_ENGINE_MONTHLY_CHAR_LIMIT가 무료 사용량 기준 상한을 넘어 ${PAID_MONTHLY_HARD_CAP.toLocaleString()}자로 고정합니다.`);
  }
  const paidGuard = new PaidEngineGuard(store, { daily, monthly, mailer, logger });

  const app = express();
  app.disable('x-powered-by');
  // Caddy(같은 호스트)만 신뢰 → req.ip가 실제 클라이언트 IP, req.secure는 HTTPS 여부
  app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.use('/api', csrfGuard);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', sessions.load);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter({ store, sessions, loginGuard, limits, mailer, logger, adminUsername: adminUsernameOf(env) }));
  app.use('/api/admin/voice-models', voiceModelsAdminRouter({ store, voiceModels, rvc }));
  app.use('/api/admin', adminRouter({ store, sessions, limits, paidGuard, adminUsername: adminUsernameOf(env) }));
  app.use('/api', ttsRouter({ tts, voices, store, limits, paidGuard, voiceModels, rvc }));

  // 프로덕션: 빌드된 React 앱 서빙
  const webDist = path.join(here, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  app.use((err, req, res, next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) logger.error(err);
    if (status === 429 || status === 503) logger.warn?.(`${status} ${err.code} ${req.ip} ${req.path}`);
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    res.status(status).json({
      error: {
        code: err.code ?? 'INTERNAL',
        message: status >= 500 && !err.code ? '서버 오류가 발생했습니다.' : err.message,
        ...(err.reason ? { reason: err.reason } : {}),
      },
    });
  });

  return { app, providers, voices, store, tts, limits, sessions, loginGuard, paidGuard, voiceModels, rvc };
}
