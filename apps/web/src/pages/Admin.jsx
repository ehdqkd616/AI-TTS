import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDate, STATUS_LABEL } from './format.js';
import VoiceTraining from './VoiceTraining.jsx';

const TABS = [
  ['dashboard', '대시보드'],
  ['users', '회원 관리'],
  ['generations', '생성 내역'],
  ['voices', '목소리 모델'],
  ['training', '목소리 학습'],
  ['audit', '감사 로그'],
];

export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'dashboard';
  return (
    <div className="page wide">
      <div className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{label}</button>
        ))}
      </div>
      {tab === 'dashboard' && <Dashboard onGoUsers={() => setParams({ tab: 'users', status: 'pending' })} />}
      {tab === 'users' && <Users initialStatus={params.get('status') ?? ''} />}
      {tab === 'generations' && <Generations />}
      {tab === 'voices' && <VoiceModels />}
      {tab === 'training' && <VoiceTraining onGoModels={() => setParams({ tab: 'voices' })} />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    fn().then(setData, (e) => setError(e.message));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { data, error, reload: load };
}

/** 상용 엔진(유료 API) 과금 방지 패널 — 사용량, 한도, 긴급 차단 */
function PaidEngines() {
  const { data, error, reload } = useLoad(() => api.admin.paidEngines(), []);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return null;
  const g = data.engines.google;
  const bar = (used, limit) => Math.min(100, Math.round((used / limit) * 100));

  async function toggle() {
    const next = !data.disabled;
    if (next && !window.confirm('상용 엔진(Google 등)을 즉시 모두 멈출까요? 음성은 무료 모델로만 생성됩니다.')) return;
    setBusy(true);
    try {
      await api.admin.setPaidEnginesDisabled(next);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card paid ${data.disabled ? 'stopped' : ''}`}>
      <div className="paid-head">
        <h2>Google TTS 사용량 (자동 결제 방지)</h2>
        <button className={data.disabled ? '' : 'danger'} disabled={busy} onClick={toggle}>
          {data.disabled ? '상용 엔진 다시 켜기' : '상용 엔진 긴급 차단'}
        </button>
      </div>
      {data.disabled && <div className="banner warn">긴급 차단 중 — Google을 호출하지 않고 무료 모델로만 생성합니다.</div>}
      {[['오늘', g.today, data.dailyLimit], ['이번 달', g.month, data.monthlyLimit]].map(([label, used, limit]) => (
        <div key={label} className="meter">
          <div className="meter-label">
            <span>{label}</span>
            <span>{used.toLocaleString()} / {limit.toLocaleString()}자 ({bar(used, limit)}%)</span>
          </div>
          <div className="meter-track"><div className={`meter-fill ${bar(used, limit) >= 80 ? 'hot' : ''}`} style={{ width: `${bar(used, limit)}%` }} /></div>
        </div>
      ))}
      <p className="muted small">
        Google Chirp 3 HD 무료 사용량은 월 100만 자입니다. 한도에 닿으면 Google 호출을 멈추고 무료 모델로 전환하므로 결제되지 않습니다.
        월 50%·80%·100%, 일 100%에 닿으면 관리자 메일로 알립니다.
      </p>
    </section>
  );
}

function Dashboard({ onGoUsers }) {
  const { data, error } = useLoad(() => api.admin.stats(), []);
  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="empty">불러오는 중…</p>;
  const pct = Math.min(100, Math.round((data.today.chars / data.today.globalLimit) * 100));
  return (
    <>
      <div className="tiles">
        <button className={`tile ${data.users.pending ? 'attention' : ''}`} onClick={onGoUsers}>
          <span>승인 대기</span><b>{data.users.pending}</b>
        </button>
        <div className="tile"><span>전체 회원</span><b>{data.users.total}</b></div>
        <div className="tile"><span>오늘 생성</span><b>{data.today.generations}</b><small>캐시 {data.today.cached} · 실패 {data.today.failed}</small></div>
        <div className="tile"><span>오늘 엔진 사용</span><b>{data.today.chars.toLocaleString()}자</b><small>전체 한도의 {pct}%</small></div>
      </div>
      <PaidEngines />
      <section className="card">
        <h2>최근 7일 엔진 사용 글자 수</h2>
        {data.week.length === 0 ? <p className="empty">기록이 없습니다.</p> : (
          <table className="grid">
            <thead><tr><th>날짜</th><th className="num">글자 수</th></tr></thead>
            <tbody>{data.week.map((d) => <tr key={d.date}><td>{d.date}</td><td className="num">{d.chars.toLocaleString()}</td></tr>)}</tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>오늘 사용량 상위 회원</h2>
        {data.topUsers.length === 0 ? <p className="empty">기록이 없습니다.</p> : (
          <table className="grid">
            <thead><tr><th>회원</th><th className="num">글자 수</th></tr></thead>
            <tbody>{data.topUsers.map((u) => <tr key={u.id}><td>{u.name} <span className="muted">{u.username}</span></td><td className="num">{u.chars.toLocaleString()}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Users({ initialStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [msg, setMsg] = useState(null);
  const { data, error, reload } = useLoad(() => api.admin.users({ status, q: query }), [status, query]);

  const act = async (fn, okText) => {
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ type: 'ok', text: okText });
      setSelected(new Set());
      reload();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  const pendingIds = data?.items.filter((u) => u.status === 'pending').map((u) => u.id) ?? [];
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">
          {[['', '전체'], ...Object.entries(STATUS_LABEL)].map(([k, label]) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="search">
          <input placeholder="아이디·이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {pendingIds.length > 0 && (
        <div className="bulk">
          <label className="check">
            <input
              type="checkbox"
              checked={pendingIds.every((id) => selected.has(id))}
              onChange={(e) => setSelected(new Set(e.target.checked ? pendingIds : []))}
            /> 승인 대기 전체 선택
          </label>
          <button disabled={!selected.size} onClick={() => act(() => api.admin.bulkApprove([...selected]), `${selected.size}명을 승인했습니다.`)}>
            선택 승인 ({selected.size})
          </button>
        </div>
      )}
      {msg && <div className={`banner ${msg.type === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      {error && <div className="banner error">{error}</div>}
      {data && data.items.length === 0 && <p className="empty">회원이 없습니다.</p>}
      <ul className="userlist">
        {data?.items.map((u) => (
          <li key={u.id}>
            <div className="u-row">
              {u.status === 'pending' ? <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} /> : <span className="cb-space" />}
              <button className="u-main" onClick={() => setOpenId(openId === u.id ? null : u.id)}>
                <span className="u-name">{u.name} {u.role === 'admin' && <span className="tag">관리자</span>}</span>
                <span className="muted">{u.username}</span>
                <span className="muted small">가입 {fmtDate(u.createdAt)} · 생성 {u.generationCount}건 · 오늘 {u.usedToday.toLocaleString()}자</span>
                {u.signupNote && <span className="note">메모: {u.signupNote}</span>}
              </button>
              <span className={`status ${u.status}`}>{STATUS_LABEL[u.status]}</span>
              <div className="u-actions">
                {(u.status === 'pending' || u.status === 'rejected') && (
                  <button onClick={() => act(() => api.admin.approve(u.id), `${u.username} 승인`)}>승인</button>
                )}
                {u.status === 'pending' && (
                  <button className="danger" onClick={() => {
                    const reason = window.prompt('거절 사유 (선택, 로그인 시 회원에게 보입니다)');
                    if (reason !== null) act(() => api.admin.reject(u.id, reason), `${u.username} 거절`);
                  }}>거절</button>
                )}
                {u.status === 'approved' && u.role !== 'admin' && (
                  <button className="danger" onClick={() => window.confirm(`${u.username}을(를) 정지할까요? 즉시 로그아웃됩니다.`) && act(() => api.admin.suspend(u.id), `${u.username} 정지`)}>정지</button>
                )}
                {u.status === 'suspended' && <button onClick={() => act(() => api.admin.unsuspend(u.id), `${u.username} 정지 해제`)}>해제</button>}
              </div>
            </div>
            {openId === u.id && <UserDetail id={u.id} onChanged={reload} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function UserDetail({ id, onChanged }) {
  const { data, error, reload } = useLoad(() => api.admin.user(id), [id]);
  const [limit, setLimit] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (data) setLimit(data.user.dailyCharLimit ?? '');
  }, [data]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="empty">불러오는 중…</p>;
  const u = data.user;

  async function saveLimit(e) {
    e.preventDefault();
    try {
      await api.admin.setQuota(id, limit === '' ? null : Number(limit));
      setMsg({ type: 'ok', text: '한도를 저장했습니다.' });
      reload();
      onChanged();
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  async function issueTemp() {
    if (!window.confirm(`${u.username}의 임시 비밀번호를 발급할까요? 기존 비밀번호와 로그인 세션은 무효가 됩니다.`)) return;
    try {
      const { tempPassword } = await api.admin.tempPassword(id);
      setMsg({ type: 'ok', text: `임시 비밀번호: ${tempPassword}  (지금만 표시됩니다. 회원에게 전달하고 변경하도록 안내하세요)` });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  return (
    <div className="detail">
      <dl className="info">
        <dt>상태</dt><dd>{STATUS_LABEL[u.status]}{u.rejectReason ? ` (사유: ${u.rejectReason})` : ''}</dd>
        <dt>승인일</dt><dd>{fmtDate(u.approvedAt)}</dd>
        <dt>최근 로그인</dt><dd>{fmtDate(u.lastLoginAt)}</dd>
        <dt>일일 한도</dt><dd>{u.effectiveDailyLimit == null ? '없음 (관리자)' : `${u.effectiveDailyLimit.toLocaleString()}자${u.dailyCharLimit == null ? ' (기본값)' : ''}`}</dd>
      </dl>
      {u.role !== 'admin' && (
        <div className="detail-actions">
          <form onSubmit={saveLimit} className="inline">
            <input type="number" min="0" max="10000000" placeholder="기본값" value={limit} onChange={(e) => setLimit(e.target.value)} />
            <button>한도 저장</button>
          </form>
          <button onClick={issueTemp}>임시 비밀번호 발급</button>
        </div>
      )}
      {msg && <div className={`banner ${msg.type === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
      <h3>최근 생성 ({data.generations.length})</h3>
      {data.generations.length === 0 ? <p className="empty">없음</p> : (
        <table className="grid">
          <tbody>
            {data.generations.slice(0, 10).map((g) => (
              <tr key={g.id}><td className="ellipsis" title={g.text}>{g.text}</td><td>{g.locale}</td><td className="num">{g.charCount}</td><td>{fmtDate(g.createdAt)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>로그인 기록</h3>
      {data.logins.length === 0 ? <p className="empty">없음</p> : (
        <table className="grid">
          <tbody>
            {data.logins.map((l, i) => (
              <tr key={i}><td>{{ 'login.success': '성공', 'login.failure': '실패', 'login.blocked': '차단(승인 전·정지)' }[l.action] ?? l.action}</td><td>{l.ip}</td><td>{fmtDate(l.createdAt)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Generations() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState({ q: '', status: '' });
  const { data, error } = useLoad(() => api.admin.generations(filter), [filter.q, filter.status]);
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">
          {[['', '전체'], ['done', '성공'], ['failed', '실패']].map(([k, label]) => (
            <button key={k} className={filter.status === k ? 'on' : ''} onClick={() => setFilter({ ...filter, status: k })}>{label}</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setFilter({ ...filter, q }); }} className="search">
          <input placeholder="문장·아이디 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {error && <div className="banner error">{error}</div>}
      {data && data.items.length === 0 && <p className="empty">내역이 없습니다.</p>}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>일시</th><th>회원</th><th>문장</th><th>언어·보이스</th><th className="num">글자</th><th>상태</th><th /></tr></thead>
          <tbody>
            {data?.items.map((g) => (
              <tr key={g.id}>
                <td className="nowrap">{fmtDate(g.createdAt)}</td>
                <td className="nowrap">{g.userUsername ?? '-'}</td>
                <td className="ellipsis" title={g.text}>{g.text}</td>
                <td className="nowrap">{g.locale} · {g.voiceId.split(':')[1]}</td>
                <td className="num">{g.charCount}</td>
                <td className="nowrap">
                  {g.status === 'failed' ? <span className="tag error" title={g.error ?? ''}>실패</span> : g.cached ? <span className="tag">캐시</span> : '성공'}
                </td>
                <td>{g.audioUrl && <a href={g.audioUrl} target="_blank" rel="noopener">듣기</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ACTION_LABEL = {
  'user.signup': '가입 신청',
  'user.password_change': '비밀번호 변경',
  'login.success': '로그인',
  'login.failure': '로그인 실패',
  'login.blocked': '로그인 차단(상태)',
  'admin.user.approve': '승인',
  'admin.user.reject': '거절',
  'admin.user.suspend': '정지',
  'admin.user.unsuspend': '정지 해제',
  'admin.user.quota': '한도 변경',
  'admin.user.temp_password': '임시 비밀번호 발급',
  'admin.paid_engines.disable': '상용 엔진 긴급 차단',
  'admin.paid_engines.enable': '상용 엔진 다시 켬',
};

function Audit() {
  const [action, setAction] = useState('');
  const { data, error } = useLoad(() => api.admin.audit({ action }), [action]);
  return (
    <section className="card">
      <div className="toolbar">
        <div className="chips">
          {[['', '전체'], ['admin.', '관리자 조치'], ['login.', '로그인'], ['user.', '회원']].map(([k, label]) => (
            <button key={k} className={action === k ? 'on' : ''} onClick={() => setAction(k)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="scroll-x">
        <table className="grid">
          <thead><tr><th>일시</th><th>행위</th><th>수행자</th><th>대상</th><th>내용</th><th>IP</th></tr></thead>
          <tbody>
            {data?.items.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{fmtDate(a.createdAt)}</td>
                <td className="nowrap">{ACTION_LABEL[a.action] ?? a.action}</td>
                <td className="nowrap">{a.actorUsername ?? '-'}</td>
                <td className="nowrap">{a.targetType ? `${a.targetType} #${a.targetId}` : '-'}</td>
                <td className="small">{a.detail ? Object.entries(a.detail).map(([k, v]) => `${k}: ${v}`).join(', ') : ''}</td>
                <td className="nowrap">{a.ip ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const fmtMB = (b) => (b ? `${(b / 1024 / 1024).toFixed(1)}MB` : '-');

/** RVC 목소리 모델: 관리자가 올리고, 회원은 음성 생성 화면에서 골라 쓴다 */
function VoiceModels() {
  const { data, error, reload } = useLoad(() => api.admin.voiceModels(), []);
  const [form, setForm] = useState({ name: '', defaultPitch: 0, ownerService: '', pth: null, index: null });
  const [progress, setProgress] = useState(null); // { label, ratio }
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function act(fn, done) {
    setErr('');
    setMsg('');
    try {
      await fn();
      if (done) setMsg(done);
      reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setProgress(null);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (!form.pth) return setErr('.pth 파일을 고르세요.');
    act(async () => {
      setProgress({ label: '.pth 업로드 · 검사', ratio: 0 });
      const model = await api.admin.uploadVoiceModel(form.pth, { name: form.name, defaultPitch: form.defaultPitch, ownerService: form.ownerService }, (r) =>
        setProgress({ label: '.pth 업로드 · 검사', ratio: r }),
      );
      if (form.index) {
        setProgress({ label: '.index 업로드', ratio: 0 });
        await api.admin.uploadVoiceIndex(model.id, form.index, (r) => setProgress({ label: '.index 업로드', ratio: r }));
      }
      setForm({ name: '', defaultPitch: 0, ownerService: '', pth: null, index: null });
      e.target.reset();
    }, '모델을 등록했습니다.');
  }

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="empty">불러오는 중…</p>;
  return (
    <>
      {!data.rvcEnabled && (
        <div className="banner warn">
          목소리 변환(RVC)이 설정되지 않았습니다. <code>apps/api/.env</code>에 <code>RVC_ROOT</code>(RVC WebUI 폴더)를 지정하고 재시작하세요.
        </div>
      )}
      <section className="card">
        <h2>새 목소리 모델 올리기</h2>
        <p className="muted small">
          RVC로 학습한 <b>.pth</b>(필수)와 <b>.index</b>(선택, 있으면 음색이 더 비슷해짐)를 올리면, 회원이 음성 생성 화면에서 이 목소리로 바꿔 받을 수 있습니다.
          기본 TTS가 여성 목소리라 남성 모델은 기본 피치를 음수(예: -5 ~ -12)로 두고 들어 보며 맞추세요.
          .pth는 열 때 코드가 실행될 수 있는 형식이니 직접 학습했거나 믿을 수 있는 파일만 올리세요.
          <br />
          <b>쓰는 곳</b>을 특정 서비스 전용으로 두면 그 서비스(내부 API)만 쓰고 회원 화면에는 나오지 않습니다 — 본인 목소리처럼 남이 쓰면 안 되는 모델에 쓰세요.
        </p>
        <form className="vm-form" onSubmit={submit}>
          <label>
            <span>이름</span>
            <input value={form.name} maxLength={40} required onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="예) 루디 목소리" />
          </label>
          <label>
            <span>기본 피치 {form.defaultPitch > 0 ? `+${form.defaultPitch}` : form.defaultPitch}</span>
            <input type="range" min="-24" max="24" step="1" value={form.defaultPitch} onChange={(e) => setForm({ ...form, defaultPitch: Number(e.target.value) })} />
          </label>
          <label>
            <span>쓰는 곳</span>
            <select value={form.ownerService} onChange={(e) => setForm({ ...form, ownerService: e.target.value })}>
              <option value="">회원 공용 (음성 생성 화면에 노출)</option>
              {(data.services ?? []).map((s) => (
                <option key={s} value={s}>{s} 전용 (회원에게 숨김)</option>
              ))}
            </select>
          </label>
          <label>
            <span>.pth 파일</span>
            <input type="file" accept=".pth" required onChange={(e) => setForm({ ...form, pth: e.target.files[0] ?? null })} />
          </label>
          <label>
            <span>.index 파일 (선택)</span>
            <input type="file" accept=".index" onChange={(e) => setForm({ ...form, index: e.target.files[0] ?? null })} />
          </label>
          <button className="primary" disabled={Boolean(progress) || !data.rvcEnabled}>
            {progress ? `${progress.label} ${Math.round(progress.ratio * 100)}%` : '등록'}
          </button>
        </form>
        {msg && <div className="banner ok">{msg}</div>}
        {err && <div className="banner error">{err}</div>}
      </section>

      <section className="card">
        <h2>등록된 모델</h2>
        {data.items.length === 0 ? <p className="empty">아직 등록된 모델이 없습니다.</p> : (
          <ul className="vm-list">
            {data.items.map((m) => (
              <VoiceModelRow key={m.id} m={m} services={data.services ?? []} defaults={data.defaults} act={act} busy={Boolean(progress)} setProgress={setProgress} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function VoiceModelRow({ m, services, defaults, act, busy, setProgress }) {
  const [name, setName] = useState(m.name);
  const [pitch, setPitch] = useState(m.defaultPitch);
  const [owner, setOwner] = useState(m.ownerService ?? '');
  // null = 서버 기본값(.env RVC_INDEX_RATE / RVC_PROTECT)
  const [indexRate, setIndexRate] = useState(m.indexRate);
  const [protect, setProtect] = useState(m.protect);
  const [preview, setPreview] = useState(null); // { url, key } | { loading } | { error }
  // 설정에서 토큰이 사라진 뒤에도 지금 값은 고를 수 있게 남겨 둔다
  const ownerOptions = [...new Set([...services, ...(m.ownerService ? [m.ownerService] : [])])];
  const dirty = name !== m.name || pitch !== m.defaultPitch || owner !== (m.ownerService ?? '') || indexRate !== m.indexRate || protect !== m.protect;
  const ir = indexRate ?? defaults?.indexRate ?? 0.75;
  const pr = protect ?? defaults?.protect ?? 0.33;

  async function listen() {
    setPreview({ loading: true });
    try {
      const r = await api.admin.previewVoiceModel(m.id, { pitch, indexRate: ir, protect: pr });
      setPreview({ url: r.audioUrl, key: `${pitch}/${ir}/${pr}` });
    } catch (e) {
      setPreview({ error: e.message });
    }
  }

  function uploadIndex(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    act(() => api.admin.uploadVoiceIndex(m.id, file, (r) => setProgress({ label: '.index 업로드', ratio: r })), '.index를 올렸습니다.');
  }

  return (
    <li className={m.enabled ? '' : 'off'}>
      <div className="vm-main">
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="모델 이름" />
        <label className="vm-pitch">
          <span>기본 피치 {pitch > 0 ? `+${pitch}` : pitch}</span>
          <input type="range" min="-24" max="24" step="1" value={pitch} onChange={(e) => setPitch(Number(e.target.value))} />
        </label>
        <label className="vm-scope">
          <span>쓰는 곳</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">회원 공용</option>
            {ownerOptions.map((s) => (
              <option key={s} value={s}>{s} 전용</option>
            ))}
          </select>
        </label>
        <div className="vm-tune">
          <label>
            <span>
              index 비율 {ir.toFixed(2)} {indexRate === null && '(서버 기본)'} — 높을수록 음색이 닮고, 낮을수록 발음이 또렷
            </span>
            <input type="range" min="0" max="1" step="0.05" value={ir} disabled={!m.hasIndex} onChange={(e) => setIndexRate(Number(e.target.value))} />
          </label>
          <label>
            <span>
              자음 보호 {pr.toFixed(2)} {protect === null && '(서버 기본)'} — 낮을수록 ㅅ·ㅎ·숨소리를 원본대로 (0.5는 끔)
            </span>
            <input type="range" min="0" max="0.5" step="0.01" value={pr} onChange={(e) => setProtect(Number(e.target.value))} />
          </label>
        </div>
        <div className="vm-preview small">
          <button disabled={busy || preview?.loading} onClick={listen}>{preview?.loading ? '만드는 중…' : '▶ 미리 듣기'}</button>
          {preview?.url && <audio key={preview.key} controls autoPlay src={preview.url} />}
          {preview?.error && <span className="hint">{preview.error}</span>}
          {(indexRate !== null || protect !== null) && (
            <button className="link" onClick={() => (setIndexRate(null), setProtect(null))}>서버 기본값으로</button>
          )}
        </div>
        <div className="muted small">
          .pth {fmtMB(m.modelBytes)} · .index {m.hasIndex ? fmtMB(m.indexBytes) : '없음'} · {fmtDate(m.createdAt)}
          {m.ownerService && <span className="tag">{m.ownerService} 전용</span>}
          {!m.enabled && <span className="tag warn">사용 중지</span>}
        </div>
      </div>
      <div className="inline vm-actions">
        <button
          disabled={!dirty || busy}
          onClick={() => act(() => api.admin.updateVoiceModel(m.id, { name, defaultPitch: pitch, ownerService: owner, indexRate, protect }), '저장했습니다.')}
        >
          저장
        </button>
        <label className={`file-btn ${busy ? 'disabled' : ''}`}>
          {m.hasIndex ? '.index 교체' : '.index 추가'}
          <input type="file" accept=".index" disabled={busy} onChange={uploadIndex} hidden />
        </label>
        {m.hasIndex && <button disabled={busy} onClick={() => act(() => api.admin.removeVoiceIndex(m.id), '.index를 지웠습니다.')}>.index 삭제</button>}
        <button disabled={busy} onClick={() => act(() => api.admin.updateVoiceModel(m.id, { enabled: !m.enabled }))}>{m.enabled ? '사용 중지' : '다시 사용'}</button>
        <button
          className="danger"
          disabled={busy}
          onClick={() => confirm(`'${m.name}' 모델을 삭제할까요? 파일도 함께 지워집니다.`) && act(() => api.admin.deleteVoiceModel(m.id), '삭제했습니다.')}
        >
          삭제
        </button>
      </div>
    </li>
  );
}
