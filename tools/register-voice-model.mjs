#!/usr/bin/env node
/**
 * 서버에 이미 있는 RVC 모델 파일(.pth / .index)을 AI-TTS 목소리 모델 보관소에 등록한다.
 *
 * 관리자 화면 업로드와 같은 경로(services/voiceModels.js)를 쓰므로 검사·감사 기록·공개 범위가 모두 동일하다.
 * 수십~수백 MB 파일을 브라우저로 올리지 않아도 되는 점만 다르다.
 *
 *   cd apps/api
 *   node --env-file=.env ../../tools/register-voice-model.mjs \
 *     --name '루디 목소리' --owner shorts --pitch -8 \
 *     --pth   /경로/rudy-master_e10000_s740000.pth \
 *     --index /경로/added_IVF256_Flat_nprobe_1_rudy-master2_v2.index
 *
 * --owner 를 비우면 AI-TTS 회원 모두가 쓸 수 있는 공용 모델이 된다.
 * 등록 뒤 pm2 재시작은 필요 없다(파일·DB만 보고 쓴다).
 */
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../apps/api/src/services/store.js';
import { VoiceModels } from '../apps/api/src/services/voiceModels.js';
import { RvcConverter } from '../apps/api/src/services/rvc.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const die = (msg) => {
  console.error(`오류: ${msg}`);
  process.exit(1);
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) die(`알 수 없는 인자: ${argv[i]}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(`--${m[1]} 값이 없습니다.`);
    out[m[1]] = v;
    i += 1;
  }
  return out;
}

/** voiceModels가 기대하는 모양(헤더 + 읽기 스트림)으로 파일을 감싼다 — 라우트의 req 대신 */
async function fileAsRequest(file) {
  const st = await stat(file).catch(() => die(`파일이 없습니다: ${file}`));
  if (!st.isFile()) die(`파일이 아닙니다: ${file}`);
  const stream = createReadStream(file);
  stream.headers = { 'content-length': String(st.size) };
  return stream;
}

const args = parseArgs(process.argv.slice(2));
if (!args.pth || !args.name) die('--pth 와 --name 은 필수입니다. (--index, --owner, --pitch 는 선택)');

const env = process.env;
const storageRoot = env.STORAGE_DIR || path.join(here, '..', 'apps', 'api', 'storage');
const mb = (v, d) => (Number(v) > 0 ? Number(v) : d) * 1024 * 1024;

const store = new Store(storageRoot);
const voiceModels = new VoiceModels(store, path.join(storageRoot, 'voice-models'), {
  maxModelBytes: mb(env.VOICE_MODEL_MAX_MB, 300),
  maxIndexBytes: mb(env.VOICE_INDEX_MAX_MB, 1024),
});
const rvc = new RvcConverter(env, { logger: console });
if (!rvc.isEnabled()) die(`RVC가 설정되지 않았습니다. apps/api/.env의 RVC_ROOT를 확인하세요. (현재: ${env.RVC_ROOT || '(비어 있음)'})`);

console.log(`.pth 복사·검사: ${args.pth}`);
const model = await voiceModels.create(await fileAsRequest(args.pth), {
  name: args.name,
  defaultPitch: args.pitch ?? 0,
  ownerService: args.owner ?? null,
  actorId: null,
  verify: (file) => rvc.verify(file),
});
store.audit('admin.voice_model.create', {
  targetType: 'voice_model',
  targetId: model.id,
  detail: { name: model.name, bytes: model.modelBytes, ownerService: model.ownerService, via: 'tools/register-voice-model' },
});

if (args.index) {
  console.log(`.index 복사: ${args.index}`);
  Object.assign(model, await voiceModels.putIndex(model.id, await fileAsRequest(args.index)));
  store.audit('admin.voice_model.index', {
    targetType: 'voice_model',
    targetId: model.id,
    detail: { name: model.name, bytes: model.indexBytes, via: 'tools/register-voice-model' },
  });
}

console.log('\n등록 완료');
console.log(`  id            ${model.id}`);
console.log(`  이름          ${model.name}`);
console.log(`  쓰는 곳       ${model.ownerService ? `${model.ownerService} 전용 (회원 화면에는 숨김)` : '회원 공용'}`);
console.log(`  기본 피치     ${model.defaultPitch}`);
console.log(`  .pth/.index   ${model.modelBytes} / ${model.hasIndex ? model.indexBytes : '없음'} bytes`);
console.log(`  파일 위치     ${voiceModels.modelDir(model.id)}`);
