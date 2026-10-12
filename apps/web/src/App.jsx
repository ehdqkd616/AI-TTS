import { NavLink, Route, Routes, Navigate, useNavigate } from 'react-router-dom';
import { RequireAuth, useAuth } from './auth.jsx';
import TtsPage from './pages/TtsPage.jsx';
import { LoginPage, SignupPage } from './pages/Auth.jsx';
import MyPage from './pages/MyPage.jsx';
import AdminPage from './pages/Admin.jsx';

function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <NavLink to="/" className="brand">AI TTS</NavLink>
      {user && (
        <nav>
          <NavLink to="/" end>음성 생성</NavLink>
          <NavLink to="/me">내 정보</NavLink>
          {user.role === 'admin' && <NavLink to="/admin">관리자 페이지</NavLink>}
          <button
            className="link"
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            로그아웃
          </button>
        </nav>
      )}
    </header>
  );
}

export default function App() {
  return (
    <>
      <Header />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/" element={<RequireAuth><TtsPage /></RequireAuth>} />
        <Route path="/me" element={<RequireAuth><MyPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
