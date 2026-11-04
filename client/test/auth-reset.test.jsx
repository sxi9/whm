import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: null, ready: true, login: async () => ({}), verify2fa: async () => ({}) }) }));

const { ResetRequestPage, resetRequestBody } = await import('../src/pages/auth/ResetRequest.jsx');
const { ResetConfirmPage, validateNewPassword } = await import('../src/pages/auth/ResetConfirm.jsx');
const { LoginPage } = await import('../src/pages/Login.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, initialEntries) => renderToStaticMarkup(<MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter>);

describe('Forgot-password pages', () => {
  it('turns what was typed into the request body', () => {
    expect(resetRequestBody('  Alice ')).toEqual({ username: 'alice' });
    expect(resetRequestBody('Alice@Example.com')).toEqual({ email: 'alice@example.com' });
  });

  it('renders the request form on the login card with a way back', () => {
    const html = render(<ResetRequestPage />, ['/login/reset']);
    expect(html).toContain('login-card');
    expect(html).toContain('Reset your password');
    expect(html).toContain('Username or e-mail address');
    expect(html).toContain('Send reset link');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('reset link is on its way');
  });

  it('renders the confirm form for the token route and checks the new password locally', () => {
    const html = render(<Routes><Route path="/login/reset/:token" element={<ResetConfirmPage />} /></Routes>, ['/login/reset/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG']);
    expect(html).toContain('Choose a new password');
    expect(html).toContain('Set password');
    expect(html).toContain('Confirm new password');
    expect(validateNewPassword('short', 'short')).toMatch(/At least 8/);
    expect(validateNewPassword('aaaaaaaaaa', 'aaaaaaaaaa')).toMatch(/stronger/);
    expect(validateNewPassword('Str0ng-Passw0rd!x', 'other')).toMatch(/do not match/);
    expect(validateNewPassword('Str0ng-Passw0rd!x', 'Str0ng-Passw0rd!x')).toBeNull();
  });

  it('the login page shows the done banner after a reset and no link before the server says it is available', () => {
    const plain = render(<LoginPage />, ['/login']);
    expect(plain).not.toContain('Forgot password?');
    expect(plain).not.toContain('Your password was changed');
    const done = render(<LoginPage />, ['/login?reset=done']);
    expect(done).toContain('Your password was changed. Sign in with the new one.');
  });
});
