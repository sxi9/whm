import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { renderCrontab, parseCrontab, isValidSchedule, crontabBody, MAX_LINES } from '../src/services/panel-cron.js';

const BINS = { crontab: true, setpriv: true, useradd: true, usermod: true, userdel: true, chpasswd: true };

function hostAgent(state) {
  return createMockAgent({
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'cron.user.read': ({ username }) => {
      const raw = state.tables[username] ?? null;
      if (raw == null) return { username, exists: false, raw: '', env: [], jobs: [] };
      const parsed = parseCrontab(raw);
      return { username, exists: true, raw, env: parsed.env, jobs: parsed.jobs.map((j, i) => ({ id: `h${i}`, ...j, line: `${j.schedule} ${j.command}`, lineNumber: i + 1 })) };
    },
    'cron.user.write': ({ username, content }) => { state.tables[username] = content; const p = parseCrontab(content); return { username, lines: content ? content.split('\n').length - 1 : 0, jobs: p.jobs.length, env: p.env.length }; },
    'cron.user.remove': ({ username }) => { const existed = username in state.tables; delete state.tables[username]; return { username, existed }; },
  });
}

describe('crontab rendering', () => {
  it('renders env then jobs and parses back to the same structure', () => {
    const table = { env: [{ key: 'MAILTO', value: 'alice@alice.com' }, { key: 'PATH', value: '/usr/bin:/bin' }], jobs: [{ schedule: '0 3 * * *', command: '/home/alice/bin/backup.sh >/dev/null 2>&1' }, { schedule: '@reboot', command: 'php /home/alice/app/boot.php' }, { schedule: '*/5 * * * mon-fri', command: 'curl -s https://alice.com/cron' }] };
    const text = renderCrontab(table);
    expect(text).toBe('MAILTO=alice@alice.com\nPATH=/usr/bin:/bin\n0 3 * * * /home/alice/bin/backup.sh >/dev/null 2>&1\n@reboot php /home/alice/app/boot.php\n*/5 * * * mon-fri curl -s https://alice.com/cron\n');
    expect(parseCrontab(text)).toEqual(table);
    expect(renderCrontab({ env: [], jobs: [] })).toBe('');
    expect(parseCrontab('# comment\n\n@every x\nnot a job\n')).toEqual({ env: [], jobs: [] });
    expect(parseCrontab(renderCrontab({ jobs: [{ schedule: ' 1   2 3 4 5 ', command: 'x' }] })).jobs).toEqual([{ schedule: '1 2 3 4 5', command: 'x' }]);
  });

  it('validates schedules with lib/cron.js plus the @ aliases, @reboot included', () => {
    for (const s of ['* * * * *', '0 0 1 1 *', '*/10 * * * *', '0 4 * * sun', '@reboot', '@daily', '@hourly', '@midnight']) expect(isValidSchedule(s), s).toBe(true);
    for (const s of ['* * * * * *', '* * * *', '60 * * * *', '@every', 'now', '']) expect(isValidSchedule(s), s).toBe(false);
  });

  it('constrains environment keys, values and commands at the schema', () => {
    expect(crontabBody.safeParse({ env: [{ key: 'MAILTO', value: 'a@b.c' }], jobs: [] }).success).toBe(true);
    for (const key of ['mailto', 'MAIL-TO', '1A', 'A'.repeat(65), '']) expect(crontabBody.safeParse({ env: [{ key, value: 'x' }] }).success, key).toBe(false);
    expect(crontabBody.safeParse({ env: [{ key: 'A', value: 'x\ny' }] }).success).toBe(false);
    expect(crontabBody.safeParse({ env: [{ key: 'A', value: 'x'.repeat(1025) }] }).success).toBe(false);
    expect(crontabBody.safeParse({ jobs: [{ schedule: '* * * * *', command: 'a\rb' }] }).success).toBe(false);
    expect(crontabBody.safeParse({ jobs: [{ schedule: '* * * * *', command: 'x'.repeat(2001) }] }).success).toBe(false);
    expect(crontabBody.safeParse({ jobs: [{ schedule: '* * * * *', command: 'x', extra: 1 }] }).success).toBe(false);
    expect(crontabBody.safeParse({ jobs: Array.from({ length: MAX_LINES + 1 }, () => ({ schedule: '* * * * *', command: 'x' })) }).success).toBe(false);
  });
});

