import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthProvider, useAuth, userAfterPasswordChange } from '../src/auth/AuthContext.jsx';
import { shellRedirect } from '../src/components/Layout.jsx';

const calls = [];
const stateUpdates = [];
vi.mock('../src/api/client.js', () => ({
  api: {
    setCsrfToken: (t) => calls.push(['csrf', t]),
    setUnauthorizedHandler: () => {},
    async get(path) { calls.push(['get', path]); return { data: {} }; },
    async post(path, body) {
      calls.push(['post', path, body]);
      return { data: { user: passwordPayload.user, csrfToken: 'csrf-2', mustEnroll2fa: passwordPayload.mustEnroll2fa, newIp: false } };
    },
  },
}));
// Static rendering has no re-render to observe: record what the provider hands
// its state setters instead, and apply it to the pre-change user.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal();
  const useState = (init) => {
    const [value, set] = actual.useState(init);
    return [value, (next) => { stateUpdates.push(next); return set(next); }];
  };
  return { ...actual, default: { ...actual.default, useState }, useState };
});

React.useLayoutEffect = React.useEffect;

// What /auth/me put on the shell user for a reseller who must change a generated
// password and then enrol 2FA (policy require2faForResellers).
const shellUser = {
  id: 7, username: 'res1', email: 'r@example.net', role: 'reseller', totpEnabled: false, mustChangePassword: true, superadmin: false, setupPending: false,
  mustEnroll2fa: true, policy: { sessionTimeoutMinutes: 15, disallowConcurrentSessions: false },
  profile: { name: 'dnsonly', hiddenCategories: ['email', 'sql-services'] },
  license: { status: 'grace', edition: 'pro', daysLeft: 3, enforce: true, degraded: false },
};
// What routes/auth.js answers to POST /auth/password: publicUser + setupPending
// and the session's mustEnroll2fa, nothing of policy/profile/license.
const passwordPayload = {
  user: { id: 7, username: 'res1', email: 'r@example.net', role: 'reseller', totpEnabled: false, mustChangePassword: false, superadmin: false, setupPending: false },
  mustEnroll2fa: true,
};

describe('AuthContext after a forced password change', () => {
  beforeEach(() => { calls.length = 0; stateUpdates.length = 0; });

  it('keeps the pending 2FA enrolment, policy, profile and license the shell got from /auth/me', () => {
    const user = userAfterPasswordChange(shellUser, passwordPayload);
    expect(user.mustChangePassword).toBe(false);
    expect(user.mustEnroll2fa).toBe(true);
    expect(user.policy).toEqual(shellUser.policy);
    expect(user.profile).toEqual(shellUser.profile);
    expect(user.license).toEqual(shellUser.license);
    expect(user.setupPending).toBe(false);
    expect(shellRedirect(user, '/')).toBe('/security-center/two-factor-authentication');
    // The stripped payload on its own is what used to reach the shell: no redirect.
    expect(shellRedirect(passwordPayload.user, '/')).toBeNull();
  });

  it('clears the enrolment gate when the session no longer requires it', () => {
    const user = userAfterPasswordChange(shellUser, { ...passwordPayload, mustEnroll2fa: false });
    expect(user.mustEnroll2fa).toBe(false);
    expect(shellRedirect(user, '/')).toBeNull();
    expect(userAfterPasswordChange(shellUser, { user: passwordPayload.user }).mustEnroll2fa).toBe(false);
  });

  it('changePassword merges the /auth/password payload into the current user instead of replacing it', async () => {
    let auth;
    function Probe() { auth = useAuth(); return null; }
    renderToStaticMarkup(<AuthProvider><Probe /></AuthProvider>);
    await auth.changePassword(null, 'N3w-Str0ng-Passw0rd!');

    expect(calls).toEqual([['post', '/auth/password', { newPassword: 'N3w-Str0ng-Passw0rd!' }], ['csrf', 'csrf-2']]);
    const updaters = stateUpdates.filter((u) => typeof u === 'function');
    expect(updaters).toHaveLength(1);
    const next = updaters[0](shellUser);
    expect(next).toEqual({ ...shellUser, ...passwordPayload.user, mustChangePassword: false, mustEnroll2fa: true });
    expect(shellRedirect(next, '/')).toBe('/security-center/two-factor-authentication');
    expect(stateUpdates.some((u) => u && typeof u === 'object' && !('mustEnroll2fa' in u))).toBe(false);
  });

  it('sends the current password when the change is not forced', async () => {
    let auth;
    function Probe() { auth = useAuth(); return null; }
    renderToStaticMarkup(<AuthProvider><Probe /></AuthProvider>);
    await auth.changePassword('old-one', 'N3w-Str0ng-Passw0rd!');
    expect(calls[0]).toEqual(['post', '/auth/password', { currentPassword: 'old-one', newPassword: 'N3w-Str0ng-Passw0rd!' }]);
  });
});
