import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const profiles = [
  { name: 'standard', label: 'Standard Node', description: 'Everything', monitoredServices: ['httpd', 'named', 'exim'], hiddenCategories: [] },
  { name: 'dns-only', label: 'DNS Node', description: 'DNS only', monitoredServices: ['named', 'sshd'], hiddenCategories: ['email', 'database-services', 'transfers'] },
];
const profileData = { current: 'dns-only', profiles, services: [{ name: 'named', displayName: 'BIND', monitored: true }, { name: 'exim', displayName: 'Exim', monitored: false }] };

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: path === '/server-config/profile' ? profileData : null, meta: null, error: null, loading: false, refetch() {}, setData() {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { default: ServerProfile, profileSwitchMessage } = await import('../src/pages/fn/server-configuration/server-profile.jsx');
const { CATEGORIES } = await import('../src/nav.js');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const fn = CATEGORIES.find((c) => c.slug === 'server-configuration').functions.find((f) => f.slug === 'server-profile');

describe('Server Profile', () => {
  it('tells the operator the hidden categories leave the sidebar, Tools and search once the profile is applied', () => {
    const html = render(<ServerProfile fn={fn} />);
    expect(html).toContain('hides them from the sidebar, the Tools grid and search for every user');
    expect(html).toContain('stay reachable by URL');
    expect(html).not.toMatch(/keeps showing|stay available until|until the (panel )?shell/i);
    expect(html).toContain('Email');
    expect(html).toContain('database-services');
  });

  it('says the same in the confirmation, naming the categories and the way back', () => {
    const msg = profileSwitchMessage(profiles[1], 'Standard Node');
    expect(msg).toContain('3 categories (Email, Database Services, Transfers) disappear from the sidebar, the Tools grid and search for every user as soon as the profile is applied');
    expect(msg).toContain('Switching back to Standard Node brings them back.');
    expect(msg).toContain('Service monitoring follows the profile (named, sshd).');
    expect(msg).not.toMatch(/keeps showing/);
    expect(profileSwitchMessage(profiles[0])).toContain('Every category stays visible.');
  });
});
