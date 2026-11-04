import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from './format.js';
import { SCRIPT, SCRIPT_TIPS, estimateSec, scriptAsText } from './voiceScript.js';

const STATUS = {
  draft: ['녹음 준비', ''],
  queued: ['대기 중', ''],
  running: ['학습 중', 'ok'],
  done: ['완료', 'ok'],
  failed: ['실패', 'warn'],
  canceled: ['중지됨', 'warn'],
};

const fmtLen = (sec) => {
  const s = Math.round(sec);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초` : `${s}초`;
};
const fmtEta = (sec) => {
  if (sec == null) return '';
  if (sec < 90) return '1분 안쪽';
  const m = Math.round(sec / 60);
  return m >= 60 ? `약 ${Math.floor(m / 60)}시간 ${m % 60}분` : `약 ${m}분`;
};

/** 관리자 → 목소리 학습: 낭독 녹음으로 RVC 모델을 학습해 목소리 모델로 등록 */
export default function VoiceTraining({ onGoModels }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.admin.trainings().then(setData, (e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  // 학습 중이면 몇 초마다 진행 상황 갱신
  const active = data?.items.some((j) => j.status === 'running' || j.status === 'queued');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [active, load]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="empty">불러오는 중…</p>;
  return (
    <>
      {!data.enabled && (
        <div className="banner warn">
          목소리 학습을 쓰려면 <code>apps/api/.env</code>에 <code>RVC_ROOT</code>(RVC WebUI 폴더, <code>train/train.py</code>가 있는 곳)를 지정하고 재시작하세요.
        </div>
      )}
      <Guide data={data} />
      <NewTraining data={data} onCreated={load} />
      <section className="card">
        <h2>학습 목록</h2>
        {data.items.length === 0 ? <p className="empty">아직 학습이 없습니다.</p> : (
          <ul className="vm-list">
            {data.items.map((j) => (
              <TrainingRow key={j.id} j={j} data={data} reload={load} onGoModels={onGoModels} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Guide({ data }) {
  const total = SCRIPT.reduce((n, s) => n + estimateSec(s.text), 0);
  function download() {
    const url = URL.createObjectURL(new Blob([scriptAsText()], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: '목소리-학습-낭독-대본.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="card">
      <h2>말하기 목소리로 학습하기</h2>
      <p className="muted small">
        노래로 학습한 모델은 말소리 위에 노래 발성(길게 끄는 모음)을 덮어서 발음이 뭉개집니다.
        <b>또박또박 읽은 낭독 녹음</b>으로 학습하면 음색은 그대로 두고 TTS의 정확한 발음을 살릴 수 있습니다.
        학습이 끝나면 <b>목소리 모델</b> 탭에 자동으로 등록됩니다(피치는 녹음한 목소리 높이로 자동, index 비율은 발음 우선 0.3).
      </p>
      <p className="small">
        <b>낭독 대본</b> — 받침·겹받침·소리가 바뀌는 말·이중모음·된소리·숫자·외래어와 쇼츠 내레이션 말투를 골고루 담은 13개 섹션, 약 {Math.round(total / 60)}분.
        학습 목록의 <b>대본 보며 녹음</b>을 누르면 섹션별로 바로 녹음해 올릴 수 있고, 휴대폰으로 따로 녹음하려면{' '}
        <button className="link" onClick={download}>대본을 텍스트로 내려받으세요</button>.
      </p>
      <ul className="small guide">
        {SCRIPT_TIPS.map((t) => (
          <li key={t}>{t}</li>
        ))}
        <li>
          분량은 대본 전체(약 30분)를 권장합니다. 최소 {Math.round(data.minSeconds / 60)}분, 최대 {Math.round(data.maxSeconds / 60)}분, 파일 하나당 {data.maxFileMb}MB까지.
        </li>
        <li>
          학습은 오래 걸립니다 — 이 서버 GPU 기준 30분 녹음이면 약 7~8시간. 밤에 돌려 두세요. 그동안 목소리 변환은 CPU로 처리되어 평소보다 느려집니다.
        </li>
      </ul>
    </section>
  );
}

function NewTraining({ data, onCreated }) {
  // 피치·에포크는 기본 자동(null) — 피치는 녹음 음높이로, 에포크는 녹음 길이로 서버가 정한다
  const empty = { name: '', ownerService: data.services[0] ?? '', defaultPitch: null, epochs: null };
  const [form, setForm] = useState(empty);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.admin.createTraining(form);
      setForm(empty);
      onCreated();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  const autoPitch = form.defaultPitch === null;
  const autoEpochs = form.epochs === null;
  return (
    <section className="card">
      <h2>새 학습 만들기</h2>
      <form className="vm-form" onSubmit={submit}>
        <label>
          <span>등록될 모델 이름</span>
          <input value={form.name} maxLength={40} required onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예) 루디 말하기" />
        </label>
        <label>
          <span>쓰는 곳 (본인 목소리는 서비스 전용 권장)</span>
          <select value={form.ownerService} onChange={(e) => setForm({ ...form, ownerService: e.target.value })}>
            <option value="">회원 공용 (음성 생성 화면에 노출)</option>
            {data.services.map((s) => (
              <option key={s} value={s}>{s} 전용 (회원에게 숨김)</option>
            ))}
          </select>
        </label>
        <div className="vm-field">
          <label className="check">
            <input type="checkbox" checked={autoPitch} onChange={(e) => setForm({ ...form, defaultPitch: e.target.checked ? null : -8 })} />
            <span>기본 피치 자동 (추천) — 녹음한 목소리 높이를 재서 MeloTTS({data.ttsF0Hz}Hz)와의 차이만큼</span>
          </label>
          {!autoPitch && (
            <label>
              <span>기본 피치 {form.defaultPitch > 0 ? `+${form.defaultPitch}` : form.defaultPitch}</span>
              <input type="range" min="-24" max="24" step="1" value={form.defaultPitch} onChange={(e) => setForm({ ...form, defaultPitch: Number(e.target.value) })} />
            </label>
          )}
        </div>
        <div className="vm-field">
          <label className="check">
            <input type="checkbox" checked={autoEpochs} onChange={(e) => setForm({ ...form, epochs: e.target.checked ? null : 60 })} />
            <span>에포크 자동 (추천) — 녹음 길이에 맞춰(30분이면 약 60)</span>
          </label>
          {!autoEpochs && (
            <label>
              <span>에포크</span>
              <input type="number" min={data.epochRange[0]} max={data.epochRange[1]} step="10" value={form.epochs} onChange={(e) => setForm({ ...form, epochs: Number(e.target.value) })} />
            </label>
          )}
        </div>
        <button className="primary" disabled={busy || !data.enabled}>만들기 (다음에 녹음을 올립니다)</button>
      </form>
      {err && <div className="banner error">{err}</div>}
    </section>
  );
}

/** 섹션 녹음 파일 이름 — 학습 목록에서 어느 섹션을 녹음했는지 알아보는 데 쓴다 */
const sectionFileName = (s, ext) => `대본 ${String(s.id).padStart(2, '0')} ${s.title}.${ext}`;
const sectionPrefix = (s) => `대본 ${String(s.id).padStart(2, '0')} `;

/**
 * 대본 보며 녹음: 섹션을 띄워 두고 브라우저 마이크로 녹음 → 들어 보고 → 올리기.
 * 브라우저의 잡음 제거·자동 음량·에코 제거는 목소리를 바꿔 버리므로 끈다.
 */
function ScriptRecorder({ job, onUploaded, setProgress, disabled }) {
  const recorded = new Set(SCRIPT.filter((s) => job.files.some((f) => f.name.startsWith(sectionPrefix(s)))).map((s) => s.id));
  const [current, setCurrent] = useState(() => SCRIPT.find((s) => !recorded.has(s.id))?.id ?? 1);
  const [rec, setRec] = useState(null); // { recorder, stream, chunks, started }
  const [take, setTake] = useState(null); // { blob, url, seconds, ext }
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState('');
  const section = SCRIPT.find((s) => s.id === current);

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setElapsed((Date.now() - rec.started) / 1000), 250);
    return () => clearInterval(t);
  }, [rec]);
  useEffect(() => () => rec?.stream.getTracks().forEach((t) => t.stop()), [rec]);

  async function start() {
    setErr('');
    discard();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
      const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 128000 });
      const chunks = [];
      const started = Date.now();
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = recorder.mimeType || type || 'audio/webm';
        const blob = new Blob(chunks, { type: mime });
        setTake({ blob, url: URL.createObjectURL(blob), seconds: (Date.now() - started) / 1000, ext: mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm' });
        setRec(null);
      };
      recorder.start(1000);
      setElapsed(0);
      setRec({ recorder, stream, chunks, started });
    } catch (e) {
      setErr(e.name === 'NotAllowedError' ? '마이크 사용이 허용되지 않았습니다. 브라우저 주소창의 권한 설정에서 마이크를 허용하세요.' : `녹음을 시작하지 못했습니다: ${e.message}`);
    }
  }

  function discard() {
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
  }

  async function uploadTake() {
    setErr('');
    const file = new File([take.blob], sectionFileName(section, take.ext), { type: take.blob.type });
    try {
      setProgress({ label: file.name, ratio: 0 });
      await api.admin.uploadTrainingFile(job.id, file, (r) => setProgress({ label: r >= 1 ? `${file.name} 변환 중` : file.name, ratio: r }));
      discard();
      const next = SCRIPT.find((s) => s.id > current && !recorded.has(s.id)) ?? SCRIPT.find((s) => s.id !== current && !recorded.has(s.id));
      if (next) setCurrent(next.id);
      onUploaded();
    } catch (e) {
      setErr(e.message);
    } finally {
      setProgress(null);
    }
  }

  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  return (
    <div className="recorder">
      <div className="chips">
        {SCRIPT.map((s) => (
          <button key={s.id} type="button" disabled={Boolean(rec)} className={`chip ${s.id === current ? 'on' : ''}`} onClick={() => (discard(), setCurrent(s.id))}>
            {recorded.has(s.id) ? '✓ ' : ''}
            {String(s.id).padStart(2, '0')} {s.title}
          </button>
        ))}
      </div>
      <div className="rec-head">
        <b>{String(section.id).padStart(2, '0')}. {section.title}</b>
        <span className="muted small">약 {Math.max(1, Math.round(estimateSec(section.text) / 60))}분 · {section.goal}</span>
        {recorded.has(section.id) && <span className="tag ok">녹음함 (다시 녹음하면 새 파일로 추가 — 이전 파일은 아래 목록에서 삭제)</span>}
      </div>
      <div className="script-text">{section.text}</div>
      <div className="inline rec-actions">
        {rec ? (
          <button className="danger" onClick={() => rec.recorder.stop()}>■ 녹음 끝 ({mmss(elapsed)})</button>
        ) : (
          <button className="primary" disabled={disabled} onClick={start}>● {take ? '다시 녹음' : '녹음 시작'}</button>
        )}
        {take && !rec && (
          <>
            <audio controls src={take.url} />
            <button className="primary" disabled={disabled} onClick={uploadTake}>이 녹음 올리기 ({mmss(take.seconds)})</button>
            <button onClick={discard}>버리기</button>
          </>
        )}
      </div>
      {rec && <p className="muted small">녹음 중 — 대본을 끝까지 읽은 뒤 '녹음 끝'을 누르세요. 틀려도 멈추지 말고 그 문장만 다시 읽으면 됩니다.</p>}
      {err && <div className="banner error small">{err}</div>}
      <p className="muted small">녹음한 섹션 {recorded.size}/{SCRIPT.length}</p>
    </div>
  );
}

function TrainingRow({ j, data, reload, onGoModels }) {
  const [progress, setProgress] = useState(null); // 업로드 { label, ratio }
  const [err, setErr] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [recording, setRecording] = useState(j.files.length === 0 && j.status === 'draft');
  const busy = j.status === 'running' || j.status === 'queued';
  const editable = !busy && !progress;
  const [label, tone] = STATUS[j.status] ?? [j.status, ''];
  const stageLabel = data.stages.find((s) => s.key === j.stage)?.label;
  const enough = j.datasetSeconds >= data.minSeconds;
  const resumable = (j.status === 'failed' || j.status === 'canceled') && j.stagesDone.length > 0;

  async function act(fn) {
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setProgress(null);
      reload();
    }
  }

  function addFiles(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    act(async () => {
      for (const [i, f] of files.entries()) {
        const lbl = `${files.length > 1 ? `(${i + 1}/${files.length}) ` : ''}${f.name}`;
        setProgress({ label: lbl, ratio: 0 });
        await api.admin.uploadTrainingFile(j.id, f, (r) => setProgress({ label: r >= 1 ? `${lbl} 변환 중` : lbl, ratio: r }));
      }
    });
  }

  return (
    <li>
      <div className="vm-main">
        <div className="tr-head">
          <b>{j.name}</b>
          <span className={`tag ${tone}`}>{label}</span>
          {j.ownerService && <span className="tag">{j.ownerService} 전용</span>}
          <span className="muted small">
            {j.autoPitch
              ? j.pitch == null ? '피치 자동(학습 때 측정)' : `피치 ${j.pitch > 0 ? `+${j.pitch}` : j.pitch} (자동, 목소리 ${Math.round(j.voiceF0)}Hz)`
              : `피치 ${j.pitch > 0 ? `+${j.pitch}` : j.pitch}`}
            {' · '}
            {j.epochs}에포크{j.autoEpochs ? ' (자동)' : ''} · {fmtDate(j.createdAt)}
          </span>
        </div>

        {(busy || j.stagesDone.length > 0 || j.status === 'done') && (
          <div className="meter">
            <div className="meter-label">
              <span>
                {j.status === 'done' ? '학습 완료' : stageLabel ?? '대기 중'}
                {j.stage === 'train' && j.status !== 'done' && ` · ${j.epoch}/${j.epochs}에포크`}
              </span>
              <span>
                {Math.round(j.progress * 100)}%{j.etaSec != null && ` · 남은 시간 ${fmtEta(j.etaSec)}`}
              </span>
            </div>
            <div className="meter-track">
              <div className="meter-fill" style={{ width: `${Math.round(j.progress * 100)}%` }} />
            </div>
          </div>
        )}

        {j.error && <div className="banner error small">{j.error}</div>}
        {j.status === 'done' && (
          <div className="banner ok small">
            목소리 모델로 등록했습니다. <button className="link" onClick={onGoModels}>목소리 모델 탭</button>에서 피치를 들어 보며 맞추세요.
          </div>
        )}

        <div className="small">
          <b>녹음</b> {j.files.length}개 · 합계 {fmtLen(j.datasetSeconds)}
          {!enough && <span className="hint"> — 최소 {Math.round(data.minSeconds / 60)}분 필요 (권장 10~30분)</span>}
        </div>
        {j.files.length > 0 && (
          <ul className="tr-files small">
            {j.files.map((f) => (
              <li key={f.id}>
                <span className="ellipsis">
                  {f.name}
                  {f.warnings?.map((w) => (
                    <span key={w} className="hint"> ⚠ {w}</span>
                  ))}
                </span>
                <span className="muted">{fmtLen(f.seconds)}</span>
                {editable && (
                  <button className="link" onClick={() => act(() => api.admin.removeTrainingFile(j.id, f.id))} aria-label={`${f.name} 삭제`}>
                    삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {progress && <div className="small muted">업로드 {progress.label} {Math.round(progress.ratio * 100)}%</div>}
        {recording && !busy && (
          <ScriptRecorder job={j} onUploaded={reload} setProgress={setProgress} disabled={Boolean(progress) || !data.enabled} />
        )}
        {j.log && (
          <div className="small">
            <button className="link" onClick={() => setShowLog(!showLog)}>{showLog ? '로그 숨기기' : '로그 보기'}</button>
            {showLog && <pre className="tr-log">{j.log}</pre>}
          </div>
        )}
        {err && <div className="banner error small">{err}</div>}
      </div>

      <div className="inline vm-actions">
        {!busy && <button onClick={() => setRecording(!recording)}>{recording ? '대본 닫기' : '대본 보며 녹음'}</button>}
        <label className={`file-btn ${editable ? '' : 'disabled'}`}>
          파일 추가
          <input type="file" accept="audio/*,.m4a,.wav,.mp3,.flac,.ogg,.webm" multiple disabled={!editable} onChange={addFiles} hidden />
        </label>
        {busy ? (
          <button onClick={() => confirm('학습을 중지할까요? 나중에 이어서 학습할 수 있습니다.') && act(() => api.admin.cancelTraining(j.id))}>중지</button>
        ) : (
          <button className="primary" disabled={!enough || !data.enabled || Boolean(progress)} onClick={() => act(() => api.admin.startTraining(j.id))}>
            {resumable ? '이어서 학습' : j.status === 'done' ? '다시 학습' : '학습 시작'}
          </button>
        )}
        <button
          className="danger"
          disabled={!editable}
          onClick={() => confirm(`'${j.name}' 학습을 삭제할까요? 올린 녹음도 지워집니다. (이미 등록된 목소리 모델은 남습니다)`) && act(() => api.admin.deleteTraining(j.id))}
        >
          삭제
        </button>
      </div>
    </li>
  );
}
