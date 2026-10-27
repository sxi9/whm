import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';
import { LicenseBanner, LicenseStatusCard, EntitlementsCard, LicenseKeyForm, ActivationsCard, TrialCard, TransferModal, describeStatus, LICENSE_PATH } from '../src/pages/server-configuration/LicenseTab.jsx';
import BasicWebhostManagerSetup, { TABS } from '../src/pages/fn/server-configuration/basic-webhost-manager-setup.jsx';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

React.useLayoutEffect = React.useEffect;
const render = (el, { initialEntries } = {}) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);

const active = {
  status: 'active', enforce: true, degraded: false, edition: 'pro', editionLabel: 'Pro', rank: 30, keyPrefix: 'WHM-7K3Q', activationId: 'act_01', hubUrl: 'https://hub.example',
  lexp: 1792886400, exp: 1761955200, daysLeft: 365, lastCheckinAt: '2026-10-27T00:00:00Z', nextCheckinAt: '2026-10-27T12:00:00Z', failCount: 0, hasKey: true, messages: [{ level: 'info', code: 'renewal_available', text: 'Renew before 2027' }],
  limits: { max_accounts: -1, max_resellers: 5, max_activations: 1, max_domains_per_account: -1 }, features: { api: true, transfers: true, clusters: false },
};

describe('License tab', () => {
  it('is reachable from Basic WebHost Manager Setup and opens on #license', () => {
    const fn = FUNCTION_BY_KEY['server-configuration/basic-webhost-manager-setup'];
    expect(fn).toBeTruthy();
    expect(TABS.map((t) => t.value)).toEqual(['settings', 'license']);
    expect(LICENSE_PATH).toBe(`${fn.path}#license`);
    const settings = render(<BasicWebhostManagerSetup fn={fn} />, { initialEntries: [fn.path] });
    expect(settings).toContain('aria-selected="true"');
    expect(settings).toContain('Basic WebHost Manager Setup');
    expect(settings).not.toContain('The key is entered only here');
    const license = render(<BasicWebhostManagerSetup fn={fn} />, { initialEntries: [`${fn.path}#license`] });
    expect(license).toContain('The key is entered only here');
  });

  it('shows edition, masked key prefix, hub, limits and features for an active license', () => {
    const html = render(<><LicenseStatusCard license={active} onCheckin={() => {}} /><EntitlementsCard license={active} /></>);
    expect(html).toContain('Pro');
    expect(html).toContain('WHM-7K3Q-XXXX-XXXX-XXXX');
    expect(html).toContain('https://hub.example');
    expect(html).toContain('Check in now');
    expect(html).toContain('renewal_available');
    expect(html).toContain('unlimited');
    expect(html).toContain('Hosting accounts');
    expect(html).toContain('not included');
    expect(html).toContain(describeStatus(active));
    expect(html).not.toContain('license-unverified');
  });

  it('says when the stored token could not be verified and hides the entitlements it claims', () => {
    const unverified = { ...active, status: 'degraded', degraded: true, reason: 'unknown_kid', hasToken: true, tokenVerified: false, edition: null, editionLabel: null, limits: {}, features: {}, hubUrl: 'https://bootstrap.example' };
    const html = render(<><LicenseStatusCard license={unverified} onCheckin={() => {}} /><EntitlementsCard license={unverified} /></>);
    expect(html).toContain('license-unverified');
    expect(html).toContain('cannot be verified');
    expect(html).toContain('https://bootstrap.example');
    expect(html).not.toContain('Hosting accounts');
    expect(render(<LicenseStatusCard license={{ ...active, tokenVerified: true, hasToken: true }} onCheckin={() => {}} />)).not.toContain('license-unverified');
  });

  it('offers key entry and a trial when unlicensed, and replace/deactivate/transfer once activated', () => {
    const unlicensed = { ...active, status: 'unlicensed', edition: null, editionLabel: null, keyPrefix: null, activationId: null, hasKey: false, messages: [] };
    const html = render(<><LicenseStatusCard license={unlicensed} /><LicenseKeyForm hasKey={false} onSubmit={() => {}} /><TrialCard onStart={() => {}} /></>);
    expect(html).toContain('No license is active on this server');
    expect(html).toContain('WHM-XXXX-XXXX-XXXX-XXXX');
    expect(html).toContain('Start trial');
    expect(html).toContain('stored encrypted and never shown again');
    const replace = render(<LicenseKeyForm hasKey replace onSubmit={() => {}} />);
    expect(replace).toContain('Replace key and activate');
    const acts = render(<ActivationsCard license={active} activations={{ current: { id: 'act_01', hostname: 'srv1.example', lastCheckinAt: null, status: 'active' }, others: [{ id: 'act_old', hostname: 'old.example', last_checkin: null }], max: 1 }} onDeactivate={() => {}} onTransfer={() => {}} />);
    expect(acts).toContain('Deactivate this server');
    expect(acts).toContain('Transfer here');
    expect(acts).toContain('old.example');
    expect(acts).toContain('1 server allowed');
    const modal = render(<TransferModal open activations={[{ id: 'act_old', hostname: 'old.example' }]} onClose={() => {}} onTransfer={() => {}} />);
    expect(modal).toContain('All activations are in use');
  });

  it('renders the shell banner only for enforced non-active states and links to the License tab', () => {
    for (const l of [{ status: 'active', enforce: true }, { status: 'unlicensed', enforce: false }, null]) expect(render(<LicenseBanner license={l} />)).not.toContain('license-banner');
    const grace = render(<LicenseBanner license={{ status: 'grace', enforce: true, daysLeft: 5 }} />);
    expect(grace).toContain('banner-warning');
    expect(grace).toContain('grace period');
    expect(grace).toContain('5 days left');
    const degraded = render(<LicenseBanner license={{ status: 'degraded', enforce: true, reason: 'grace_elapsed', action: LICENSE_PATH }} />);
    expect(degraded).toContain('banner-error');
    expect(degraded).toContain('read-only');
    expect(degraded).toContain('grace elapsed');
    expect(degraded).toContain(`href="${LICENSE_PATH}"`);
    expect(render(<LicenseBanner license={{ status: 'unlicensed', enforce: true }} />)).toContain('License unlicensed');
  });
});
