import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { requireAdmin } from '../services/auth.js';

/**
 * 관리자 전용: RVC 목소리 모델 관리 (/api/admin/voice-models)
 * 파일 업로드는 multipart 대신 본문에 파일을 그대로 싣는다(Content-Type: application/octet-stream).
 * → 별도 의존성 없이 디스크로 바로 흘려 쓸 수 있고, 교차 출처 폼으로는 이 형식을 보낼 수 없다.
 */
export const PREVIEW_TEXT = '안녕하세요. 오늘은 누구나 쉽게 따라 할 수 있는 습관 세 가지를 알려 드릴게요. 끝까지 보시면 분명히 도움이 될 거예요.';

export function voiceModelsAdminRouter({ store, voiceModels, rvc, internalAuth = null, tts = null, voices = null, paidGuard = null, limits = null }) {
  const router = Router();
  router.use(requireAdmin);

  const needBinary = (req) => {
    if (!req.is('application/octet-stream')) {
      throw new HttpError(415, '파일은 application/octet-stream으로 보내야 합니다.', 'UNSUPPORTED_MEDIA_TYPE');
    }
  };
  const audit = (req, action, model, detail) =>
    store.audit(`admin.voice_model.${action}`, { actorId: req.user.id, targetType: 'voice_model', targetId: model.id, detail: { name: model.name, ...detail }, ip: req.ip });

  router.get('/', (req, res) => {
    res.json({
      rvcEnabled: rvc.isEnabled(),
      defaults: { indexRate: rvc.indexRate, protect: rvc.protect }, // 모델별 값을 비우면 쓰는 서버 기본값
      services: internalAuth?.serviceNames() ?? [], // 전용으로 둘 수 있는 내부 서비스 목록
      items: voiceModels.list({ includeDisabled: true, includeAllServices: true }),
    });
  });

  // 새 모델: POST /?name=...&defaultPitch=...&ownerService=... 본문 = .pth
  router.post('/', async (req, res) => {
    needBinary(req);
    rvc.assertEnabled(); // 업로드 직후 RVC로 열어 보는 검사를 하려면 RVC가 설정돼 있어야 한다
    const model = await voiceModels.create(req, {
      name: req.query.name,
      defaultPitch: req.query.defaultPitch ?? 0,
      ownerService: req.query.ownerService ?? null,
      actorId: req.user.id,
      verify: (file) => rvc.verify(file),
    });
    audit(req, 'create', model, { bytes: model.modelBytes, ownerService: model.ownerService });
    res.status(201).json(model);
  });

  // .index 추가·교체: PUT /:id/index 본문 = .index
  router.put('/:id/index', async (req, res) => {
    needBinary(req);
    const model = await voiceModels.putIndex(req.params.id, req);
    audit(req, 'index', model, { bytes: model.indexBytes });
    res.json(model);
  });

  router.delete('/:id/index', async (req, res) => {
    const model = await voiceModels.removeIndex(req.params.id);
    audit(req, 'index_remove', model);
    res.json(model);
  });

  // 이름·기본 피치·사용 여부·공개 범위·index 비율·자음 보호
  router.patch('/:id', (req, res) => {
    const { name, defaultPitch, enabled, ownerService, indexRate, protect } = req.body ?? {};
    const model = voiceModels.update(req.params.id, { name, defaultPitch, enabled, ownerService, indexRate, protect });
    audit(req, 'update', model, { name, defaultPitch, enabled, ownerService, indexRate, protect });
    res.json(model);
  });

  /**
   * 미리 듣기: 저장하지 않은 피치·index 비율·자음 보호로 한 문장을 만들어 들어 본다.
   * 기본 보이스는 Shorts와 같은 무료 MeloTTS 한국어 — 공개 범위(전용 모델)와 무관하게 관리자는 들을 수 있다.
   */
  router.post('/:id/preview', async (req, res) => {
    if (!tts) throw new HttpError(503, '미리 듣기를 쓸 수 없습니다.', 'PREVIEW_DISABLED');
    rvc.assertEnabled();
    const { text, pitch, indexRate, protect } = req.body ?? {};
    const model = voiceModels.getForPreview(req.params.id, { indexRate, protect });
    const melo = voices?.locales?.['ko-KR']?.voices.find((v) => v.id === 'local:melo/KR');
    const run = () =>
      tts.synthesize(
        {
          text: typeof text === 'string' && text.trim() ? text.slice(0, 300) : PREVIEW_TEXT,
          locale: 'ko-KR',
          voiceId: melo && voices.isActive(melo) ? melo.id : undefined,
          format: 'mp3',
          pitch: pitch ?? undefined,
          userId: req.user.id,
          voiceModelOverride: model,
        },
        paidGuard ? { allowsVoice: (v, n) => paidGuard.allows(v.provider, n), meterCall: (v, n) => paidGuard.meter(v.provider, n) } : {},
      );
    const result = await (limits?.jobs ? limits.jobs.run(run) : run());
    res.json({ audioUrl: result.audioUrl, cached: result.cached, pitch: pitch ?? model.defaultPitch, indexRate: model.indexRate, protect: model.protect });
  });

  router.delete('/:id', async (req, res) => {
    const model = await voiceModels.remove(req.params.id);
    audit(req, 'delete', model);
    res.json({ ok: true });
  });

  return router;
}
