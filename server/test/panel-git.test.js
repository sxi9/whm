import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { repoName, repoDir, gitUrl, JOB_CLONE, JOB_PULL, JOB_DEPLOY, MAX_REPOS, DEFAULT_ROOT } from '../src/services/panel-git.js';

// A host whose git repositories live in memory: every op pins the directory
// under /home/<user> exactly as the agent does, so create, clone, pull,
// deploy and remove are checked end to end through panelScope and the
// auto-mounted sub-router.
function hostAgent() {
  const state = { repos: new Map(), failClone: null, failPull: null, keel: new Map() };
  const fail = (code, message, details = {}) => Object.assign(new Error(message), { agentError: true, code, details });
  const guard = (username, p) => { if (!p.startsWith(`/home/${username}/`)) throw fail('path_not_allowed', `${p} is not inside the home directory /home/${username}`); };
  const info = (username, dir) => {
    const r = state.repos.get(dir);
    return { path: dir, rel: dir.replace(`/home/${username}/`, ''), branch: r.branch, head: r.head, remotes: r.url ? [{ name: 'origin', url: r.url, push: r.url }] : [], dirty: r.dirty || 0, lastPullAt: r.lastPullAt || null, hasKeelYml: state.keel.has(dir) };
  };
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['git', 'setpriv', 'runuser'].includes(n)])),
    'git.init': ({ username, dir }) => {
      guard(username, dir);
      if (state.repos.has(dir)) throw fail('exists', `${dir} already is a git repository`);
      state.repos.set(dir, { branch: 'main', head: null, url: null });
      return { ...info(username, dir), created: true };
    },
    'git.clone': ({ username, dir, url }) => {
      guard(username, dir);
      if (state.repos.has(dir)) throw fail('exists', `${dir} already exists`);
      if (state.failClone) throw fail('not_found', `git clone: ${state.failClone}`, { stderr: `fatal: ${state.failClone}` });
      state.repos.set(dir, { branch: 'main', head: { sha: 'a'.repeat(40), short: 'aaaaaaaaaaaa', subject: 'Initial import', date: '2026-11-06T10:00:00+00:00' }, url });
      return { ...info(username, dir), url, output: 'Cloning into ...\nReceiving objects: 100%' };
    },
    'git.list': ({ username, root }) => {
      guard(username, root);
      const repos = [...state.repos.keys()].filter((d) => d.startsWith(`${root}/`) && !d.slice(root.length + 1).includes('/')).map((d) => ({ path: d, rel: d.replace(`/home/${username}/`, ''), name: d.slice(d.lastIndexOf('/') + 1) }));
      return { root, rel: root.replace(`/home/${username}/`, ''), repos, exists: true };
    },
    'git.info': ({ username, dir }) => {
      guard(username, dir);
      if (!state.repos.has(dir)) throw fail('not_found', `${dir} is not a git repository`);
      return info(username, dir);
    },
    'git.pull': ({ username, dir }) => {
      guard(username, dir);
      const r = state.repos.get(dir);
      if (!r) throw fail('not_found', `${dir} is not a git repository`);
      if (!r.url) throw fail('refused', 'no remote to pull from');
      if (state.failPull) throw fail('refused', `git pull cannot fast-forward: ${state.failPull}`, { stderr: state.failPull });
      const from = r.head?.sha ?? null;
      r.head = { sha: 'b'.repeat(40), short: 'bbbbbbbbbbbb', subject: 'Second commit', date: '2026-11-06T11:00:00+00:00' };
      r.lastPullAt = '2026-11-06T11:00:05.000Z';
      return { ...info(username, dir), from, updated: from !== r.head.sha, output: 'Updating aaaaaaa..bbbbbbb\nFast-forward' };
    },
    'git.deploy': ({ username, dir, dryRun }) => {
      guard(username, dir);
      if (!state.repos.has(dir)) throw fail('not_found', `${dir} is not a git repository`);
      const tasks = state.keel.get(dir);
      if (!tasks) throw fail('not_found', '.keel.yml is missing from the repository');
      if (tasks === 'bad') throw fail('invalid_args', 'task "curl x": "curl" is not one of cp, rsync, mkdir, rm, chmod');
      return { path: dir, rel: dir.replace(`/home/${username}/`, ''), dryRun, tasks: tasks.map((line, index) => ({ index, line, program: line.split(' ')[0], argv: [], ran: !dryRun, code: dryRun ? undefined : 0, output: '' })) };
    },
    'git.remove': ({ username, dir }) => {
      guard(username, dir);
      const removed = state.repos.delete(dir);
      return { path: dir, rel: dir.replace(`/home/${username}/`, ''), removed };
    },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  return agent;
}

