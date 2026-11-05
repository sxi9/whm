import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user', totpEnabled: false }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: Password, validatePassword } = await import('../src/pages/panel/security/password.jsx');
const { default: TwoFactor, statusText } = await import('../src/pages/panel/security/two-factor.jsx');
const { default: SshKeys, normalizeKey, keyProblem } = await import('../src/pages/panel/security/ssh-keys.jsx');
const { default: Sessions, remainingText } = await import('../src/pages/panel/security/sessions.jsx');
const { default: Tokens, tokenRows } = await import('../src/pages/panel/security/tokens.jsx');
const { keyTypeLabel, scopeLabel, expiryState, toIsoOrNull, TOKEN_SCOPES } = await import('../src/pages/panel/security/parts/shared.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user', totpEnabled: false, mustChangePassword: false },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', shell: '/bin/bash', package: 'starter', plan: {}, features: {}, limits: {}, domains: [], forcePasswordChange: false },
  usage: {}, counts: {}, actingAs: null, policy: { require2fa: false, passwordSynced: true }, hostname: 'srv1.example', csrfToken: 't',
};
const acting = { account: 'demo', by: 'root', expiresAt: new Date(Date.now() + 20 * 60000).toISOString() };
const ctxFor = (over = {}) => ({ me: { ...me, ...over }, loading: false, error: null, reload: () => {}, hasFeature: () => true });
const fn = (slug) => PANEL_FUNCTION_BY_KEY[`panel:security/${slug}`];
const render = (el, path, ctx = ctxFor()) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (path, value) => fixtures.responses.set(path, { loading: false, ...value });

describe('Password page', () => {
  it('renders the form with strength meter and where the password is used', () => {
    fixtures.responses.clear();
    const html = render(h(Password, { fn: fn('password') }), fn('password').path);
    expect(html).toContain('<h1>Password</h1>');
    expect(html).toContain('id="pw-current"');
    expect(html).toContain('id="pw-new"');
    expect(html).toContain('strength-bar');
    expect(html).toContain('id="pw-confirm"');
    expect(html).toContain('Where this password is used');
    expect(html).toContain('Enabled on this account');
    expect(html).toContain('Kept in sync');
    expect(html).not.toContain('A new password is required');
  });

  it('shows the forced-change banner and the read-only notice while impersonating', () => {
    fixtures.responses.clear();
    let html = render(h(Password, { fn: fn('password') }), fn('password').path, ctxFor({ account: { ...me.account, forcePasswordChange: true } }));
    expect(html).toContain('A new password is required');
    html = render(h(Password, { fn: fn('password') }), fn('password').path, ctxFor({ actingAs: acting }));
    expect(html).toContain('Read-only while logged in as demo');
    expect(html).toMatch(/id="pw-current"[^>]*disabled=""/);
  });

  it('renders the plan state when the feature is off', () => {
    const html = render(h(Password, { fn: fn('password') }), fn('password').path, ctxFor({ account: { ...me.account, features: { passwordchange: false } } }));
    expect(html).toContain('Not included in your plan');
  });

  it('validatePassword rejects weak, mismatched and unchanged passwords', () => {
    expect(validatePassword({ currentPassword: 'a', newPassword: 'short', confirm: 'short' }).fields.newPassword[0]).toMatch(/At least 8/);
    expect(validatePassword({ currentPassword: 'Str0ng-Pass!word', newPassword: 'Str0ng-Pass!word', confirm: 'Str0ng-Pass!word' }).fields.newPassword[0]).toMatch(/differ/);
    expect(validatePassword({ currentPassword: 'a', newPassword: 'Str0ng-Pass!word', confirm: 'x' }).fields.confirm[0]).toMatch(/match/);
    expect(validatePassword({ currentPassword: 'a', newPassword: 'Str0ng-Pass!word', confirm: 'Str0ng-Pass!word' })).toBe(null);
  });
});

