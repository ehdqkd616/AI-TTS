import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDate } from './format.js';

export default function MyPage() {
  const { user, usage, passwordManaged, refresh } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', next2: '' });
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function changePassword(e) {
    e.preventDefault();
    if (form.next !== form.next2) return setMsg({ type: 'error', text: '새 비밀번호 확인이 일치하지 않습니다.' });
    try {
      await api.changePassword(form.current, form.next);
      setForm({ current: '', next: '', next2: '' });
      setMsg({ type: 'ok', text: '비밀번호를 변경했습니다. 다른 기기에서는 로그아웃되었습니다.' });
    } catch (err) {
      setMsg({ type: 'error', text: err.message });
    }
  }

  return (
    <div className="page">
      <section className="card">
        <h2>내 정보</h2>
        <dl className="info">
          <dt>아이디</dt><dd>{user.username}</dd>
          <dt>이름</dt><dd>{user.name}</dd>
          <dt>권한</dt><dd>{user.role === 'admin' ? '관리자' : '일반 회원'}</dd>
          <dt>가입일</dt><dd>{fmtDate(user.createdAt)}</dd>
          <dt>오늘 사용량</dt>
          <dd>
            {usage?.usedToday.toLocaleString() ?? 0}자
            {usage?.dailyLimit != null ? ` / ${usage.dailyLimit.toLocaleString()}자` : ' (회원별 한도 없음)'}
          </dd>
        </dl>
      </section>

      {passwordManaged ? (
        <section className="card"><p className="muted">관리자 비밀번호는 서버 .env의 ADMIN_PASSWORD로 관리합니다.</p></section>
      ) : (
      <form className="card auth" onSubmit={changePassword}>
        <h2>비밀번호 변경</h2>
        <label>
          <span>현재 비밀번호</span>
          <input type="password" autoComplete="current-password" required value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
        </label>
        <label>
          <span>새 비밀번호 (8자 이상)</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </label>
        <label>
          <span>새 비밀번호 확인</span>
          <input type="password" autoComplete="new-password" required value={form.next2} onChange={(e) => setForm({ ...form, next2: e.target.value })} />
        </label>
        {msg && <div className={`banner ${msg.type === 'ok' ? 'ok' : 'error'}`}>{msg.text}</div>}
        <button className="primary">변경</button>
      </form>
      )}
    </div>
  );
}
