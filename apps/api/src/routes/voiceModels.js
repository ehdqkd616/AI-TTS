import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { requireAdmin } from '../services/auth.js';

/**
 * 관리자 전용: RVC 목소리 모델 관리 (/api/admin/voice-models)
 * 파일 업로드는 multipart 대신 본문에 파일을 그대로 싣는다(Content-Type: application/octet-stream).
 * → 별도 의존성 없이 디스크로 바로 흘려 쓸 수 있고, 교차 출처 폼으로는 이 형식을 보낼 수 없다.
 */
export function voiceModelsAdminRouter({ store, voiceModels, rvc, internalAuth = null }) {
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

  // 이름·기본 피치·사용 여부·공개 범위
  router.patch('/:id', (req, res) => {
    const { name, defaultPitch, enabled, ownerService } = req.body ?? {};
    const model = voiceModels.update(req.params.id, { name, defaultPitch, enabled, ownerService });
    audit(req, 'update', model, { name, defaultPitch, enabled, ownerService });
    res.json(model);
  });

  router.delete('/:id', async (req, res) => {
    const model = await voiceModels.remove(req.params.id);
    audit(req, 'delete', model);
    res.json({ ok: true });
  });

  return router;
}
