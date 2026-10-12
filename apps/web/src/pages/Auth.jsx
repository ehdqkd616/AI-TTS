import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export function LoginPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(form.username, form.password);
      await refresh();
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <form className="card auth" onSubmit={submit}>
        <h2>로그인</h2>
        <label>
          <span>아이디</span>
          <input autoComplete="username" autoCapitalize="none" spellCheck={false} required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </label>
        <label>
          <span>비밀번호</span>
          <input type="password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        {error && (
          <div className={`banner ${error.code === 'ACCOUNT_PENDING' ? 'warn' : 'error'}`}>
            {error.message}
            {error.reason && <div>사유: {error.reason}</div>}
          </div>
        )}
        <button className="primary" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
        <p className="alt">계정이 없나요? <Link to="/signup">회원가입</Link></p>
      </form>
    </div>
  );
}

export function SignupPage() {
  const { user } = useAuth();
  const [form, setForm] = useState({ username: '', name: '', password: '', password2: '', signupNote: '', agreeTerms: false, agreePrivacy: false });
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  if (user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.password2) return setError('비밀번호 확인이 일치하지 않습니다.');
    setBusy(true);
    setError('');
    try {
      const { password2, ...body } = form;
      setDone((await api.signup(body)).message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="page narrow">
        <div className="card auth">
          <h2>가입 신청 완료</h2>
          <p>{done}</p>
          <p className="muted">승인되면 로그인할 수 있어요.</p>
          <Link className="primary as-button" to="/login">로그인 화면으로</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page narrow">
      <form className="card auth" onSubmit={submit}>
        <h2>회원가입</h2>
        <p className="muted">가입 후 관리자 승인이 끝나면 이용할 수 있어요.</p>
        <label>
          <span>아이디 (영문·숫자·_·- 3~32자)</span>
          <input autoComplete="username" autoCapitalize="none" spellCheck={false} required pattern="[A-Za-z0-9_\-]{3,32}" minLength={3} maxLength={32}
            value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} />
        </label>
        <label>
          <span>이름</span>
          <input autoComplete="name" required maxLength={50} value={form.name} onChange={set('name')} />
        </label>
        <label>
          <span>비밀번호 (8자 이상)</span>
          <input type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={form.password} onChange={set('password')} />
        </label>
        <label>
          <span>비밀번호 확인</span>
          <input type="password" autoComplete="new-password" required value={form.password2} onChange={set('password2')} />
        </label>
        <label>
          <span>가입 메모 (선택) — 사용 목적 등을 남기면 승인이 빨라요</span>
          <textarea rows={3} maxLength={1000} value={form.signupNote} onChange={set('signupNote')} />
        </label>

        <details className="terms">
          <summary>이용약관 · 개인정보 처리방침 보기</summary>
          <p><b>이용약관</b> — 이 서비스는 입력한 문장을 AI 음성으로 변환합니다. 생성된 음성은 AI 생성물이며, 공개할 때는 AI 생성물임을 알려야 합니다.
            타인을 사칭하거나 불법적인 목적으로 사용할 수 없고, 남용 시 이용이 정지될 수 있습니다. 하루 사용량에는 한도가 있습니다.</p>
          <p><b>개인정보 처리방침</b> — 수집 항목: 아이디, 이름, 가입 메모, 접속 IP·기기 정보, 입력한 문장과 생성된 음성.
            이용 목적: 회원 관리, 서비스 제공, 남용 방지. 입력한 문장은 음성 합성을 위해 외부 TTS 엔진(Azure·Google 등)으로 전송될 수 있습니다.
            탈퇴를 원하면 관리자에게 요청하세요.</p>
        </details>
        <label className="check">
          <input type="checkbox" checked={form.agreeTerms} onChange={set('agreeTerms')} /> 이용약관에 동의합니다 (필수)
        </label>
        <label className="check">
          <input type="checkbox" checked={form.agreePrivacy} onChange={set('agreePrivacy')} /> 개인정보 수집·이용에 동의합니다 (필수)
        </label>

        {error && <div className="banner error">{error}</div>}
        <button className="primary" disabled={busy || !form.agreeTerms || !form.agreePrivacy}>{busy ? '처리 중…' : '가입 신청'}</button>
        <p className="alt">이미 계정이 있나요? <Link to="/login">로그인</Link></p>
      </form>
    </div>
  );
}
