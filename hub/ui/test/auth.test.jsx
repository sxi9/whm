import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, SESSIONS } from './support.jsx';

const auth = { value: SESSIONS.vendor, stepUp: vi.fn(async () => ({ totp_verified_at: 1 })) };
vi.mock('../src/auth/AuthContext.jsx', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ session: auth.value, ready: true, area: real.areaOf(auth.value), stepUp: auth.stepUp, loginPortal: vi.fn(), loginDeveloper: vi.fn(), logout: vi.fn(), refresh: vi.fn(), markTotpEnabled: vi.fn() }) };
});

const { areaOf, homeOf, stepUpPathFor, loginPathFor, AREA_ROLES } = await import('../src/auth/AuthContext.jsx');
const { guardDecision, RequireArea, ForbiddenPage } = await import('../src/auth/RoleGuard.jsx');
const { StepUpModal } = await import('../src/auth/StepUpModal.jsx');
const { LoginForm, PortalLoginPage, DeveloperLoginPage } = await import('../src/auth/Login.jsx');
const { Shell } = await import('../src/shell/Shell.jsx');
const { NAV_BY_AREA } = await import('../src/shell/nav.js');
const { routes, flattenPaths } = await import('../src/router.jsx');

describe('session areas', () => {
  it('maps sessions to portal areas and homes', () => {
    expect(areaOf(SESSIONS.vendor)).toBe('admin');
    expect(areaOf(SESSIONS.support)).toBe('admin');
    expect(areaOf(SESSIONS.reseller)).toBe('reseller');
    expect(areaOf(SESSIONS.developer)).toBe('dev');
    expect(areaOf(null)).toBe(null);
    expect(areaOf({ kind: 'portal', user: { role: 'unknown_role' } })).toBe(null);
    expect(homeOf(SESSIONS.reseller)).toBe('/reseller');
    expect(homeOf(null)).toBe('/login');
    expect(loginPathFor('dev')).toBe('/dev/login');
    expect(loginPathFor('admin')).toBe('/login');
  });

  it('uses the right step-up endpoint per session kind', () => {
    expect(stepUpPathFor(SESSIONS.vendor)).toBe('/portal/stepup');
    expect(stepUpPathFor(SESSIONS.reseller)).toBe('/portal/stepup');
    expect(stepUpPathFor(SESSIONS.developer)).toBe('/dev/2fa/stepup');
  });

  it('guards areas: wrong kind → login, wrong role → forbidden', () => {
    expect(guardDecision(null, 'admin')).toBe('login');
    expect(guardDecision(SESSIONS.vendor, 'admin', AREA_ROLES.admin)).toBe('ok');
    expect(guardDecision(SESSIONS.support, 'admin', AREA_ROLES.admin)).toBe('ok');
    expect(guardDecision(SESSIONS.support, 'admin', ['vendor_admin'])).toBe('forbidden');
    expect(guardDecision(SESSIONS.reseller, 'admin', AREA_ROLES.admin)).toBe('login');
    expect(guardDecision(SESSIONS.reseller, 'reseller', AREA_ROLES.reseller)).toBe('ok');
    expect(guardDecision(SESSIONS.developer, 'dev')).toBe('ok');
    expect(guardDecision(SESSIONS.developer, 'admin')).toBe('login');
    expect(guardDecision(SESSIONS.vendor, 'dev')).toBe('login');
  });

  it('RequireArea renders the children for the right area and the forbidden page for the wrong role', () => {
    auth.value = SESSIONS.vendor;
    expect(render(<RequireArea area="admin" roles={AREA_ROLES.admin}><p>admin-home</p></RequireArea>)).toContain('admin-home');
    auth.value = SESSIONS.support;
    expect(render(<RequireArea area="admin" roles={['vendor_admin']}><p>admin-home</p></RequireArea>)).toContain('Your role cannot open this page');
    auth.value = SESSIONS.developer;
    expect(render(<RequireArea area="admin" roles={AREA_ROLES.admin}><p>admin-home</p></RequireArea>)).not.toContain('admin-home');
    expect(render(<ForbiddenPage />)).toContain('vendor administrator');
    auth.value = SESSIONS.vendor;
  });
});

describe('step-up prompt and login forms', () => {
  it('renders the step-up modal with the refused request and a 6-digit code field', () => {
    const request = { err: { message: 'Confirm your TOTP code to continue' }, info: { method: 'POST', path: '/admin/signing-keys' } };
    const html = render(<StepUpModal open request={request} onDone={() => {}} onCancel={() => {}} />);
    expect(html).toContain('Confirm your two-factor code');
    expect(html).toContain('POST /admin/signing-keys');
    expect(html).toContain('id="stepup-code"');
    expect(html).toContain('inputMode="numeric"'.replace('inputMode', 'inputmode'));
    expect(html).toContain('disabled=""');
    expect(render(<StepUpModal open={false} request={null} onDone={() => {}} onCancel={() => {}} />)).toBe('');
  });

  it('warns inside the step-up modal when the session has no 2FA', () => {
    auth.value = SESSIONS.support;
    const html = render(<StepUpModal open request={{ err: {}, info: {} }} onDone={() => {}} onCancel={() => {}} />);
    expect(html).toContain('Two-factor authentication is not enabled');
    auth.value = SESSIONS.vendor;
  });

  it('login form shows e-mail + password first and links the other portal', () => {
    const html = render(<LoginForm title="Vendor & reseller portal" onLogin={async () => {}} footer={<a href="/dev/login">Developer sign-in</a>} />);
    expect(html).toContain('id="login-email"');
    expect(html).toContain('id="login-password"');
    expect(html).toContain('Sign in');
    expect(html).toContain('Developer sign-in');
    auth.value = null;
    expect(render(<PortalLoginPage />)).toContain('Vendor &amp; reseller portal');
    expect(render(<DeveloperLoginPage />)).toContain('Register as a developer');
    auth.value = SESSIONS.vendor;
  });
});

describe('shell and routes', () => {
  it('every sidebar link points at a declared route', () => {
    const paths = new Set(flattenPaths(routes).map((p) => p.replace(/\/$/, '') || '/'));
    for (const [area, groups] of Object.entries(NAV_BY_AREA)) {
      for (const g of groups) for (const item of g.items) expect(paths.has(item.to), `${area} ${item.to}`).toBe(true);
    }
    expect(paths.has('/admin/licenses/:id')).toBe(true);
    expect(paths.has('/dev/plugins/:id/versions/:v')).toBe(true);
    expect(paths.has('/login')).toBe(true);
    expect(paths.has('/dev/login')).toBe(true);
  });

  it('renders the shell with the area navigation and identity', () => {
    auth.value = SESSIONS.vendor;
    const html = render(<Shell area="admin" />);
    expect(html).toContain('Vendor admin');
    expect(html).toContain('root@vendor.test');
    expect(html).toContain('href="/admin/market/verifications"');
    expect(html).toContain('2FA confirmed');
    auth.value = SESSIONS.developer;
    const dev = render(<Shell area="dev" />);
    expect(dev).toContain('Developer portal');
    expect(dev).toContain('href="/dev/keys"');
    expect(dev).not.toContain('2FA armed');
    auth.value = SESSIONS.vendor;
  });
});