describe('Two-factor page', () => {
  it('renders the status and the set-up button when not enabled', () => {
    fixtures.responses.clear();
    set('/panel/security/two-factor', { data: { enabled: false, required: false, pendingEnrollment: false } });
    const html = render(h(TwoFactor, { fn: fn('two-factor') }), fn('two-factor').path);
    expect(html).toContain('<h1>Two-factor authentication</h1>');
    expect(html).toContain('>Not enabled<');
    expect(html).toContain('Set up two-factor authentication');
    expect(html).toContain('How it works');
    expect(html).not.toContain('>Disable<');
  });

  it('shows the disable button when enabled, locked when required', () => {
    fixtures.responses.clear();
    set('/panel/security/two-factor', { data: { enabled: true, required: true, pendingEnrollment: false } });
    const html = render(h(TwoFactor, { fn: fn('two-factor') }), fn('two-factor').path);
    expect(html).toContain('>Enabled<');
    expect(html).toContain('Required for account users');
    expect(html).toContain('Cannot be disabled while the server requires it');
    expect(html).toMatch(/<button[^>]*class="btn btn-danger[^"]*"[^>]*disabled=""/);
  });

  it('asks for enrollment when required but not enabled, and goes read-only while impersonating', () => {
    fixtures.responses.clear();
    set('/panel/security/two-factor', { data: { enabled: false, required: true, pendingEnrollment: true } });
    let html = render(h(TwoFactor, { fn: fn('two-factor') }), fn('two-factor').path);
    expect(html).toContain('Two-factor authentication is required on this server');
    expect(html).toContain('>Enrollment started<');
    html = render(h(TwoFactor, { fn: fn('two-factor') }), fn('two-factor').path, ctxFor({ actingAs: acting }));
    expect(html).toContain('Read-only while logged in as demo');
    expect(html).not.toContain('required on this server');
  });

  it('renders the capability state on 501', () => {
    fixtures.responses.clear();
    set('/panel/security/two-factor', { error: { status: 501, code: 'capability_missing', message: 'no auth' } });
    expect(render(h(TwoFactor, { fn: fn('two-factor') }), fn('two-factor').path)).toContain('Not available on this server');
    expect(statusText({ enabled: true })).toBe('Enabled');
    expect(statusText({ enabled: false, pendingEnrollment: true })).toBe('Enrollment started');
  });
});

