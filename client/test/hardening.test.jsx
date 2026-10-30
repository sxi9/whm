import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

const auth = { user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {}, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: !r, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { HardeningCard, FirewallConfirmModal, itemDetailLines, portLabel, STATUS_LABELS, SAFE_ITEMS } = await import('../src/pages/security/Hardening.jsx');
const { default: SecurityAdvisor } = await import('../src/pages/fn/security-center/security-advisor.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const item = (id, label, status, detail = {}, extra = {}) => ({ id, label, description: `${label} description`, status, desired: status === 'applied', detail, ...extra });
const items = [
  item('fail2ban', 'Fail2ban intrusion blocking', 'applied', { installed: true, configured: true, running: true, bannedTotal: 2, jails: [{ name: 'sshd', running: true, bannedIps: ['203.0.113.5', '198.51.100.9'] }, { name: 'whm-panel', running: true, bannedIps: [] }] }, { capability: 'fail2ban' }),
  item('auto-updates', 'Automatic security updates', 'not_applied', { family: 'debian', installed: false, installable: true, reason: 'The unattended-upgrades package is not installed', packages: ['unattended-upgrades'] }),
  item('ssh', 'SSH daemon hardening', 'not_applied', { failing: ['PermitRootLogin'], reason: 'PermitRootLogin is not hardened', blocked: 'Root has no authorized SSH key; authorize one first', authorizedKeys: 0, effective: { PermitRootLogin: 'yes', MaxAuthTries: '4', LoginGraceTime: '30', X11Forwarding: 'no' } }),
  item('sysctl', 'Kernel network hardening', 'not_applied', { reason: 'The sysctl.d file is not written', installed: true, mismatched: [{ key: 'net.ipv4.tcp_syncookies', expected: '1', current: '0' }] }),
  item('firewall', 'Firewall baseline (default deny)', 'not_applicable', { backend: 'iptables', policy: 'ACCEPT', sshdPorts: [22], reason: 'firewalld is active and owns the input policy', conflicts: { firewalld: true } }),
];

describe('helpers', () => {
  it('labels ports and ranges and knows which items Apply all may touch', () => {
    expect(portLabel(22)).toBe('22');
    expect(portLabel({ from: 49152, to: 65534 })).toBe('49152-65534');
    expect(SAFE_ITEMS).toEqual(['fail2ban', 'auto-updates', 'ssh', 'sysctl']);
    expect(Object.keys(STATUS_LABELS)).toEqual(['applied', 'not_applied', 'not_applicable', 'unknown']);
  });

  it('itemDetailLines summarises each item from its live detail', () => {
    expect(itemDetailLines(items[0])).toEqual(['Jails: sshd, whm-panel · 2 addresses banned now']);
    expect(itemDetailLines(items[1])).toEqual(['The unattended-upgrades package is not installed', 'unattended-upgrades (not installed)']);
    expect(itemDetailLines(items[2])).toEqual(['PermitRootLogin is not hardened', 'Root has no authorized SSH key; authorize one first', 'PermitRootLogin yes · MaxAuthTries 4 · LoginGraceTime 30 · X11Forwarding no', '0 authorized root keys']);
    expect(itemDetailLines(items[3])).toEqual(['The sysctl.d file is not written', 'net.ipv4.tcp_syncookies = 0 (want 1)']);
    expect(itemDetailLines({ id: 'firewall', detail: { backend: 'nft', policy: 'DROP', sshdPorts: [22], tcp: [22, { from: 49152, to: 65534 }] } })).toEqual(['nft: input policy DROP · sshd on 22 · allows tcp 22, 49152-65534']);
  });
});

describe('HardeningCard', () => {
  it('renders every item with its status, detail, the right action and the banned addresses with Unban', () => {
    responses.clear();
    responses.set('/security/hardening', { data: { items, generatedAt: '2026-10-30T12:00:00Z' } });
    const html = render(<HardeningCard />);
    expect(html).toContain('id="hardening"');
    expect(html).toContain('1 of 4 items applied');
    for (const it of items) expect(html).toContain(it.label);
    expect(html).toContain('Applied');
    expect(html).toContain('Not applied');
    expect(html).toContain('Not applicable');
    // fail2ban: applied → Revert only, with the banned addresses listed
    expect(html).toContain('203.0.113.5');
    expect(html).toContain('198.51.100.9');
    expect((html.match(/>Unban</g) || []).length).toBe(2);
    // auto-updates: package missing → Install, not Apply
    expect(html).toContain('>Install<');
    // ssh: blocked by the missing key → link to the keys page instead of Apply
    expect(html).toContain('/security-center/manage-roots-ssh-keys');
    expect(html).toContain('Root has no authorized SSH key');
    // sysctl: plain Apply; firewall not applicable → no action
    expect((html.match(/>Apply</g) || []).length).toBe(1);
    expect(html).not.toContain('Apply…');
    expect(html).toContain('firewalld is active and owns the input policy');
    // Apply all counts only the applicable safe items that are installed and not blocked (sysctl)
    expect(html).toContain('Apply 1 recommended');
    expect((html.match(/>Revert</g) || []).length).toBe(1);
  });

  it('offers Apply… for the firewall baseline when it is not applied and no "apply all" when nothing is pending', () => {
    responses.clear();
    responses.set('/security/hardening', { data: { items: [item('firewall', 'Firewall baseline (default deny)', 'not_applied', { backend: 'nft', policy: 'accept', sshdPorts: [2222], reason: 'The input policy accepts everything not explicitly blocked' })] } });
    const html = render(<HardeningCard />);
    expect(html).toContain('Apply…');
    expect(html).not.toContain('recommended');
    expect(html).toContain('sshd on 2222');
  });

  it('a firewall row without any backend shows the install prompt instead of Apply…', () => {
    responses.clear();
    responses.set('/security/hardening', { data: { items: [item('firewall', 'Firewall baseline (default deny)', 'not_applied', { backend: null, reason: 'No supported firewall (iptables or nftables) is installed', installable: true })] } });
    const html = render(<HardeningCard />);
    expect(html).toContain('Service not installed');
    expect(html).toContain('Install the firewall');
    expect(html).not.toContain('Apply…');
  });

  it('shows the install prompt for a missing firewall backend and the loading state before data', () => {
    responses.clear();
    responses.set('/security/hardening', { error: { status: 501, code: 'capability_missing', capability: 'firewall', message: 'No firewall tooling is installed' } });
    expect(render(<HardeningCard />)).toContain('Service not installed');
    responses.clear();
    expect(render(<HardeningCard />)).toContain('Loading');
  });
});

describe('FirewallConfirmModal', () => {
  it('lists the planned ports with their reasons, the sshd port and the confirmation sentence, with the apply button disabled until confirmed', () => {
    responses.clear();
    responses.set('/security/hardening/firewall/plan', { data: { backend: 'iptables', sshPorts: [22], sshSource: 'listening', tcp: [{ port: 2087, reasons: ['panel'] }, { port: 22, reasons: ['ssh'] }, { port: { from: 49152, to: 65534 }, reasons: ['ftp passive'] }], udp: [{ port: 53, reasons: ['dns'] }], conflicts: { firewalld: false, ufw: false } } });
    const html = render(<FirewallConfirmModal open onClose={() => {}} />);
    expect(html).toContain('Apply the firewall baseline');
    expect(html).toContain('2087');
    expect(html).toContain('49152-65534');
    expect(html).toContain('ftp passive');
    expect(html).toContain('sshd is listening on port 22 (listening)');
    expect(html).toContain('I can still reach SSH on port N');
    expect(html).toMatch(/Apply default-deny baseline<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply default-deny baseline/);
    expect(render(<FirewallConfirmModal open={false} onClose={() => {}} />)).not.toContain('Apply the firewall baseline');
  });
});

describe('Security Advisor page', () => {
  it('renders the Hardening card under the findings', () => {
    responses.clear();
    responses.set('/security/advisor', { data: { finishedAt: '2026-10-30T12:00:00Z', trigger: 'manual', summary: { critical: 0, warning: 1, info: 0, ok: 1 }, findings: [{ id: 'hardening.fail2ban', grade: 'warning', title: 'Fail2ban intrusion blocking is not applied', fix: { label: 'Hardening', path: '/security-center/security-advisor#hardening' } }] } });
    responses.set('/security/hardening', { data: { items } });
    responses.set('/server-contacts/security-alerts', { data: { settings: { enabled: true }, alerts: [], stats: {}, capability: {}, digest: {}, kinds: [] } });
    responses.set('/system/settings', { data: {} });
    const html = render(<SecurityAdvisor fn={{ key: 'security-center/security-advisor', label: 'Security Advisor', description: 'Scan the server.' }} />);
    expect(html).toContain('Fail2ban intrusion blocking is not applied');
    expect(html).toContain('href="/security-center/security-advisor#hardening"');
    expect(html).toContain('id="hardening"');
    expect(html).toContain('Kernel network hardening');
  });
});