describe('Panel cron API', () => {
  let app;
  let state;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const setFeature = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);
  const lastAudit = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
  const get = () => alice.get('/api/panel/cron');
  const put = (body) => alice.put('/api/panel/cron').set('X-CSRF-Token', aliceCsrf).send(body);
  const del = () => alice.delete('/api/panel/cron').set('X-CSRF-Token', aliceCsrf);

  beforeAll(async () => {
    state = { tables: {} };
    app = await createTestApp({ agent: hostAgent(state) });
    rootCsrf = await app.login();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    alice = request.agent(app.ctx.app);
    aliceCsrf = (await alice.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' })).body.data.csrfToken;
    state.tables.bob = '0 1 * * * /home/bob/secret.sh\n';
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  it('reads an empty table, writes one rendered from env and jobs, and reads it back', async () => {
    expect((await get()).body.data).toEqual({ exists: false, env: [], jobs: [], raw: '' });
    expect(app.agent.callsTo('cron.user.read')[0].args).toEqual({ username: 'alice' });
    const body = { env: [{ key: 'MAILTO', value: 'alice@alice.com' }], jobs: [{ schedule: '0 3 * * *', command: '/home/alice/bin/backup.sh' }, { schedule: '@reboot', command: 'php /home/alice/boot.php' }] };
    const res = await put(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ exists: true, lines: 3, env: body.env, jobs: body.jobs });
    expect(app.agent.callsTo('cron.user.write')[0].args).toEqual({ username: 'alice', content: 'MAILTO=alice@alice.com\n0 3 * * * /home/alice/bin/backup.sh\n@reboot php /home/alice/boot.php\n' });
    const back = await get();
    expect(back.body.data.exists).toBe(true);
    expect(back.body.data.env).toEqual(body.env);
    expect(back.body.data.jobs.map((j) => [j.schedule, j.command])).toEqual(body.jobs.map((j) => [j.schedule, j.command]));
    expect(back.body.data.jobs[0]).toMatchObject({ id: expect.any(String), line: '0 3 * * * /home/alice/bin/backup.sh' });
    const audit = lastAudit('panel.cron.set');
    expect(audit).toMatchObject({ principal: 'alice', role: 'user', target: 'alice' });
    expect(JSON.parse(audit.args_redacted)).toEqual({ jobs: 2, env: 1, lines: 3 });
    // The agent only ever hears the pinned username; bob's table is untouched.
    expect(state.tables.bob).toBe('0 1 * * * /home/bob/secret.sh\n');
    expect(app.agent.calls.every((c) => c.args.username === 'alice')).toBe(true);
  });

  it('refuses bad schedules, a 6-field line, a bad SHELL and more than 500 lines before the agent runs', async () => {
    const cases = [
      [{ jobs: [{ schedule: '* * * * * *', command: 'x' }] }, 'jobs.0.schedule'],
      [{ jobs: [{ schedule: '* * * * *', command: '* /bin/true' }] }, 'jobs.0.command'],
      [{ jobs: [{ schedule: '60 * * * *', command: 'x' }] }, 'jobs.0.schedule'],
      [{ jobs: [{ schedule: '@every', command: 'x' }] }, 'jobs.0.schedule'],
      [{ env: [{ key: 'SHELL', value: '/bin/zsh' }] }, 'env.0.value'],
      [{ env: [{ key: 'mailto', value: 'x' }] }, 'env.0.key'],
      [{ env: [{ key: 'A', value: 'x' }], jobs: Array.from({ length: MAX_LINES }, () => ({ schedule: '* * * * *', command: 'x' })) }, 'jobs'],
      [{ jobs: [{ schedule: '-r', command: 'x' }] }, 'jobs.0.schedule'],
    ];
    for (const [body, field] of cases) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(Object.keys(res.body.error.fields || {}), JSON.stringify(body).slice(0, 60)).toContain(field);
    }
    expect(app.agent.callsTo('cron.user.write')).toHaveLength(0);
  });

  it('turns a cron.deny refusal into 422 and a missing crontab into 501', async () => {
    app.agent.fail('cron.user.write', 'refused', 'cron refuses alice: You (alice) are not allowed to use this program (crontab)');
    const res = await put({ jobs: [{ schedule: '* * * * *', command: 'x' }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('refused');
    app.agent.fail('cron.user.read', 'capability_missing', 'crontab (cron) is not installed on this server');
    const missing = await get();
    expect(missing.status).toBe(501);
    expect(missing.body.error.code).toBe('capability_missing');
    app.agent.reset('cron.user.write');
    app.agent.reset('cron.user.read');
  });

  it('removes the table and audits it', async () => {
    state.tables.alice = '* * * * * x\n';
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: true, existed: true });
    expect(app.agent.callsTo('cron.user.remove')[0].args).toEqual({ username: 'alice' });
    expect(lastAudit('panel.cron.remove')).toMatchObject({ target: 'alice' });
    expect(state.tables.alice).toBeUndefined();
    expect((await del()).body.data.existed).toBe(false);
  });

  it('is gated by the cron feature of the package only', async () => {
    setFeature('alice', 'cron', false);
    try {
      for (const res of [await get(), await put({ jobs: [] }), await del()]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('feature_disabled');
      }
      expect(app.agent.calls.filter((c) => c.name.startsWith('cron.'))).toHaveLength(0);
    } finally { setFeature('alice', 'cron', true); }
    db().prepare("UPDATE accounts SET shell = '/usr/sbin/nologin' WHERE username = 'alice'").run();
    expect((await get()).status).toBe(200);
  });

  it('works for root acting as the account and marks the audit row', async () => {
    await rootPost('/api/panel/admin/login-as/alice').expect(200);
    try {
      const res = await app.http.put('/api/panel/cron').set('X-CSRF-Token', rootCsrf).send({ jobs: [{ schedule: '@daily', command: 'echo hi' }] });
      expect(res.status).toBe(200);
      expect(app.agent.callsTo('cron.user.write')[0].args.username).toBe('alice');
      const row = lastAudit('panel.cron.set');
      expect(row).toMatchObject({ principal: 'root', role: 'root', target: 'alice' });
      expect(JSON.parse(row.args_redacted)).toMatchObject({ actingAs: 'alice', by: 'root', jobs: 1 });
    } finally { await rootPost('/api/panel/admin/logout-as').expect(200); }
    expect((await app.http.get('/api/panel/cron')).status).toBe(403);
  });
});