describe('panel-git schemas', () => {
  it('accept plain names, home-relative folders and https/ssh URLs only', () => {
    for (const ok of ['probe-repo', 'site', 'a.b_c', 'X1']) expect(repoName.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-x', '.git', 'a/b', 'a b', 'x.git', '..', 'x'.repeat(65)]) expect(repoName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const ok of ['repositories/x', 'apps/site', 'public_html/app']) expect(repoDir.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '/abs', '-x', '../x', 'a/../b', 'a/./b', 'x\0y', 'a\nb']) expect(repoDir.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const ok of ['https://github.com/git/hello-world.git', 'https://gitlab.example.com:8443/group/sub/project', 'ssh://git@github.com/org/repo.git', 'ssh://git@host.example:2222/repo', 'git@github.com:org/repo.git']) expect(gitUrl.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['file:///etc/passwd', 'ext::sh -c id', 'http://github.com/org/repo', 'https://user:pw@github.com/org/repo', 'https://git@github.com/org/repo', 'ssh://root@host/repo', 'alice@host:repo', 'git@host:-x', 'https://github.com/../x', '-u', '', 'https://github.com/org/repo\n', 'https://github.com/org/repo x']) expect(gitUrl.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(JOB_CLONE).toBe('panel.git.clone');
    expect(DEFAULT_ROOT).toBe('repositories');
  });
});

describe('/api/panel/git', () => {
  let app;
  let alice;
  let aliceCsrf;
  let rootCsrf;
  const db = () => app.ctx.db;
  const state = () => app.agent.state;
  const rootPost = (p, body = {}) => app.http.post(p).set('X-CSRF-Token', rootCsrf).send(body);
  const audits = (action) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC').all(action);
  const get = (p) => alice.get(`/api/panel/git${p}`);
  const post = (p, body = {}) => alice.post(`/api/panel/git${p}`).set('X-CSRF-Token', aliceCsrf).send(body);
  const del = (p) => alice.delete(`/api/panel/git${p}`).set('X-CSRF-Token', aliceCsrf);
  const setFeature = (key, value) => db().prepare(`UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.features.${key}', json(?)) WHERE username = 'alice'`).run(JSON.stringify(value));
  const calls = (name) => app.agent.calls.filter((c) => c.name === name);
  const URL = 'https://github.com/git/hello-world.git';

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    rootCsrf = await app.login();
    app.ctx.jobs.start();
    await rootPost('/api/accounts', { username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await rootPost('/api/accounts', { username: 'bob', domain: 'bob.com', contactEmail: 'bob@bob.com' }).expect(201);
    await rootPost('/api/panel/admin/accounts/alice/password', { password: 'Alice-Passw0rd!' }).expect(200);
    const http = request.agent(app.ctx.app);
    const res = await http.post('/api/auth/login').send({ username: 'alice', password: 'Alice-Passw0rd!' });
    expect(res.status).toBe(200);
    alice = http;
    aliceCsrf = res.body.data.csrfToken;
  }, 60_000);
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; state().failClone = null; state().failPull = null; });

  it('lists nothing at first with the defaults', async () => {
    const res = await get('').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, max: MAX_REPOS, defaultRoot: 'repositories', unregistered: [] });
    expect(calls('git.list')[0].args).toEqual({ username: 'alice', root: '/home/alice/repositories' });
  });

  it('creates an empty repository under ~/repositories as the account (201)', async () => {
    const res = await post('', { name: 'probe-repo' }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'probe-repo', dir: 'repositories/probe-repo', url: null, info: { branch: 'main', head: null, remotes: [], hasKeelYml: false } });
    expect(calls('git.init')[0].args).toEqual({ username: 'alice', dir: '/home/alice/repositories/probe-repo' });
    expect(audits('panel.git.init')[0].target).toBe('alice');
    const list = await get('').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ name: 'probe-repo', present: true });
  });

  it('refuses a duplicate name, a nested or overlapping folder and an escaping folder', async () => {
    await post('', { name: 'probe-repo' }).expect(409);
    const nested = await post('', { name: 'inner', dir: 'repositories/probe-repo/sub' }).expect(409);
    expect(nested.body.error.message).toMatch(/inside repository "probe-repo"/);
    await post('', { name: 'outer', dir: 'repositories' }).expect(409);
    for (const dir of ['../etc', '/etc/x', '-flag', 'a/../../b']) {
      const res = await post('', { name: `bad${dir.length}`, dir }).expect(422);
      expect(res.body.error.fields.dir).toBeDefined();
    }
    expect(calls('git.init')).toHaveLength(0);
  });

  it('refuses file:, ext:: and userinfo URLs with 422 before any job is queued', async () => {
    for (const url of ['file:///home/bob/repo', 'ext::sh -c id', 'https://alice:secret@github.com/org/repo', 'ssh://root@host/repo', 'http://github.com/org/repo', 'git@host:-x']) {
      const res = await post('', { name: 'clone-bad', url }).expect(422);
      expect(res.body.error.fields.url, url).toBeDefined();
    }
    expect(calls('git.clone')).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = ?").get(JOB_CLONE).n).toBe(0);
  });

  it('clones a public repository through a job the account can follow (202)', async () => {
    const res = await post('', { name: 'hello', url: URL }).expect(202);
    expect(res.body.data).toMatchObject({ job: { id: expect.any(Number) }, name: 'hello', dir: 'repositories/hello', url: URL });
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ name: 'hello', dir: 'repositories/hello', info: { branch: 'main', head: { short: 'aaaaaaaaaaaa' } } });
    expect(calls('git.clone')[0].args).toEqual({ username: 'alice', dir: '/home/alice/repositories/hello', url: URL });
    const view = await get(`/jobs/${job.id}`).expect(200);
    expect(view.body.data.params).not.toHaveProperty('accountId');
    expect(view.body.data.params).not.toHaveProperty('abs');
    expect(view.body.data.logs.some((l) => /Receiving objects/.test(l.line))).toBe(true);
    const row = db().prepare("SELECT * FROM panel_git_repos WHERE name = 'hello'").get();
    expect(row).toMatchObject({ dir: 'repositories/hello', url: URL });
    expect(row.last_pull_at).toBeTruthy();
    expect(audits('panel.git.clone.done')[0].target).toBe('alice');
    const stream = await get(`/jobs/${job.id}/stream`).expect(200);
    expect(stream.headers['content-type']).toMatch(/text\/event-stream/);
    expect(stream.text).toContain('"type":"snapshot"');
  });

  it('a failed clone registers nothing and reports the reason', async () => {
    state().failClone = 'repository not found';
    const res = await post('', { name: 'missing', url: 'https://github.com/nobody/nothing.git' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/repository not found/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM panel_git_repos WHERE name = 'missing'").get().n).toBe(0);
    expect(audits('panel.git.clone.failed')[0].result).toBe('error');
  });

  it('shows the detail with what git says, and 404 for another account', async () => {
    const id = db().prepare("SELECT id FROM panel_git_repos WHERE name = 'hello'").get().id;
    const res = await get(`/${id}`).expect(200);
    expect(res.body.data).toMatchObject({ id, name: 'hello', url: URL, missing: false, info: { branch: 'main', remotes: [{ name: 'origin', url: URL }], dirty: 0, hasKeelYml: false } });
    await get('/999999').expect(404);
    // bob's session cannot read alice's repository
    await rootPost('/api/panel/admin/accounts/bob/password', { password: 'Bob-Passw0rd!!' }).expect(200);
    const bob = request.agent(app.ctx.app);
    await bob.post('/api/auth/login').send({ username: 'bob', password: 'Bob-Passw0rd!!' }).expect(200);
    await bob.get(`/api/panel/git/${id}`).expect(404);
  });

  it('pulls with --ff-only as a job and records the time', async () => {
    const id = db().prepare("SELECT id FROM panel_git_repos WHERE name = 'hello'").get().id;
    const res = await post(`/${id}/pull`).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ id, updated: true, from: 'a'.repeat(40), info: { head: { short: 'bbbbbbbbbbbb' } } });
    expect(calls('git.pull')[0].args).toEqual({ username: 'alice', dir: '/home/alice/repositories/hello' });
    expect(audits('panel.git.pull.done')[0].target).toBe('alice');
    state().failPull = 'Not possible to fast-forward, aborting.';
    const again = await post(`/${id}/pull`).expect(202);
    const failed = await waitForJob(app.ctx, again.body.data.job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/fast-forward/);
    expect(failed.error_code).toBe('refused');
  });

  it('deploys the .keel.yml tasks as a job (dry run first) and refuses when the file is missing', async () => {
    const id = db().prepare("SELECT id FROM panel_git_repos WHERE name = 'hello'").get().id;
    const none = await waitForJob(app.ctx, (await post(`/${id}/deploy`).expect(202)).body.data.job.id);
    expect(none.status).toBe('failed');
    expect(none.error).toMatch(/\.keel\.yml is missing/);
    state().keel.set('/home/alice/repositories/hello', ['mkdir -p ~/public_html/probe-git', 'cp -R index.html ~/public_html/probe-git/']);
    const dry = await waitForJob(app.ctx, (await post(`/${id}/deploy`, { dryRun: true }).expect(202)).body.data.job.id);
    expect(dry.status).toBe('done');
    expect(dry.result).toMatchObject({ dryRun: true, tasks: [{ ran: false }, { ran: false }] });
    expect(db().prepare('SELECT last_deploy_at FROM panel_git_repos WHERE id = ?').get(id).last_deploy_at).toBeNull();
    const run = await waitForJob(app.ctx, (await post(`/${id}/deploy`).expect(202)).body.data.job.id);
    expect(run.status).toBe('done');
    expect(run.result.tasks).toHaveLength(2);
    expect(calls('git.deploy').pop().args).toEqual({ username: 'alice', dir: '/home/alice/repositories/hello', dryRun: false });
    expect(db().prepare('SELECT last_deploy_at FROM panel_git_repos WHERE id = ?').get(id).last_deploy_at).toBeTruthy();
    expect(audits('panel.git.deploy.done')).toHaveLength(2);
    state().keel.set('/home/alice/repositories/hello', 'bad');
    const bad = await waitForJob(app.ctx, (await post(`/${id}/deploy`).expect(202)).body.data.job.id);
    expect(bad.status).toBe('failed');
    expect(bad.error).toMatch(/not one of cp, rsync/);
  });

  it('adopts a repository that already exists in a folder and lists unregistered ones', async () => {
    state().repos.set('/home/alice/repositories/handmade', { branch: 'dev', head: null, url: 'git@github.com:org/handmade.git' });
    const before = await get('').expect(200);
    expect(before.body.meta.unregistered).toEqual([{ dir: 'repositories/handmade', name: 'handmade' }]);
    const res = await post('', { name: 'handmade', adopt: true }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'handmade', dir: 'repositories/handmade', url: 'git@github.com:org/handmade.git', info: { branch: 'dev' } });
    expect(calls('git.init')).toHaveLength(0);
    await post('', { name: 'nope', url: URL, adopt: true }).expect(422);
    await post('', { name: 'nothing-there', adopt: true }).expect(404);
  });

  it('removes the repository directory and the row; files=false keeps the directory', async () => {
    const hello = db().prepare("SELECT id FROM panel_git_repos WHERE name = 'hello'").get().id;
    await del(`/${hello}`).expect(422);
    const res = await del(`/${hello}?confirm=true`).expect(200);
    expect(res.body.data).toMatchObject({ id: hello, unregistered: true, filesRemoved: true });
    expect(calls('git.remove')[0].args).toEqual({ username: 'alice', dir: '/home/alice/repositories/hello' });
    expect(state().repos.has('/home/alice/repositories/hello')).toBe(false);
    await get(`/${hello}`).expect(404);
    const handmade = db().prepare("SELECT id FROM panel_git_repos WHERE name = 'handmade'").get().id;
    const kept = await del(`/${handmade}?confirm=true&files=false`).expect(200);
    expect(kept.body.data).toMatchObject({ filesRemoved: false });
    expect(state().repos.has('/home/alice/repositories/handmade')).toBe(true);
    expect(calls('git.remove')).toHaveLength(1);
    expect(audits('panel.git.remove')).toHaveLength(2);
  });

  it('is gated by the gitversioncontrol feature and session-only for mutations', async () => {
    setFeature('gitversioncontrol', false);
    const res = await get('').expect(403);
    expect(res.body.error.code).toBe('feature_disabled');
    await post('', { name: 'x' }).expect(403);
    setFeature('gitversioncontrol', true);
    const tok = await post('/../security/tokens', { name: 'ci', scopes: ['panel:read', 'panel:files'] });
    if (tok.status === 201) {
      const bearer = request(app.ctx.app);
      await bearer.get('/api/panel/git').set('Authorization', `Bearer ${tok.body.data.token}`).expect(200);
      const refused = await bearer.post('/api/panel/git').set('Authorization', `Bearer ${tok.body.data.token}`).send({ name: 'viatoken' });
      expect([403]).toContain(refused.status);
    }
  });
});
