import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 1, username: 'root', role: 'root' }, refresh: async () => {} }) }));

// Static rendering never runs effects: useApi answers from a table keyed by
// path, the longest key that prefixes the request winning (the modsec page
// asks for /security/modsec and /security/modsec/hits?… at once).
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => {
    const key = [...responses.keys()].filter((k) => path === k || path.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = key ? responses.get(key) : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const forkBomb = await import('../src/pages/fn/security-center/shell-fork-bomb-protection.jsx');
const hostAccess = await import('../src/pages/fn/security-center/host-access-control.jsx');
const modsec = await import('../src/pages/fn/security-center/modsecurity-tools.jsx');
const { forkBombBody, limitErrors, draftFrom, REQUIRED } = forkBomb;
const { sshdIgnoresRules, SshdNotice } = hostAccess;
const { hitLogLabel, hitsSubtitle } = modsec;

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const fnOf = (key) => FUNCTION_BY_KEY[`security-center/${key}`] || { key, label: key };

// Shape of sec.fork_bomb.get: maxMemoryMb is only present when the file
// carries an "as" line; memoryFloorMb and warnings always are.
const forkBombState = (over = {}) => ({ path: '/etc/security/limits.d/90-whm-forkbomb.conf', supported: true, enabled: true, memoryFloorMb: 4096, maxProcesses: 35, maxOpenFiles: 100, excludeGroups: ['wheel'], warnings: [], ...over });

describe('Shell Fork Bomb Protection › memory field', () => {
  it('leaves a cleared memory cap out of the body instead of sending 0 or null', () => {
    const draft = draftFrom(forkBombState());
    expect(draft.maxMemoryMb).toBeNull();
    const body = forkBombBody(draft, true);
    expect(body).toEqual({ enabled: true, maxProcesses: 35, maxOpenFiles: 100, excludeGroups: ['wheel'] });
    expect('maxMemoryMb' in body).toBe(false);
    expect(forkBombBody({ ...draft, maxMemoryMb: '' }, true)).not.toHaveProperty('maxMemoryMb');
    expect(forkBombBody({ ...draft, maxMemoryMb: 8192 }, true).maxMemoryMb).toBe(8192);
    expect(forkBombBody(draft, false)).toEqual({ enabled: false });
  });

  it('refuses empty mandatory limits and a cap under the runtime floor inline', () => {
    const ok = { maxProcesses: 35, maxOpenFiles: 100, maxMemoryMb: null, excludeGroups: [] };
    expect(limitErrors(ok, 4096)).toEqual({});
    expect(limitErrors({ ...ok, maxProcesses: null }, 4096)).toEqual({ maxProcesses: REQUIRED });
    expect(limitErrors({ ...ok, maxOpenFiles: null }, 4096).maxOpenFiles).toBe(REQUIRED);
    expect(limitErrors({ ...ok, maxMemoryMb: 512 }, 4096).maxMemoryMb).toMatch(/At least 4096 MB/);
    expect(limitErrors({ ...ok, maxMemoryMb: 4096 }, 4096)).toEqual({});
    expect(limitErrors({ ...ok, maxMemoryMb: 512 }, undefined)).toEqual({});
  });

  it('renders the memory field as optional with the floor, and surfaces the agent warnings for a legacy cap', () => {
    responses.clear();
    responses.set('/security/fork-bomb', { data: forkBombState() });
    const html = render(<forkBomb.default fn={fnOf('shell-fork-bomb-protection')} />);
    expect(html).toContain('placeholder="no limit"');
    expect(html).toContain('min="4096"');
    expect(html).toContain('refuses anything below 4096 MB');
    expect(html).toContain('Virtual memory cap');
    expect(html).toContain('>none<');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('>Save limits</button>');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save limits/);

    const warning = 'The current file caps virtual memory at 512 MB, which makes Node.js, Java and Go abort at startup in every account shell and cron job; raise the memory limit to at least 4096 MB, or disable and re-enable the protection to drop the cap';
    responses.set('/security/fork-bomb', { data: forkBombState({ maxMemoryMb: 512, warnings: [warning] }) });
    const legacy = render(<forkBomb.default fn={fnOf('shell-fork-bomb-protection')} />);
    expect(legacy).toContain('role="alert"');
    expect(legacy).toContain(warning);
    expect(legacy).toContain('At least 4096 MB');
    expect(legacy).toContain('>512 MB<');
    expect(legacy).toMatch(/<button[^>]*disabled=""[^>]*>Save limits/);
  });
});

const hostFiles = (sshd) => ({ allow: '', deny: '', denyManaged: true, supported: true, library: '/lib/x86_64-linux-gnu/libwrap.so.0', daemons: { sshd } });

describe('Host Access Control › sshd without libwrap', () => {
  it('says the rules are written but not honoured by sshd only when the probe answers false', () => {
    expect(sshdIgnoresRules(hostFiles(false))).toBe(true);
    expect(sshdIgnoresRules(hostFiles(true))).toBe(false);
    expect(sshdIgnoresRules(hostFiles(null))).toBe(false);
    expect(sshdIgnoresRules(undefined)).toBe(false);
    const html = renderToStaticMarkup(<MemoryRouter><SshdNotice files={hostFiles(false)} /></MemoryRouter>);
    expect(html).toContain('does not consult these rules');
    expect(html).toContain('libwrap.so');
    expect(html).toContain('6.7');
    expect(html).toContain('href="/security-center/cphulk-brute-force-protection"');
    expect(renderToStaticMarkup(<MemoryRouter><SshdNotice files={hostFiles(true)} /></MemoryRouter>)).toBe('');
    expect(renderToStaticMarkup(<MemoryRouter><SshdNotice files={hostFiles(null)} /></MemoryRouter>)).toBe('');
  });

  it('shows the notice on the page from the API answer', () => {
    responses.clear();
    responses.set('/security/host-access', { data: { rules: [{ id: 1, service: 'sshd', source: '192.0.2.0/24', action: 'allow', comment: null, position: 0 }], services: ['sshd', 'vsftpd'], files: hostFiles(false) } });
    const html = render(<hostAccess.default fn={fnOf('host-access-control')} />);
    expect(html).toContain('sshd on this host does not consult these rules');
    responses.set('/security/host-access', { data: { rules: [], services: ['sshd'], files: hostFiles(true) } });
    expect(render(<hostAccess.default fn={fnOf('host-access-control')} />)).not.toContain('does not consult these rules');
  });
});

const hitsPayload = () => ({
  file: '/var/log/apache2/error.log and 1 vhost error log under /var/log/whm/domlogs',
  errorLog: '/var/log/apache2/error.log',
  files: [
    { file: '/var/log/apache2/error.log', user: null, domain: null, readable: true },
    { file: '/var/log/whm/domlogs/alice/alice.example-error.log', user: 'alice', domain: 'alice.example', readable: false },
  ],
  truncated: false, available: true, total: 2,
  hits: [
    { ts: 'Thu Oct 30 10:00:01.000 2026', client: '203.0.113.5', hostname: 'alice.example', uri: '/wp-login.php', id: '941100', msg: 'XSS Attack Detected', severity: 'CRITICAL', action: 'deny', uniqueId: 'a1', log: '/var/log/whm/domlogs/alice/alice.example-error.log', user: 'alice', domain: 'alice.example' },
    { ts: 'Thu Oct 30 09:59:00.000 2026', client: '198.51.100.9', hostname: 'host.example.com', uri: '/', id: '920350', msg: 'Host header is a numeric IP', severity: 'WARNING', action: 'pass', uniqueId: 'b2', log: '/var/log/apache2/error.log', user: null, domain: null },
  ],
});

describe('ModSecurity Tools › per-hit log', () => {
  it('labels a hit by its domain, account or the server log', () => {
    expect(hitLogLabel({ log: '/x', user: 'alice', domain: 'alice.example' })).toBe('alice.example');
    expect(hitLogLabel({ log: '/x', user: 'alice', domain: null })).toBe('alice');
    expect(hitLogLabel({ log: '/var/log/apache2/error.log', user: null, domain: null })).toBe('server');
    expect(hitLogLabel({})).toBe('');
  });

  it('summarises the scanned logs, unreadable ones and truncation', () => {
    const data = hitsPayload();
    expect(hitsSubtitle(data)).toBe('Parsed from /var/log/apache2/error.log and 1 vhost error log under /var/log/whm/domlogs · 1 of 2 logs not readable');
    expect(hitsSubtitle({ ...data, truncated: true })).toContain('more vhost logs exist than were scanned');
    expect(hitsSubtitle({ ...data, available: false })).toContain('log not readable');
    expect(hitsSubtitle({ file: '/var/log/httpd/error_log', files: [{ file: '/var/log/httpd/error_log', readable: true }], available: true })).toBe('Parsed from /var/log/httpd/error_log');
    expect(hitsSubtitle(null)).toBeUndefined();
  });

  it('renders the Log column and the scanned-files list from the agent result', () => {
    responses.clear();
    responses.set('/security/modsec', { data: { installed: true, disabledRules: [] } });
    responses.set('/security/modsec/hits', { data: hitsPayload() });
    const html = render(<modsec.default fn={fnOf('modsecurity-tools')} />);
    expect(html).toContain('>Log<');
    expect(html).toContain('alice.example');
    expect(html).toContain('title="/var/log/whm/domlogs/alice/alice.example-error.log"');
    expect(html).toContain('alice.example-error.log</code>');
    expect(html).toContain('>server<');
    expect(html).toContain('Logs scanned (2)');
    expect(html).toContain('1 of 2 logs not readable');
    expect(html).toContain('pill-bad">no');
    expect(html).toContain('941100');
  });
});
