import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

// /auth/password answers with the login shape (publicUser + mustEnroll2fa), not
// the /auth/me one: merged over the shell user so policy, profile and license
// survive and the pending 2FA enrolment still redirects.
export function userAfterPasswordChange(user, data) {
  return { ...user, ...data.user, mustEnroll2fa: Boolean(data.mustEnroll2fa) };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [hostname, setHostname] = useState('');
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      api.setCsrfToken(data.csrfToken);
      setUser({ ...data.user, mustEnroll2fa: Boolean(data.mustEnroll2fa), policy: data.policy || {}, profile: data.profile || { name: 'standard', hiddenCategories: [] }, license: data.license || null });
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
      setUser((u) => userAfterPasswordChange(u, data));
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
