import { describe, it, expect, vi } from 'vitest';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const fixtures = vi.hoisted(() => ({ responses: new Map() }));

vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 7, username: 'demo', role: 'user' }, ready: true, refresh: async () => {}, logout: async () => {} }) }));
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: null, meta: null, error: null, loading: Boolean(path), refetch: () => {}, setData: () => {}, ...(fixtures.responses.get(path) || {}) }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PanelContext } = await import('../src/panel/hooks/usePanel.js');
const { ShellContext, PANEL_SHELL } = await import('../src/panel/ShellContext.js');
const { ToastProvider } = await import('../src/components/Toast.jsx');
const { ConfirmProvider } = await import('../src/components/Modal.jsx');
const { PANEL_FUNCTION_BY_KEY } = await import('../src/panel/nav.js');
const { default: CronJobs, describeSchedule, presetFor, mailtoOf, withMailto, splitSchedule, PRESETS } = await import('../src/pages/panel/cron/cron-jobs.jsx');

React.useLayoutEffect = React.useEffect;

const me = {
  user: { id: 7, username: 'demo', role: 'user' },
  account: { username: 'demo', domain: 'demo.example.com', homeDir: '/home/demo', contactEmail: 'owner@demo.example.com', package: 'starter', plan: {}, features: { cron: true }, limits: {}, domains: [] },
  usage: {}, counts: {}, actingAs: null, policy: {}, hostname: 'srv1.example', csrfToken: 't',
};
const ctx = { me, loading: false, error: null, reload: () => {}, hasFeature: () => true };
const fn = PANEL_FUNCTION_BY_KEY['panel:cron/cron-jobs'];
const render = (el) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [fn.path] }, h(ShellContext.Provider, { value: PANEL_SHELL }, h(PanelContext.Provider, { value: ctx }, h(ToastProvider, null, h(ConfirmProvider, null, el))))));
const set = (value) => fixtures.responses.set('/panel/cron', { loading: false, ...value });
const table = {
  exists: true,
  env: [{ key: 'MAILTO', value: 'ops@demo.example.com' }, { key: 'PATH', value: '/usr/local/bin:/usr/bin:/bin' }],
  jobs: [
    { id: 'a1', schedule: '*/15 * * * *', command: '/usr/bin/php /home/demo/public_html/cron.php >/dev/null 2>&1', line: 3 },
    { id: 'b2', schedule: '30 2 * * 1', command: '/home/demo/bin/backup.sh', line: 4 },
    { id: 'c3', schedule: '@reboot', command: '/home/demo/bin/start.sh', line: 5 },
  ],
  raw: '',
};

describe('Cron jobs page', () => {
  it('renders the email card, the add form with presets, the jobs table and the environment', () => {
    fixtures.responses.clear();
    set({ data: table });
    const html = render(h(CronJobs, { fn }));
    expect(html).toContain('<h1>Cron jobs</h1>');
    expect(html).toContain('Cron email');
    expect(html).toContain('value="ops@demo.example.com"');
    expect(html).toContain('Do not send any mail');
    expect(html).toContain('Add a cron job');
    expect(html).toContain('>Every 5 minutes</option>');
    expect(html).toContain('>Custom…</option>');
    expect(html).toContain('>Once a day (00:00)</option>');
    expect(html).toContain('placeholder="/usr/bin/php ~/public_html/cron.php"');
    expect(html).toContain('3 scheduled on this account');
    expect(html).toContain('Every 15 minutes');
    expect(html).toContain('Every Monday at 02:30');
    expect(html).toContain('When the server starts');
    expect(html).toContain('/home/demo/bin/backup.sh');
    expect(html).toContain('&gt;/dev/null 2&gt;&amp;1');
    expect(html).toContain('>Edit<');
    expect(html).toContain('Remove crontab');
    expect(html).toContain('<dt>PATH</dt>');
    expect(html).toContain('/usr/local/bin:/usr/bin:/bin');
    expect(html).toContain('aria-label="Remove PATH"');
    expect(html).not.toContain('<dt>MAILTO</dt>');
    expect(html).toContain('Set variable');
  });

  it('shows the custom schedule fields when the preset is custom', () => {
    fixtures.responses.clear();
    set({ data: { exists: false, env: [], jobs: [], raw: '' } });
    const html = render(h(CronJobs, { fn }));
    expect(html).toContain('No cron jobs yet');
    expect(html).toContain('placeholder="owner@demo.example.com"');
    expect(html).toContain('Leave empty to use the mailbox of demo');
    expect(html).not.toContain('Remove crontab');
    expect(html).not.toContain('id="cron-new-minute"');
  });

  it('renders the capability state on 501 with the forms still present', () => {
    fixtures.responses.clear();
    set({ error: { status: 501, code: 'capability_missing', message: 'crontab (cron) is not installed on this server' } });
    const html = render(h(CronJobs, { fn }));
    expect(html).toContain('Not available on this server');
    expect(html).toContain('crontab (cron) is not installed on this server');
    expect(html).toContain('Add a cron job');
    expect(html).toContain('once cron is available on this server');
  });

  it('renders the plan state on 403 feature_disabled', () => {
    fixtures.responses.clear();
    set({ error: { status: 403, code: 'feature_disabled', message: 'off' } });
    const html = render(h(CronJobs, { fn }));
    expect(html).toContain('Not included in your plan');
    expect(html).toContain('Cron jobs is not part of the hosting plan');
    expect(html).not.toContain('Add a cron job');
  });

  it('helpers: describeSchedule, presetFor, mailto handling', () => {
    expect(describeSchedule('* * * * *')).toBe('Every minute');
    expect(describeSchedule('*/5 * * * *')).toBe('Every 5 minutes');
    expect(describeSchedule('0 * * * *')).toBe('Every hour at minute 0');
    expect(describeSchedule('15 */6 * * *')).toBe('Every 6 hours at minute 15');
    expect(describeSchedule('0 0,12 * * *')).toBe('Every day at 00:00 and 12:00');
    expect(describeSchedule('30 2 * * 1')).toBe('Every Monday at 02:30');
    expect(describeSchedule('0 9 * * 1-5')).toBe('Monday to Friday at 09:00');
    expect(describeSchedule('0 0 1 * *')).toBe('Day 1 of every month at 00:00');
    expect(describeSchedule('0 0 1 1 *')).toBe('Every 1 January at 00:00');
    expect(describeSchedule('@daily')).toBe('Once a day');
    expect(describeSchedule('1,2 3 4 5 6')).toBe('Custom schedule');
    expect(describeSchedule('garbage')).toBe('Custom schedule');
    expect(presetFor('0  0 * * *')).toBe('0 0 * * *');
    expect(presetFor('7 7 * * *')).toBe('custom');
    expect(PRESETS.at(-1).value).toBe('custom');
    expect(splitSchedule('a b c d e')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(splitSchedule('a b')).toBeNull();
    expect(mailtoOf(table.env)).toBe('ops@demo.example.com');
    expect(mailtoOf([{ key: 'MAILTO', value: '""' }])).toBe('');
    expect(mailtoOf([])).toBeNull();
    expect(withMailto(table.env, null)).toEqual([{ key: 'PATH', value: '/usr/local/bin:/usr/bin:/bin' }]);
    expect(withMailto([{ key: 'PATH', value: 'x' }], 'a@b.co')[0]).toEqual({ key: 'MAILTO', value: 'a@b.co' });
  });
});
