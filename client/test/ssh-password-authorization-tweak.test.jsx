import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: () => ({ data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { draftFromEffective, ROOT_LOGIN } = await import('../src/pages/fn/security-center/ssh-password-authorization-tweak.jsx');

describe('SSH Password Authorization Tweak draft', () => {
  it('maps the without-password spelling sshd -T reports on a stock Ubuntu to the prohibit-password option', () => {
    const draft = draftFromEffective({ permitrootlogin: 'without-password', passwordauthentication: 'no', port: '2222', maxauthtries: '4' });
    expect(draft).toEqual({ PasswordAuthentication: 'no', PermitRootLogin: 'prohibit-password', PubkeyAuthentication: 'yes', PermitEmptyPasswords: 'no', MaxAuthTries: 4, Port: 2222 });
  });

  it('always lands on a value the select offers', () => {
    const offered = ROOT_LOGIN.map((o) => o.value);
    for (const v of ['yes', 'no', 'prohibit-password', 'without-password', 'Prohibit-Password', 'forced-commands-only', undefined]) {
      expect(offered).toContain(draftFromEffective({ permitrootlogin: v }).PermitRootLogin);
    }
    expect(draftFromEffective().PermitRootLogin).toBe('yes');
    expect(draftFromEffective({ permitrootlogin: 'no' }).PermitRootLogin).toBe('no');
  });
});
