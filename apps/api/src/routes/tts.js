import { Router } from 'express';
import { FORMATS } from '../pipeline/mergeAudio.js';
import { HttpError } from '../lib/errors.js';
import { requireUser } from '../services/auth.js';

export function ttsRouter({ tts, voices, store, limits }) {
  const router = Router();
  // 음성 생성 기능은 승인된 회원만
  router.use(requireUser);
  const rateLimit = (limiter) => (req, res, next) => {
    limiter.check(`user:${req.user.id}`);
    next();
  };

  router.get('/config', (req, res) => {
    res.json({
      maxTextLength: tts.maxTextLength,
      providers: [...tts.providers.values()].map((p) => ({ name: p.name, enabled: p.isEnabled() })),
    });
  });

  router.get('/voices', (req, res) => {
    res.json({ locales: voices.list() });
  });

  router.post('/detect', rateLimit(limits.light), (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== 'string') throw new HttpError(400, 'text가 필요합니다.', 'EMPTY_TEXT');
    res.json(tts.detect(text));
  });

  router.post('/normalize', rateLimit(limits.light), (req, res) => {
    const { text, locale } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '텍스트를 입력하세요.', 'EMPTY_TEXT');
    res.json(tts.preview({ text, locale: locale || undefined }));
  });

  router.post('/tts', rateLimit(limits.synth), async (req, res) => {
    const { text, locale, voiceId, speed, format, normalizedText } = req.body ?? {};
    const result = await limits.jobs.run(() =>
      tts.synthesize(
        {
          text,
          locale: locale || undefined,
          voiceId: voiceId || undefined,
          speed: speed == null ? 1 : Number(speed),
          format: format || 'mp3',
          normalizedText: normalizedText ?? undefined,
          userId: req.user.id,
        },
        // 비용 보호: 캐시에 없어 엔진을 실제로 부를 때만 일일 한도 검사
        { beforeEngine: (chars) => limits.quota.assertAvailable(req.user, chars) },
      ),
    );
    if (!result.cached) limits.quota.record(req.user, result.charCount);
    res.json(result);
  });

  router.get('/audio/:file', async (req, res) => {
    const m = /^([0-9a-f]{64})\.([a-z0-9]+)$/.exec(req.params.file);
    if (!m || !FORMATS[m[2]]) throw new HttpError(404, 'not found', 'NOT_FOUND');
    // 본인이 만든 음성만 (관리자는 전체)
    if (req.user.role !== 'admin' && !store.ownsAudio(req.user.id, m[1])) throw new HttpError(404, '파일이 없습니다.', 'NOT_FOUND');
    const audio = await store.getAudio(m[1], m[2]);
    if (!audio) throw new HttpError(404, '파일이 없습니다.', 'NOT_FOUND');
    res.set('Content-Type', FORMATS[m[2]].mime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable'); // 키가 내용 해시라 불변
    if (req.query.download) res.attachment(`tts-${m[1].slice(0, 8)}.${m[2]}`);
    res.send(audio);
  });

  router.get('/history', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({
      items: store.listGenerations(req.user.id, limit).map((g) => ({
        id: g.id,
        text: g.input_text,
        locale: g.locale,
        voiceId: g.voice_id,
        provider: g.provider,
        speed: g.speed,
        format: g.format,
        charCount: g.char_count,
        cached: Boolean(g.cached),
        status: g.status,
        createdAt: g.created_at,
        audioUrl: g.status === 'done' ? `/api/audio/${g.cache_key}.${g.format}` : null,
      })),
    });
  });

  return router;
}
