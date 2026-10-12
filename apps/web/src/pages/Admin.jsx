import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDate, STATUS_LABEL } from './format.js';

const TABS = [
  ['dashboard', '대시보드'],
  ['users', '회원 관리'],
  ['generations', '생성 내역'],
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
