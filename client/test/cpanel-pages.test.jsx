import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';
import ChangeLog from '../src/pages/fn/cpanel/change-log.jsx';
import Customization from '../src/pages/fn/cpanel/customization.jsx';
import ModifyNews from '../src/pages/fn/cpanel/modify-cpanel-and-whm-news.jsx';
import ResetMailmanPassword from '../src/pages/fn/cpanel/reset-a-mailman-password.jsx';
import UpgradeToLatestVersion from '../src/pages/fn/cpanel/upgrade-to-latest-version.jsx';
import { describePermission, PERMISSION_DESCRIPTIONS } from '../src/pages/cpanel/pluginPermissions.js';
import { DEFAULT_BRANDING, logoSrc } from '../src/pages/cpanel/branding.js';

React.useLayoutEffect = React.useEffect;

// Modify News adapts its audience choices to the signed-in role.
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' } }) }));

const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

describe('cPanel pages', () => {
  it.each([
    ['cpanel/change-log', ChangeLog],
    ['cpanel/customization', Customization],
    ['cpanel/modify-cpanel-and-whm-news', ModifyNews],
    ['cpanel/reset-a-mailman-password', ResetMailmanPassword],
    ['cpanel/upgrade-to-latest-version', UpgradeToLatestVersion],
  ])('%s is registered in nav.js and renders its header', (key, Page) => {
    const fn = FUNCTION_BY_KEY[key];
    expect(fn).toBeTruthy();
    const html = render(<Page fn={fn} />);
    expect(html).toContain(fn.label.replace(/&/g, '&amp;'));
  });

  it('describes plugin permission scopes, including parameterised ones', () => {
    expect(describePermission('accounts:read')).toEqual({ text: PERMISSION_DESCRIPTIONS['accounts:read'], sensitive: false });
    expect(describePermission('agent:op:dns.zone.write')).toMatchObject({ sensitive: true });
    expect(describePermission('net:outbound:*.example.com:443').text).toContain('*.example.com:443');
    expect(describePermission('made:up').sensitive).toBe(true);
  });

  it('uses the public logo url (no inline bytes) and has sane defaults', () => {
    expect(logoSrc({ logo: { url: '/api/branding/logo?v=1', mime: 'image/png', size: 72 } })).toBe('/api/branding/logo?v=1');
    expect(logoSrc({ logo: null })).toBeNull();
    expect(logoSrc(null)).toBeNull();
    expect(DEFAULT_BRANDING).toMatchObject({ companyName: 'WHM', tagline: 'WebHost Manager', logo: null });
  });
});
