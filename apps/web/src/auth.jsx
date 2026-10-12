import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, usage: null });

  const refresh = useCallback(async () => {
    try {
      const { user, usage, passwordManaged } = await api.me();
      setState({ loading: false, user, usage, passwordManaged });
    } catch {
      setState({ loading: false, user: null, usage: null });
    }
  }, []);

  useEffect(() => {
    refresh();
    const onExpired = () => setState({ loading: false, user: null, usage: null });
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [refresh]);

  const logout = async () => {
    await api.logout().catch(() => {});
    setState({ loading: false, user: null, usage: null });
  };

  return <AuthContext.Provider value={{ ...state, refresh, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export function RequireAuth({ admin = false, children }) {
  const { loading, user } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page"><p className="empty">불러오는 중…</p></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}
