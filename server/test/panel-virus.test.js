import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { JOB_SCAN, SCAN_SCOPES, FEATURE } from '../src/services/panel-virus.js';

// A host with clamd: the scan op records what it was asked to scan and
// answers from a fixture, so the job, its stream and the removal are checked
// through the real /api/panel session flow (panelScope, auto-mounted router).
function hostAgent() {
  const state = { installed: true, findings: [], fail: null, removed: [] };
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { agentError: true, code, details });
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['setpriv', 'runuser', 'clamdscan', 'clamscan'].includes(n)])),
    'sec.clamav.detect': () => (state.installed ? { installed: true, version: '1.4.3', signatures: 27_600, freshclam: true, databaseAgeSec: 3600 } : { installed: false, version: null, signatures: null, freshclam: false, databaseAgeSec: null }),
    'sec.clamav.scan_as': ({ username, path }) => {
      if (!path.startsWith(`/home/${username}`)) throw fail('path_not_allowed', `${path} is not inside the home directory`);
      if (state.fail) throw fail(state.fail, 'clamdscan did not finish within 900s');
      return { username, home: `/home/${username}`, path, infected: state.findings.map((f) => ({ file: `/home/${username}/${f}`, signature: 'Win.Test.EICAR_HDB-1' })), errors: [], exitCode: state.findings.length ? 1 : 0, durationMs: 1234 };
    },
    'files.remove': ({ username, paths }) => { for (const p of paths) if (!p.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', p); state.removed.push(...paths); return { removed: paths.map((p) => p.replace(`/home/${username}/`, '')) }; },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

describe('panel-virus constants', () => {
  it('pins the three scopes under the home and names the job', () => {
    expect(JOB_SCAN).toBe('panel.clamav.scan');
    expect(FEATURE).toBe('virusscan');
    expect(SCAN_SCOPES).toEqual({ home: '', mail: 'mail', public_html: 'public_html' });
  });
});

describe('/api/panel/virus-scanner', () => {
  let app;
  let alice;
  let aliceCsrf;
  let bob;
  let bobCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const state = () => app.agent.state;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const get = (p = '') => alice.get(`/api/panel/virus-scanner${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/virus-scanner${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const setFeature = (username, key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = ?`).run(JSON.stringify(value), username);

  async function loginAs(username, password) {
    await rootPost(`/api/panel/admin/accounts/${username}/password`, { password }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username, password });
    expect(res.status).toBe(200);
    return [http, res.body.data.csrfToken];
  }

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    rootCsrf = await app.login();
    app.ctx.jobs.start();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    [alice, aliceCsrf] = await loginAs('alice', 'Alice-Passw0rd!');
    [bob, bobCsrf] = await loginAs('bob', 'Bob-Passw0rd!!');
  }, 60_000);
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; state().installed = true; state().findings = []; state().fail = null; state().removed.length = 0; });

  it('reports the engine, the scopes and an empty history', async () => {
    const res = await get().expect(200);
    expect(res.body.data.scanner).toEqual({ installed: true, version: '1.4.3', signatures: 27_600, databaseAgeSec: 3600 });
    expect(res.body.data.scopes).toEqual([{ key: 'home', path: '.' }, { key: 'mail', path: 'mail' }, { key: 'public_html', path: 'public_html' }]);
    expect(res.body.data.active).toBeNull();
    expect(res.body.data.history).toEqual([]);
  });

  it('refuses a scope outside the pinned three and a missing one', async () => {
    for (const body of [{ scope: '..' }, { scope: '/etc' }, { scope: 'home', extra: 1 }, {}, { scope: 'public_html/../..' }]) {
      const res = await post('/scans', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(calls('sec.clamav.scan_as')).toHaveLength(0);
  });

  it('scans public_html as the account, lists the findings relative to the home and audits', async () => {
    state().findings = ['public_html/eicar.txt', 'public_html/wp-content/uploads/x.php'];
    const res = await post('/scans', { scope: 'public_html' }).expect(202);
    expect(res.body.data.job.id).toBeTruthy();
    expect(res.body.data).toMatchObject({ scope: 'public_html', path: 'public_html' });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.infected).toEqual([
      { file: 'public_html/eicar.txt', signature: 'Win.Test.EICAR_HDB-1' },
      { file: 'public_html/wp-content/uploads/x.php', signature: 'Win.Test.EICAR_HDB-1' },
    ]);
    expect(job.result).toMatchObject({ scope: 'public_html', path: 'public_html', exitCode: 1, durationMs: 1234 });
    const scan = calls('sec.clamav.scan_as');
    expect(scan).toHaveLength(1);
    expect(scan[0].args).toEqual({ username: 'alice', path: '/home/alice/public_html', maxDurationSec: 900 });
    const shown = await get(`/scans/${job.id}`).expect(200);
    expect(shown.body.data.params).not.toHaveProperty('path');
    expect(shown.body.data.params).not.toHaveProperty('accountId');
    expect(shown.body.data.params).not.toHaveProperty('ownerId');
    expect(shown.body.data.params.scope).toBe('public_html');
    expect(shown.body.data.logs.map((l) => l.line)).toEqual(expect.arrayContaining([expect.stringMatching(/eicar\.txt: Win\.Test\.EICAR_HDB-1 FOUND/)]));
    expect(audits('panel.clamav.scan')[0]).toMatchObject({ target: 'alice' });
    expect(audits('panel.clamav.scan.done')[0]).toMatchObject({ target: 'alice' });
    const status = await get().expect(200);
    expect(status.body.data.history).toHaveLength(1);
    expect(status.body.data.history[0]).toMatchObject({ id: job.id, status: 'done' });
  });

  it('scans the whole home when asked and a clean scan says so', async () => {
    const res = await post('/scans', { scope: 'home' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.infected).toEqual([]);
    expect(calls('sec.clamav.scan_as')[0].args.path).toBe('/home/alice');
    expect(job.message).toBe('clean');
  });

  it('the stream answers a snapshot and the finished event for a finished job', async () => {
    const res = await post('/scans', { scope: 'mail' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    const stream = await get(`/scans/${job.id}/stream`).expect(200);
    expect(stream.headers['content-type']).toMatch(/text\/event-stream/);
    expect(stream.text).toContain('"type":"snapshot"');
    expect(stream.text).toContain('"status":"done"');
  });

  it('a failed scan (timeout) is a failed job with the agent code and an audit', async () => {
    state().fail = 'timeout';
    const res = await post('/scans', { scope: 'home' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error_code).toBe('timeout');
    expect(audits('panel.clamav.scan.failed')[0]).toMatchObject({ target: 'alice' });
  });

  it('another account never sees these jobs', async () => {
    const res = await post('/scans', { scope: 'home' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    await bob.get(`/api/panel/virus-scanner/scans/${job.id}`).expect(404);
    await bob.get(`/api/panel/virus-scanner/scans/${job.id}/stream`).expect(404);
    const status = await bob.get('/api/panel/virus-scanner').expect(200);
    expect(status.body.data.history).toEqual([]);
    expect(bobCsrf).toBeTruthy();
  });

  it('answers 501 without the engine and 403 without the feature', async () => {
    state().installed = false;
    const off = await get().expect(200);
    expect(off.body.data.scanner.installed).toBe(false);
    const res = await post('/scans', { scope: 'home' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('capability_missing');
    state().installed = true;
    setFeature('alice', 'virusscan', false);
    try {
      const gated = await get();
      expect(gated.status).toBe(403);
      expect(gated.body.error.code).toBe('feature_disabled');
    } finally { setFeature('alice', 'virusscan', true); }
    expect(calls('sec.clamav.scan_as')).toHaveLength(0);
  });

  it('removes infected files through the file manager, pinned under the home', async () => {
    const res = await post('/infected/remove', { paths: ['public_html/eicar.txt', 'mail/cur/bad'] }).expect(200);
    expect(res.body.data.removed).toEqual(['public_html/eicar.txt', 'mail/cur/bad']);
    expect(calls('files.remove')[0].args).toMatchObject({ username: 'alice', paths: ['/home/alice/public_html/eicar.txt', '/home/alice/mail/cur/bad'] });
    expect(audits('panel.clamav.remove')[0]).toMatchObject({ target: 'alice' });
    for (const paths of [['../bob/x'], ['/etc/passwd'], ['-rf'], [], ['.']]) {
      const bad = await post('/infected/remove', { paths });
      expect(bad.status, JSON.stringify(paths)).toBe(422);
    }
    expect(calls('files.remove')).toHaveLength(1);
  });

  it('starting a scan or deleting over an API token is refused; status is readable', async () => {
    const tok = await alice.post('/api/panel/tokens').set('X-CSRF-Token', aliceCsrf).send({ name: 'virus-probe', scopes: ['panel:read'] });
    expect(tok.status).toBe(201);
    const secret = tok.body.data.token;
    await app.http.get('/api/panel/virus-scanner').set('Authorization', `Bearer ${secret}`).expect(200);
    const refused = await app.http.post('/api/panel/virus-scanner/scans').set('Authorization', `Bearer ${secret}`).send({ scope: 'home' });
    expect(refused.status).toBe(403);
  });
});
