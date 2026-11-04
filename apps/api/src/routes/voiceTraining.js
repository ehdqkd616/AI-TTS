import { Router } from 'express';
import { HttpError } from '../lib/errors.js';
import { requireAdmin } from '../services/auth.js';
import { STAGES, EPOCH_RANGE, TTS_F0_HZ } from '../services/voiceTraining.js';

/**
 * 관리자 전용: 말하기 목소리 RVC 학습 (/api/admin/voice-trainings)
 * 녹음 파일은 목소리 모델 업로드와 같이 본문에 파일을 그대로 싣는다(application/octet-stream, ?name=원래 파일 이름).
 */
export function voiceTrainingAdminRouter({ store, trainer, internalAuth = null }) {
  const router = Router();
  router.use(requireAdmin);

  const audit = (req, action, job, detail) =>
    store.audit(`admin.voice_training.${action}`, { actorId: req.user.id, targetType: 'voice_training', targetId: job.id, detail: { name: job.name, ...detail }, ip: req.ip });

  router.get('/', (req, res) => {
    res.json({
      enabled: trainer.isEnabled(),
      services: internalAuth?.serviceNames() ?? [],
      stages: STAGES.map(([key, label]) => ({ key, label })),
      epochRange: EPOCH_RANGE,
      ttsF0Hz: TTS_F0_HZ,
      minSeconds: trainer.minSeconds,
      maxSeconds: trainer.maxSeconds,
      maxFileMb: Math.round(trainer.maxFileBytes / 1024 / 1024),
      items: trainer.list(),
    });
  });

  router.post('/', (req, res) => {
    trainer.assertEnabled();
    const { name, ownerService, defaultPitch, epochs } = req.body ?? {};
    const job = trainer.create({ name, ownerService, defaultPitch, epochs, actorId: req.user.id });
    audit(req, 'create', job, { ownerService: job.ownerService, epochs: job.epochs });
    res.status(201).json(job);
  });

  router.patch('/:id', (req, res) => {
    const { name, ownerService, defaultPitch, epochs } = req.body ?? {};
    const job = trainer.update(req.params.id, { name, ownerService, defaultPitch, epochs });
    audit(req, 'update', job, { name, ownerService, defaultPitch, epochs });
    res.json(job);
  });

  // 녹음 추가: PUT /:id/files?name=녹음1.m4a 본문 = 오디오 파일
  router.put('/:id/files', async (req, res) => {
    if (!req.is('application/octet-stream')) {
      throw new HttpError(415, '파일은 application/octet-stream으로 보내야 합니다.', 'UNSUPPORTED_MEDIA_TYPE');
    }
    const job = await trainer.addFile(req.params.id, req, req.query.name);
    audit(req, 'file_add', job, { file: String(req.query.name ?? '').slice(0, 200), seconds: Math.round(job.files.at(-1)?.seconds ?? 0) });
    res.json(job);
  });

  router.delete('/:id/files/:fileId', async (req, res) => {
    const job = await trainer.removeFile(req.params.id, req.params.fileId);
    audit(req, 'file_remove', job, { fileId: Number(req.params.fileId) });
    res.json(job);
  });

  router.post('/:id/start', async (req, res) => {
    const job = await trainer.start(req.params.id);
    audit(req, 'start', job, { resume: job.stagesDone.length > 0, seconds: Math.round(job.datasetSeconds) });
    res.json(job);
  });

  router.post('/:id/cancel', (req, res) => {
    const job = trainer.cancel(req.params.id);
    audit(req, 'cancel', job);
    res.json(job);
  });

  router.delete('/:id', async (req, res) => {
    const job = await trainer.remove(req.params.id);
    audit(req, 'delete', job);
    res.json({ ok: true });
  });

  return router;
}