describe('SSH keys page', () => {
  const keys = [
    { id: 'a'.repeat(64), fingerprint: 'SHA256:abcdef', type: 'ssh-ed25519', bits: 256, comment: 'laptop', options: '' },
    { id: 'b'.repeat(64), fingerprint: 'SHA256:ghijkl', type: 'ssh-rsa', bits: 3072, comment: '', options: 'no-pty' },
  ];
  it('renders the add form, the connection card and the key table', () => {
    fixtures.responses.clear();
    set('/panel/security/ssh-keys', { data: keys });
    const html = render(h(SshKeys, { fn: fn('ssh-keys') }), fn('ssh-keys').path);
    expect(html).toContain('<h1>SSH keys</h1>');
    expect(html).toContain('id="ssh-key"');
    expect(html).toContain('ssh demo@srv1.example');
    expect(html).toContain('2 keys can open a shell');
    expect(html).toContain('laptop');
    expect(html).toContain('Ed25519 · 256 bits');
    expect(html).toContain('RSA · 3072 bits');
    expect(html).toContain('SHA256:abcdef');
    expect(html).toContain('no-pty');
    expect(html).toContain('no comment');
    expect(html).toContain('>Remove<');
  });

  it('renders 501 shell_disabled as a plan setting (P2-12) and the plan state on 403', () => {
    fixtures.responses.clear();
    set('/panel/security/ssh-keys', { error: { status: 501, code: 'shell_disabled', message: 'This account has no shell access, so SSH keys cannot be used' } });
    let html = render(h(SshKeys, { fn: fn('ssh-keys') }), fn('ssh-keys').path);
    expect(html).toContain('Not included in your plan');
    expect(html).not.toContain('Not available on this server');
    expect(html).toContain('no shell access');
    expect(html).toContain('once shell access is enabled');
    expect(html).toMatch(/id="ssh-key"[^>]*disabled=""/);
    set('/panel/security/ssh-keys', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    html = render(h(SshKeys, { fn: fn('ssh-keys') }), fn('ssh-keys').path);
    expect(html).toContain('Not included in your plan');
    set('/panel/security/ssh-keys', { error: { status: 409, code: 'no_home', message: 'This account has no home directory on the server yet' } });
    html = render(h(SshKeys, { fn: fn('ssh-keys') }), fn('ssh-keys').path);
    expect(html).toContain('No home directory yet');
  });

  it('helpers: normalizeKey, keyProblem, keyTypeLabel', () => {
    expect(normalizeKey('  ssh-ed25519   AAAA\n laptop ')).toBe('ssh-ed25519 AAAA laptop');
    expect(keyProblem('ssh-ed25519 AAAAC3 laptop')).toBe(null);
    expect(keyProblem('-----BEGIN OPENSSH PRIVATE KEY-----')).toMatch(/private key/);
    expect(keyProblem('hello')).toMatch(/Expected one line/);
    expect(keyTypeLabel('ecdsa-sha2-nistp256')).toBe('ECDSA P-256');
  });
});

describe('Sessions page', () => {
  it('renders this sign-in, the sign-out card and the session table', () => {
    fixtures.responses.clear();
    set('/panel/security/sessions', { data: [{ id: 'abc123', expiresAt: new Date(Date.now() + 3 * 3600000).toISOString() }, { id: 'def456', expiresAt: new Date(Date.now() + 15 * 60000).toISOString() }] });
    const html = render(h(Sessions, { fn: fn('sessions') }), fn('sessions').path);
    expect(html).toContain('<h1>Sessions</h1>');
    expect(html).toContain('This sign-in');
    expect(html).toContain('Sign out everywhere else');
    expect(html).toContain('>Sign out other sessions<');
    expect(html).toContain('2 sessions signed in as this login');
    expect(html).toContain('abc123');
    expect(html).toContain('3 h');
    expect(html).toContain('15 min');
    expect(html).toContain('>Signed in<');
  });

  it('goes read-only while impersonating and renders 501', () => {
    fixtures.responses.clear();
    set('/panel/security/sessions', { data: [] });
    let html = render(h(Sessions, { fn: fn('sessions') }), fn('sessions').path, ctxFor({ actingAs: acting }));
    expect(html).toContain('Read-only while logged in as demo');
    expect(html).toContain('Logged in as');
    expect(html).toMatch(/<button[^>]*class="btn btn-danger[^"]*"[^>]*disabled=""/);
    set('/panel/security/sessions', { error: { status: 403, code: 'not_while_impersonating', message: 'This action is not available while logged in as the account' } });
    html = render(h(Sessions, { fn: fn('sessions') }), fn('sessions').path, ctxFor({ actingAs: acting }));
    expect(html).toContain('an administrator viewing the account never sees them');
    expect(html).not.toContain('table-state error');
    set('/panel/security/sessions', { error: { status: 501, code: 'capability_missing', message: 'x' } });
    html = render(h(Sessions, { fn: fn('sessions') }), fn('sessions').path);
    expect(html).toContain('Not available on this server');
    expect(remainingText(new Date(Date.now() + 3 * 86400000).toISOString())).toBe('3 d');
    expect(remainingText(null)).toBe('—');
  });
});

describe('API tokens page', () => {
  const tokens = [
    { id: 1, name: 'Deploy script', scopes: ['panel:read', 'panel:files'], prefix: 'k7Yq2mP0', expiresAt: null, lastUsedAt: '2026-11-02 10:00:00', createdAt: '2026-10-01 10:00:00' },
    { id: 2, name: 'Old backup job', scopes: ['panel:backups'], prefix: 'Zz9aBc12', expiresAt: '2026-01-01T00:00:00Z', lastUsedAt: null, createdAt: '2025-12-01 10:00:00' },
  ];
  it('renders the table, the usage card and the create button', () => {
    fixtures.responses.clear();
    set('/panel/tokens', { data: tokens });
    const html = render(h(Tokens, { fn: fn('tokens') }), fn('tokens').path);
    expect(html).toContain('<h1>API tokens</h1>');
    expect(html).toContain('>Create token<');
    expect(html).toContain('2 tokens for demo');
    expect(html).toContain('Deploy script');
    expect(html).toContain('k7Yq2mP0…');
    expect(html).toContain('>Read everything<');
    expect(html).toContain('>Files<');
    expect(html).toContain('>Never<');
    expect(html).toContain('expired');
    expect(html).toContain('>Revoke<');
    expect(html).toContain('Using a token');
    expect(html).toContain('Authorization: Bearer');
  });

  it('renders the plan state, the capability state and the read-only notice', () => {
    fixtures.responses.clear();
    set('/panel/tokens', { error: { status: 403, code: 'feature_disabled', message: 'off' } });
    let html = render(h(Tokens, { fn: fn('tokens') }), fn('tokens').path);
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('API tokens is not part of the hosting plan');
    set('/panel/tokens', { error: { status: 501, code: 'capability_missing', message: 'x' } });
    html = render(h(Tokens, { fn: fn('tokens') }), fn('tokens').path);
    expect(html).toContain('Not available on this server');
    set('/panel/tokens', { data: [] });
    html = render(h(Tokens, { fn: fn('tokens') }), fn('tokens').path, ctxFor({ actingAs: acting }));
    expect(html).toContain('Read-only while logged in as demo');
    expect(html).toContain('No API tokens yet');
  });

  it('helpers: tokenRows, scopeLabel, expiryState, toIsoOrNull, TOKEN_SCOPES', () => {
    expect(tokenRows(tokens, 'backups').map((t) => t.id)).toEqual([2]);
    expect(scopeLabel('panel:dns')).toBe('DNS');
    expect(expiryState(null)).toBe('never');
    expect(expiryState('2020-01-01T00:00:00Z')).toBe('expired');
    expect(expiryState(new Date(Date.now() + 60000).toISOString())).toBe('active');
    expect(toIsoOrNull('')).toBe(null);
    expect(toIsoOrNull('2030-01-01T10:00')).toMatch(/^2030-01-01T/);
    expect(TOKEN_SCOPES.map(([s]) => s)).toEqual(['panel:read', 'panel:files', 'panel:email', 'panel:dns', 'panel:databases', 'panel:backups', 'panel:cron']);
  });
});
