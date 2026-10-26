import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [hostname, setHostname] = useState('');
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      api.setCsrfToken(data.csrfToken);
      setUser({ ...data.user, mustEnroll2fa: Boolean(data.mustEnroll2fa), policy: data.policy || {} });
      setHostname(data.hostname || '');
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    api.setUnauthorizedHandler(() => setUser(null));
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    user, hostname, ready, refresh,
    async login(username, password) {
      const { data } = await api.post('/auth/login', { username, password });
      if (data.requires2fa) return { requires2fa: true };
      api.setCsrfToken(data.csrfToken);
      setUser(data.user);
      await refresh();
      return { user: data.user };
    },
    async verify2fa(code) {
      const { data } = await api.post('/auth/2fa', { code });
      api.setCsrfToken(data.csrfToken);
      setUser(data.user);
      await refresh();
      return data.user;
    },
    async changePassword(currentPassword, newPassword) {
      const { data } = await api.post('/auth/password', currentPassword ? { currentPassword, newPassword } : { newPassword });
      api.setCsrfToken(data.csrfToken);
      setUser(data.user);
    },
    async logout() {
      try { await api.post('/auth/logout'); } finally { setUser(null); api.setCsrfToken(null); }
    },
  }), [user, hostname, ready, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
