import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { HttpError } from '../lib/errors.js';
import { requireService } from '../services/internal.js';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * 서버 내부 전용 API (/api/internal/v1). 서비스 토큰이 있는 요청만 — 그 밖에는 존재하지 않는 것처럼 404.
 * 외부에서는 Caddy가 /api/internal/*을 막는다.
 */
export function internalRouter({ tts, voices, voiceModels, rvc, limits, paidGuard, store }) {
  const router = Router();
  router.use(requireService);

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'ai-tts',
      version: pkg.version ?? '0.0.0',
      caller: req.service,
      features: { narrations: true, rvc: rvc.isEnabled() },
      providers: [...tts.providers.values()].map((p) => ({ name: p.name, enabled: p.isEnabled() })),
      usage: limits.quota.usageOf(req.user),
    });
  });

  router.get('/catalog', (req, res) => {
    res.json({
      locales: voices.list(),
      rvcEnabled: rvc.isEnabled(),
      voiceModels: rvc.isEnabled()
        ? voiceModels.list().map(({ id, name, defaultPitch, hasIndex, updatedAt }) => ({ id, name, defaultPitch, hasIndex, updatedAt }))
        : [],
      maxTextLength: tts.maxTextLength,
    });
  });

  router.post('/narrations', async (req, res) => {
    const { segments, locale, voiceId, speed, gapMs, voiceModelId, pitch } = req.body ?? {};
    const result = await limits.jobs.run(() =>
      tts.synthesizeNarration(
        {
          segments,
          locale: locale || undefined,
          voiceId: voiceId || undefined,
          speed: speed == null ? 1 : Number(speed),
          gapMs: gapMs == null ? 250 : Number(gapMs),
          voiceModelId: voiceModelId || undefined,
          pitch: pitch ?? undefined,
          userId: null,
        },
        {
          beforeEngine: (chars) => limits.quota.assertAvailable(req.user, chars),
          allowsVoice: (voice, chars) => paidGuard.allows(voice.provider, chars),
          meterCall: (voice, chars) => paidGuard.meter(voice.provider, chars),
        },
      ),
    );
    if (!result.cached) limits.quota.record(req.user, result.charCount);
    store.audit('internal.narration', {
      targetType: 'generation', targetId: result.id,
      detail: { service: req.service, segments: segments.length, chars: result.charCount, cached: result.cached, voiceModel: result.voiceModel?.id ?? null },
      ip: req.ip,
    });
    const { audioFile, ...rest } = result;
    res.json({ ...rest, audioUrl: `/api/internal/v1/narrations/${audioFile}` });
  });

  router.get('/narrations/:file', async (req, res) => {
    const m = /^([0-9a-f]{64})\.wav$/.exec(req.params.file);
    if (!m) throw new HttpError(404, 'not found', 'NOT_FOUND');
    const audio = await store.getAudio(m[1], 'wav');
    if (!audio) throw new HttpError(404, '파일이 없습니다.', 'NOT_FOUND');
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=86400' });
    res.send(audio);
  });

  return router;
}
