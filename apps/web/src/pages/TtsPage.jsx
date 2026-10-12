import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from './format.js';

const AUTO = '';

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function TtsPage() {
  const { usage, refresh: refreshMe } = useAuth();
  const [health, setHealth] = useState(null);
  const [locales, setLocales] = useState([]);
  const [text, setText] = useState('');
  const [localeChoice, setLocaleChoice] = useState(AUTO);
  const [detected, setDetected] = useState(null);
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [format, setFormat] = useState('mp3');
  const [normalized, setNormalized] = useState(null); // 사용자가 확인·수정하는 정규화 텍스트
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const audioRef = useRef(null);

  useEffect(() => {
    api.config().then(setHealth).catch((e) => setError(e.message));
    api.voices().then((d) => setLocales(d.locales)).catch((e) => setError(e.message));
    refreshHistory();
  }, []);

  const refreshHistory = () => api.history().then((d) => setHistory(d.items)).catch(() => {});

  // ① 자동 감지 (추천값) — 입력이 멈춘 뒤에만 호출
  const debouncedText = useDebounced(text, 400);
  useEffect(() => {
    if (!debouncedText.trim()) return setDetected(null);
    let alive = true;
    api.detect(debouncedText).then((d) => alive && setDetected(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [debouncedText]);

  const locale = localeChoice || detected?.locale || '';
  const localeInfo = locales.find((l) => l.locale === locale);
  const labelOf = (code) => locales.find((l) => l.locale === code)?.label ?? code;

  // 로케일이 바뀌면 그 언어의 첫 사용 가능 보이스로
  useEffect(() => {
    const voices = localeInfo?.voices ?? [];
    if (!voices.some((v) => v.id === voiceId && v.available)) {
      setVoiceId(voices.find((v) => v.available)?.id ?? '');
    }
  }, [localeInfo]); // eslint-disable-line react-hooks/exhaustive-deps

  // 원문·언어가 바뀌면 수정해 둔 정규화 텍스트는 무효
  useEffect(() => setNormalized(null), [text, locale]);

  const maxLen = health?.maxTextLength ?? 5000;
  const charCount = useMemo(() => [...text].length, [text]);
  const onlyMock = health && health.providers.filter((p) => p.enabled).every((p) => p.name === 'mock');
  const canGenerate = text.trim() && locale && voiceId && charCount <= maxLen && !busy;

  async function previewNormalize() {
    setError('');
    try {
      const r = await api.normalize(text, locale);
      setNormalized(r.normalized);
    } catch (e) {
      setError(e.message);
    }
  }

  async function generate() {
    setBusy(true);
    setError('');
    try {
      const r = await api.tts({ text, locale, voiceId, speed, format, normalizedText: normalized ?? undefined });
      setResult(r);
      refreshHistory();
      refreshMe();
      requestAnimationFrame(() => audioRef.current?.play().catch(() => {}));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <p className="sub">문장을 입력하면 그 언어 원어민 억양으로 읽어 줍니다.</p>

      {onlyMock && (
        <div className="banner warn">
          API 키가 설정되지 않아 <b>개발용 테스트 톤</b>(실제 음성 아님)으로만 동작합니다. <code>apps/api/.env</code>에 엔진 키를 설정하세요.
        </div>
      )}

      <section className="card">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="읽을 문장을 입력하세요. 예) 2026-10-11 오후 3시에 사과 3개를 샀어요."
          rows={7}
        />
        <div className="count-row">
          {usage?.dailyLimit != null && (
            <span>오늘 사용 {usage.usedToday.toLocaleString()} / {usage.dailyLimit.toLocaleString()}자</span>
          )}
          <span className={`count ${charCount > maxLen ? 'over' : ''}`}>
            {charCount.toLocaleString()} / {maxLen.toLocaleString()}
          </span>
        </div>

        <div className="controls">
          <label>
            <span>언어</span>
            <select value={localeChoice} onChange={(e) => setLocaleChoice(e.target.value)}>
              <option value={AUTO}>
                자동 감지{detected?.locale ? ` — ${labelOf(detected.locale)}` : ''}
              </option>
              {locales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.label}
                </option>
              ))}
            </select>
            {!localeChoice && detected?.locale && detected.confidence !== 'high' && (
              <small className="hint">
                감지 신뢰도가 낮습니다. 지역 억양(예: 미국/영국 영어)이 다르면 직접 선택하세요.
                {detected.alternatives?.length > 0 && ` 다른 후보: ${detected.alternatives.join(', ')}`}
              </small>
            )}
          </label>

          <label>
            <span>보이스</span>
            <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!localeInfo}>
              {!localeInfo && <option>언어를 먼저 정하세요</option>}
              {localeInfo?.voices.map((v) => (
                <option key={v.id} value={v.id} disabled={!v.available}>
                  {v.name} · {v.provider}
                  {v.gender && v.gender !== 'neutral' ? ` · ${v.gender === 'female' ? '여' : '남'}` : ''}
                  {!v.available ? ' (키 미설정)' : ''}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>속도 {speed.toFixed(2)}x</span>
            <input type="range" min="0.5" max="2" step="0.05" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          </label>

          <div className="field">
            <span>포맷</span>
            <div className="seg">
              {['mp3', 'wav'].map((f) => (
                <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="normalize">
          {normalized == null ? (
            <button className="link" onClick={previewNormalize} disabled={!text.trim() || !locale}>
              읽는 방식 확인·수정 (숫자·날짜·약어)
            </button>
          ) : (
            <>
              <div className="normalize-head">
                <span>이렇게 읽습니다 — 틀린 부분은 직접 고치세요</span>
                <button className="link" onClick={() => setNormalized(null)}>자동으로 되돌리기</button>
              </div>
              <textarea value={normalized} onChange={(e) => setNormalized(e.target.value)} rows={4} />
            </>
          )}
        </div>

        <button className="primary" onClick={generate} disabled={!canGenerate}>
          {busy ? '생성 중…' : '음성 생성'}
        </button>
        {error && <div className="banner error">{error}</div>}
      </section>

      {result && (
        <section className="card result">
          <audio ref={audioRef} src={result.audioUrl} controls />
          <div className="meta">
            <span>{labelOf(result.locale)}</span>
            <span>{result.voice.name} · {result.voice.provider}</span>
            {result.cached && <span className="tag">캐시</span>}
            {result.fallbackFrom && <span className="tag warn">대체 엔진 사용 ({result.fallbackFrom} 실패)</span>}
          </div>
          <a className="download" href={`${result.audioUrl}?download=1`}>
            {result.format.toUpperCase()} 다운로드
          </a>
        </section>
      )}

      <section className="card">
        <h2>생성 이력</h2>
        {history.length === 0 && <p className="empty">아직 생성한 음성이 없습니다.</p>}
        <ul className="history">
          {history.map((h) => (
            <li key={h.id}>
              <div className="h-text" title={h.text}>{h.text}</div>
              <div className="h-meta">
                {h.locale} · {h.voiceId.split(':')[1]} · {h.speed}x · {fmtDate(h.createdAt)}
                {h.status === 'failed' && <span className="tag error">실패</span>}
              </div>
              {h.audioUrl && (
                <div className="h-actions">
                  <button
                    onClick={() => setResult({ ...h, voice: { name: h.voiceId.split(':')[1], provider: h.provider } })}
                  >
                    재생
                  </button>
                  <a href={`${h.audioUrl}?download=1`}>다운로드</a>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <footer>이 서비스의 음성은 AI로 생성됩니다. 생성된 음성을 공개할 때는 AI 생성물임을 알려 주세요.</footer>
    </div>
  );
}
