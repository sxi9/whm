import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { STACK_COMPONENTS, STACK_PROFILES, PACKAGE_FAMILIES, componentForCapability, componentForService, profileComponents } from '../src/lib/stack-catalog.js';
import { STACK_INSTALL_JOB } from '../src/services/system-stack.js';
import { SERVICE_REGISTRY, DEFAULT_SETTINGS } from '../src/db/seed.js';
import { resolveUnit } from '../src/lib/capabilities.js';

const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,99}$/;

describe('stack catalog', () => {
  it('gives every component both package families, a capability, a label and valid package names', () => {
    expect(STACK_COMPONENTS.length).toBeGreaterThanOrEqual(24);
    const keys = STACK_COMPONENTS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of STACK_COMPONENTS) {
      expect(c.key, c.key).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(typeof c.label).toBe('string');
      expect(typeof c.description).toBe('string');
      expect(typeof c.capability, c.key).toBe('string');
      expect(typeof c.recommended, c.key).toBe('boolean');
      for (const family of PACKAGE_FAMILIES) {
        expect(Array.isArray(c.packages[family]), `${c.key}.${family}`).toBe(true);
        expect(c.packages[family].length, `${c.key}.${family}`).toBeGreaterThan(0);
        for (const p of c.packages[family]) expect(p, `${c.key}.${family}`).toMatch(PKG_RE);
      }
      expect(Array.isArray(c.units)).toBe(true);
      for (const step of c.postInstall) expect(['a2enmod', 'enable', 'initdb']).toContain(step.kind);
      if (c.key === 'postgres') expect(c.postInstall.map((s) => s.kind)).toEqual(['initdb', 'enable']);
      if (c.service) expect(SERVICE_REGISTRY.some((s) => s.name === c.service), `${c.key} → ${c.service}`).toBe(true);
    }
    // The capabilities the owner's findings named all have an installer.
    for (const cap of ['apache', 'exim', 'modsecurity', 'awstats', 'webalizer', 'analog', 'mysql', 'bind', 'dovecot', 'acme', 'quota', 'spamassassin']) expect(componentForCapability(cap), cap).toBeTruthy();
    expect(componentForService('httpd').key).toBe('apache');
    expect(componentForService('imap').key).toBe('dovecot');
    expect(componentForService('sshd')).toBeNull();
  });

  it('lists every unit a component installs among its Service Manager row candidates', () => {
    // A unit the catalog installs but the registry row cannot see (php8.4-fpm
    // before the php*-fpm glob) leaves Service Manager saying "not installed"
    // right after a successful install.
    for (const c of STACK_COMPONENTS.filter((c) => c.service)) {
      const row = SERVICE_REGISTRY.find((s) => s.name === c.service);
      for (const unit of c.units) expect(resolveUnit(row.units, new Set([unit])), `${c.key}: ${unit} → ${c.service}`).toBe(unit);
    }
    expect(resolveUnit(SERVICE_REGISTRY.find((s) => s.name === 'php-fpm').units, new Set(['php8.5-fpm']))).toBe('php8.5-fpm');
  });

  it('installs the SpamAssassin daemon package on the Debian family, not just the CLI', () => {
    // On Debian 12 / Ubuntu 24.04 `spamassassin` does not pull in `spamd`, so without it the
    // component installs no systemd unit and Service Manager can never start spamd.
    const sa = componentForService('spamd');
    expect(sa.key).toBe('spamassassin');
    expect(sa.packages.debian).toContain('spamd');
    expect(sa.packages.debian).toContain('spamassassin');
    expect(sa.packages.debian).toContain('spamc');
    expect(sa.units).toContain('spamd');
    expect(sa.postInstall.map((s) => s.kind)).toContain('enable');
  });

  it('defines the full, web and manual profiles over known components', () => {
    expect(STACK_PROFILES.map((p) => p.key)).toEqual(['full', 'web', 'manual']);
    const keys = new Set(STACK_COMPONENTS.map((c) => c.key));
    for (const p of STACK_PROFILES) for (const k of p.components) expect(keys.has(k), `${p.key}: ${k}`).toBe(true);
    expect(profileComponents('full')).toEqual(STACK_COMPONENTS.filter((c) => c.recommended).map((c) => c.key));
    expect(profileComponents('web')).toEqual(['apache', 'php', 'mysql', 'acme', 'quota', 'firewall']);
    expect(profileComponents('manual')).toEqual([]);
    expect(profileComponents('nope')).toBeNull();
    expect(DEFAULT_SETTINGS['setup.completed']).toBe(false);
  });
});

describe('Server stack API', () => {
  let app;
  let csrf;
  let resellerHttp;
  let resellerCsrf;
  let binaries = { 'apt-get': true, 'dpkg-query': true };
  let units = [];
  let installedPackages = [];
  let unitStates = {};
  let pkgFamily = 'debian';
  const waitUntil = async (cond, timeoutMs = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > timeoutMs) throw new Error('condition not met in time'); await new Promise((r) => setTimeout(r, 20)); } };

  beforeAll(async () => {
    const agent = createMockAgent({
      'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(binaries[n])])),
      'svc.list_units': () => units,
      'svc.resolve': ({ candidates }) => ({ unit: candidates.find((c) => units.includes(c)) || candidates[0] }),
      'svc.status': ({ unit }) => ({ unit, installed: true, active: unitStates[unit] !== 'failed', state: unitStates[unit] || 'active', subState: 'running', enabled: true, pid: 10, memoryBytes: 1, restarts: 0 }),
      'svc.enable': ({ unit }) => ({ unit, verb: 'enable', output: '' }),
      'svc.reload': ({ unit }) => ({ unit, verb: 'reload', output: '' }),
      'svc.restart': ({ unit }) => { unitStates[unit] = 'active'; return { unit, verb: 'restart', output: '' }; },
      'svc.reset_failed': ({ unit }) => ({ unit, ok: true, output: '' }),
      'svc.journal': ({ unit, lines }) => ({ unit, lines: Array.from({ length: Math.min(lines, 3) }, (_, i) => `${unit} line ${i + 1}`) }),
      'pkg.detect': () => (binaries['apt-get'] ? (pkgFamily === 'rhel' ? { manager: 'dnf', family: 'rhel', binary: 'dnf', rpm: true, rebootRequired: false } : { manager: 'apt', family: 'debian', binary: 'apt-get', rpm: false, rebootRequired: false }) : { manager: null, family: null, binary: null, rpm: false, rebootRequired: false }),
      'pkg.update_index': () => ({ manager: 'apt', output: ['Reading package lists...'] }),
      'pkg.list_installed': ({ prefix }) => ({ manager: 'apt', total: installedPackages.length, packages: installedPackages.filter((p) => !prefix || prefix.some((pre) => p === pre || p.startsWith(pre))).map((name) => ({ name, version: '1', arch: 'amd64', summary: '' })) }),
      'pkg.install': ({ packages }) => { installedPackages.push(...packages); return { manager: 'apt', packages, output: [`installed ${packages.join(' ')}`] }; },
      'stack.apache_enmod': ({ modules }) => ({ skipped: false, enabled: modules, alreadyEnabled: [], failed: [], reloaded: false }),
      'stack.postgres_initdb': () => ({ skipped: false, initialised: true, dataDir: '/var/lib/pgsql/data', output: [] }),
    });
    app = await createTestApp({ agent });
    app.ctx.jobs.start();
    csrf = await app.login();
    const reseller = await app.createUser('resell1', 'reseller');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; installedPackages = []; });

  const post = (path, body = {}) => app.http.post(`/api/system${path}`).set('X-CSRF-Token', csrf).send(body);
  const auditRows = (action) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

  it('registers ctx.stack and the stack.install job once', () => {
    expect(app.ctx.stack).toBeDefined();
    expect(app.ctx.jobs.types().filter((t) => t === STACK_INSTALL_JOB)).toHaveLength(1);
  });

  it('is root only', async () => {
    await resellerHttp.get('/api/system/stack').expect(403);
    const r = (p, body) => resellerHttp.post(`/api/system${p}`).set('X-CSRF-Token', resellerCsrf).send(body);
    await r('/stack/install', { profile: 'web' }).expect(403);
    await r('/capabilities/apache/install', {}).expect(403);
    await r('/services/httpd/install', {}).expect(403);
    await r('/services/httpd/repair', {}).expect(403);
    await r('/setup/complete', {}).expect(403);
    expect(app.agent.calls).toHaveLength(0);
  });

  it('reports every component with installed/active state, the package manager and the profiles', async () => {
    units = ['apache2', 'mariadb'];
    await app.ctx.capabilities.refresh();
    const { body } = await app.http.get('/api/system/stack').expect(200);
    expect(body.data.packageManager).toBe('apt');
    expect(body.data.family).toBe('debian');
    expect(body.data.pkgAvailable).toBe(true);
    expect(body.data.profiles.map((p) => p.key)).toEqual(['full', 'web', 'manual']);
    expect(body.data.components).toHaveLength(STACK_COMPONENTS.length);
    const apache = body.data.components.find((c) => c.key === 'apache');
    expect(apache).toMatchObject({ installed: true, unit: 'apache2', active: true, service: 'httpd', packages: ['apache2'] });
    const exim = body.data.components.find((c) => c.key === 'exim');
    expect(exim).toMatchObject({ installed: false, unit: null, active: null, packages: ['exim4-daemon-heavy', 'exim4-config'], requires: null });
    // A component without a binary or unit counts as installed when its packages are.
    installedPackages = ['libapache2-mod-security2', 'modsecurity-crs'];
    const again = await app.http.get('/api/system/stack').expect(200);
    expect(again.body.data.components.find((c) => c.key === 'modsecurity')).toMatchObject({ installed: true, packagesInstalled: true });
    installedPackages = [];
    units = [];
    await app.ctx.capabilities.refresh();
  });

  it('rejects unknown components, empty selections and bad profiles', async () => {
    await post('/stack/install', { components: ['git', 'bogus'] }).expect(422);
    await post('/stack/install', { profile: 'nope' }).expect(422);
    await post('/stack/install', {}).expect(422);
    await post('/stack/install', { profile: 'manual' }).expect(422);
    await post('/stack/install', { components: ['git'], extra: 1 }).expect(422);
    expect(app.ctx.jobs.list({ type: STACK_INSTALL_JOB })).toHaveLength(0);
  });

  it('installs a profile as one job that runs pkg.install per component, the post-install steps and a capability refresh', async () => {
    installedPackages = ['php-cli'];
    const res = await post('/stack/install', { profile: 'web' }).expect(202);
    expect(res.body.data.components).toEqual(['apache', 'php', 'mysql', 'acme', 'quota', 'firewall']);
    const jobId = res.body.data.job.id;
    expect(app.ctx.jobs.list({ type: STACK_INSTALL_JOB })).toHaveLength(1);
    const job = await waitForJob(app.ctx, jobId);
    expect(job.status, JSON.stringify(job.logs)).toBe('done');
    expect(job.result.family).toBe('debian');
    expect(job.result.failed).toEqual([]);
    expect(job.result.results.map((r) => r.key)).toEqual(['apache', 'php', 'mysql', 'acme', 'quota', 'firewall']);
    const installs = app.agent.callsTo('pkg.install');
    expect(installs).toHaveLength(6);
    expect(installs[0].args).toMatchObject({ packages: ['apache2'], wait: false });
    // Already-present packages are not installed again.
    expect(installs[1].args.packages).not.toContain('php-cli');
    expect(installs[1].args.packages).toContain('php-fpm');
    expect(installs[2].args.packages).toEqual(['mariadb-server', 'mariadb-client']);
    const order = app.agent.calls.map((c) => c.name);
    expect(order.indexOf('pkg.install')).toBeGreaterThan(order.indexOf('pkg.detect'));
    // The index is refreshed once, after detection and before any install.
    expect(app.agent.callsTo('pkg.update_index')).toHaveLength(1);
    expect(app.agent.callsTo('pkg.update_index')[0].args).toEqual({ wait: false });
    expect(order.indexOf('pkg.update_index')).toBeGreaterThan(order.indexOf('pkg.detect'));
    expect(order.indexOf('pkg.update_index')).toBeLessThan(order.indexOf('pkg.install'));
    expect(job.logs.some((l) => /Reading package lists/.test(l.line))).toBe(true);
    expect(app.agent.callsTo('stack.apache_enmod')[0].args.modules).toContain('rewrite');
    expect(app.agent.callsTo('svc.resolve').every((c) => c.args.fresh === true)).toBe(true);
    expect(app.agent.callsTo('svc.enable').map((c) => c.args.unit)).toEqual(expect.arrayContaining(['apache2', 'php-fpm', 'mariadb']));
    // Capability detection re-ran after the last component.
    expect(app.agent.callsTo('sys.binaries').length).toBeGreaterThan(0);
    expect(order.lastIndexOf('sys.binaries')).toBeGreaterThan(order.lastIndexOf('pkg.install'));
    expect(job.logs.some((l) => /mariadb enabled and started/.test(l.line))).toBe(true);
    const audit = auditRows('stack.install');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ profile: 'web', jobId });
    installedPackages = [];
  });

  it('keeps going when one component fails and reports it', async () => {
    app.agent.set('pkg.install', ({ packages }) => { if (packages.includes('exim4-daemon-heavy')) throw Object.assign(new Error('E: Unable to locate package exim4-daemon-heavy'), { agentError: true, code: 'command_failed' }); return { manager: 'apt', packages, output: [] }; });
    const res = await post('/stack/install', { components: ['exim', 'git'] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.failed).toEqual(['exim']);
    expect(job.result.results.find((r) => r.key === 'git')).toMatchObject({ ok: true, installed: ['git'] });
    expect(job.logs.some((l) => l.level === 'error' && /Unable to locate/.test(l.line))).toBe(true);
    app.agent.reset('pkg.install');
    app.agent.set('pkg.install', ({ packages }) => ({ manager: 'apt', packages, output: [] }));
  });

  it('fails the job when nothing could be installed', async () => {
    app.agent.fail('pkg.install', 'command_failed', 'apt-get exited with status 100');
    const res = await post('/stack/install', { components: ['rsync'] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/No component could be installed/);
    app.agent.set('pkg.install', ({ packages }) => ({ manager: 'apt', packages, output: [] }));
  });

  it('installs the component behind a capability and answers 404 for one the catalog lacks', async () => {
    const res = await post('/capabilities/awstats/install').expect(202);
    expect(res.body.data.component).toEqual({ key: 'awstats', label: 'AWStats' });
    expect(res.body.data.components).toEqual(['awstats']);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('pkg.install')[0].args.packages).toEqual(['awstats']);
    await post('/capabilities/nope/install').expect(404);
    await post('/capabilities/pkg/install').expect(404);
    await post('/capabilities/Bad%20Name/install').expect(422);
  });

  it('installs the component behind a Service Manager row', async () => {
    const res = await post('/services/httpd/install').expect(202);
    expect(res.body.data.component.key).toBe('apache');
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status, JSON.stringify(job.logs)).toBe('done');
    expect(app.agent.callsTo('pkg.install').map((c) => c.args.packages), JSON.stringify(job.logs)).toEqual([['apache2']]);
    await post('/services/sshd/install').expect(404);
    await post('/services/unknown-svc/install').expect(404);
  });

  it('answers 501 when the host has no package manager', async () => {
    binaries = {};
    await app.ctx.capabilities.refresh();
    const res = await post('/stack/install', { profile: 'full' }).expect(501);
    expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'pkg' });
    const status = await app.http.get('/api/system/stack').expect(200);
    expect(status.body.data).toMatchObject({ packageManager: null, pkgAvailable: false });
    expect(status.body.data.components.find((c) => c.key === 'git').packages).toEqual([]);
    binaries = { 'apt-get': true, 'dpkg-query': true };
    await app.ctx.capabilities.refresh();
  });

  it('repairs a service: reset-failed, restart, then status with the journal tail', async () => {
    units = ['apache2'];
    unitStates = { apache2: 'failed' };
    await app.ctx.capabilities.refresh();
    app.agent.calls.length = 0;
    const res = await post('/services/httpd/repair').expect(200);
    expect(res.body.data).toMatchObject({ name: 'httpd', unit: 'apache2', repaired: true });
    expect(res.body.data.steps).toEqual([{ step: 'reset-failed', ok: true }, { step: 'restart', ok: true }]);
    expect(res.body.data.status.active).toBe(true);
    expect(res.body.data.journal).toEqual(['apache2 line 1', 'apache2 line 2', 'apache2 line 3']);
    const names = app.agent.calls.map((c) => c.name).filter((n) => n.startsWith('svc.') && n !== 'svc.list_units');
    expect(names).toEqual(['svc.reset_failed', 'svc.restart', 'svc.status', 'svc.journal']);
    expect(app.agent.callsTo('svc.journal')[0].args).toEqual({ unit: 'apache2', lines: 30 });
    expect(auditRows('service.repair')).toHaveLength(1);
    // Still down after the restart: the response says so and carries the journal.
    app.agent.fail('svc.restart', 'command_failed', 'Job for apache2.service failed');
    unitStates = { apache2: 'failed' };
    const down = await post('/services/httpd/repair').expect(200);
    expect(down.body.data.repaired).toBe(false);
    expect(down.body.data.steps[1]).toMatchObject({ step: 'restart', ok: false });
    app.agent.reset('svc.restart');
    app.agent.set('svc.restart', ({ unit }) => { unitStates[unit] = 'active'; return { unit, verb: 'restart', output: '' }; });
    await post('/services/named/repair').expect(404);
    units = [];
    unitStates = {};
    await app.ctx.capabilities.refresh();
  });

  it('flags the setup wizard for root until it completes, never for a reseller', async () => {
    const me = await app.http.get('/api/auth/me').expect(200);
    expect(me.body.data.setupPending).toBe(true);
    expect(me.body.data.user.setupPending).toBe(true);
    const reseller = await resellerHttp.get('/api/auth/me').expect(200);
    expect(reseller.body.data.setupPending).toBe(false);
    expect(reseller.body.data.user.setupPending).toBe(false);
    await post('/setup/complete', { skipped: 'yes' }).expect(422);
    const done = await post('/setup/complete', { skipped: true }).expect(200);
    expect(done.body.data).toEqual({ completed: true, skipped: true });
    expect(app.ctx.settings.get('setup.completed')).toBe(true);
    expect(app.ctx.settings.get('setup.completed_reason')).toBe('skipped');
    expect((await app.http.get('/api/auth/me')).body.data.setupPending).toBe(false);
    expect(auditRows('setup.complete')).toHaveLength(1);
  });

  it('installs against the current index when the refresh fails', async () => {
    app.agent.fail('pkg.update_index', 'command_failed', 'E: Could not resolve deb.debian.org');
    const res = await post('/stack/install', { components: ['rsync'] }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(job.result.failed).toEqual([]);
    expect(job.logs.some((l) => l.level === 'warn' && /package index refresh failed: .*deb\.debian\.org.*current index/.test(l.line))).toBe(true);
    expect(app.agent.callsTo('pkg.install')).toHaveLength(1);
    app.agent.reset('pkg.update_index');
  });

  it('refuses a second installation while one is queued or running and reports it in the status', async () => {
    let release = null;
    app.agent.set('pkg.install', ({ packages }) => new Promise((resolve) => { release = () => resolve({ manager: 'apt', packages, output: [] }); }));
    const first = await post('/stack/install', { components: ['git'] }).expect(202);
    const id = first.body.data.job.id;
    await waitUntil(() => release && app.ctx.jobs.get(id).status === 'running');
    const second = await post('/stack/install', { components: ['rsync'] }).expect(409);
    expect(second.body.error.code).toBe('conflict');
    expect(second.body.error.message).toMatch(new RegExp(`job ${id}, ${STACK_INSTALL_JOB}.*running`));
    await post('/capabilities/awstats/install').expect(409);
    await post('/services/httpd/install').expect(409);
    const status = await app.http.get('/api/system/stack').expect(200);
    expect(status.body.data).toMatchObject({ installing: true, activeJob: { id, type: STACK_INSTALL_JOB, status: 'running' } });
    expect(app.ctx.jobs.list({ type: STACK_INSTALL_JOB, status: 'queued' })).toHaveLength(0);
    expect(auditRows('stack.install').filter((r) => JSON.parse(r.args_redacted).jobId === id)).toHaveLength(1);
    release();
    expect((await waitForJob(app.ctx, id)).status).toBe('done');
    expect((await app.http.get('/api/system/stack')).body.data).toMatchObject({ installing: false, activeJob: null });
    app.agent.set('pkg.install', ({ packages }) => ({ manager: 'apt', packages, output: [] }));
    // A Software package job holds the same lock.
    let releaseIndex = null;
    app.agent.set('pkg.update_index', () => new Promise((resolve) => { releaseIndex = () => resolve({ manager: 'apt', output: [] }); }));
    const { job: indexJob } = app.ctx.software.pkg.updateIndex({ id: 1, role: 'root' }, null);
    await waitUntil(() => releaseIndex);
    const blocked = await post('/stack/install', { components: ['git'] }).expect(409);
    expect(blocked.body.error.message).toMatch(new RegExp(`job ${indexJob.id}, software.pkg.update_index`));
    expect((await app.http.get('/api/system/stack')).body.data.activeJob).toMatchObject({ id: indexJob.id, type: 'software.pkg.update_index' });
    releaseIndex();
    await waitForJob(app.ctx, indexJob.id);
    app.agent.reset('pkg.update_index');
    await post('/stack/install', { components: ['git'] }).expect(202);
  });

  it('reloads a running Apache on the RHEL family after ModSecurity installs and initialises PostgreSQL before enabling it', async () => {
    pkgFamily = 'rhel';
    units = ['httpd'];
    unitStates = {};
    try {
      const res = await post('/stack/install', { components: ['modsecurity', 'postgres'] }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status, JSON.stringify(job.logs)).toBe('done');
      expect(job.result.family).toBe('rhel');
      expect(app.agent.callsTo('pkg.install').map((c) => c.args.packages)).toEqual([['mod_security', 'mod_security_crs'], ['postgresql-server', 'postgresql-contrib']]);
      expect(app.agent.callsTo('stack.apache_enmod')).toHaveLength(0);
      expect(app.agent.callsTo('svc.resolve').some((c) => c.args.candidates[0] === 'httpd' && c.args.fresh === true)).toBe(true);
      expect(app.agent.callsTo('svc.reload').map((c) => c.args.unit)).toEqual(['httpd']);
      const order = app.agent.calls.map((c) => c.name);
      expect(order.indexOf('svc.reload')).toBeGreaterThan(order.indexOf('pkg.install'));
      expect(order.indexOf('stack.postgres_initdb')).toBeGreaterThan(order.lastIndexOf('pkg.install'));
      expect(order.indexOf('stack.postgres_initdb')).toBeLessThan(order.indexOf('svc.enable'));
      expect(app.agent.callsTo('svc.enable').map((c) => c.args.unit)).toEqual(['postgresql']);
      const mods = job.result.results.find((r) => r.key === 'modsecurity');
      expect(mods.steps[0]).toMatchObject({ step: 'a2enmod', skipped: true, reloaded: true, unit: 'httpd' });
      expect(job.result.results.find((r) => r.key === 'postgres').steps.map((s) => s.step)).toEqual(['initdb', 'enable']);
      expect(job.logs.some((l) => /httpd reloaded/.test(l.line))).toBe(true);
      expect(job.logs.some((l) => /cluster initialised in \/var\/lib\/pgsql\/data/.test(l.line))).toBe(true);
      // Apache not running: nothing to reload, and the step says so.
      unitStates = { httpd: 'failed' };
      app.agent.calls.length = 0;
      const again = await post('/stack/install', { components: ['modsecurity'] }).expect(202);
      const job2 = await waitForJob(app.ctx, again.body.data.job.id);
      expect(job2.status).toBe('done');
      expect(app.agent.callsTo('svc.reload')).toHaveLength(0);
      expect(job2.logs.some((l) => /httpd is not running/.test(l.line))).toBe(true);
      // Debian keeps the a2enmod path and never calls initdb's op for a cluster that exists.
      pkgFamily = 'debian';
      unitStates = {};
      app.agent.set('stack.postgres_initdb', () => ({ skipped: true, reason: 'postgresql-setup is not available on this host; the distribution initialises the cluster itself' }));
      app.agent.calls.length = 0;
      const deb = await post('/stack/install', { components: ['postgres'] }).expect(202);
      const job3 = await waitForJob(app.ctx, deb.body.data.job.id);
      expect(job3.status).toBe('done');
      expect(job3.result.results[0].steps[0]).toMatchObject({ step: 'initdb', skipped: true });
      expect(job3.logs.some((l) => /postgresql-setup is not available/.test(l.line))).toBe(true);
    } finally { pkgFamily = 'debian'; units = []; unitStates = {}; app.agent.reset('stack.postgres_initdb'); }
  });

  it('carries setupPending on the user returned by login and by a forced password change', async () => {
    const other = await createTestApp();
    try {
      other.ctx.db.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'root'").run();
      const login = await other.http.post('/api/auth/login').send({ username: 'root', password: 'Test-Passw0rd!1' }).expect(200);
      expect(login.body.data.user).toMatchObject({ role: 'root', mustChangePassword: true, setupPending: true });
      const changed = await other.http.post('/api/auth/password').set('X-CSRF-Token', login.body.data.csrfToken).send({ newPassword: 'Another-Passw0rd!2' }).expect(200);
      expect(changed.body.data.user).toMatchObject({ username: 'root', role: 'root', mustChangePassword: false, setupPending: true });
      await other.http.post('/api/system/setup/complete').set('X-CSRF-Token', changed.body.data.csrfToken).send({ skipped: true }).expect(200);
      const again = await other.http.post('/api/auth/password').set('X-CSRF-Token', changed.body.data.csrfToken).send({ currentPassword: 'Another-Passw0rd!2', newPassword: 'Third-Passw0rd!3' }).expect(200);
      expect(again.body.data.user.setupPending).toBe(false);
      const reseller = await other.createUser('resell2', 'reseller');
      const rl = await request.agent(other.ctx.app).post('/api/auth/login').send({ username: 'resell2', password: reseller.password }).expect(200);
      expect(rl.body.data.user.setupPending).toBe(false);
    } finally { await other.close(); }
  });

  it('treats a server that already hosts accounts as set up', async () => {
    const other = await createTestApp();
    try {
      const rootCsrf = await other.login();
      expect(rootCsrf).toBeTruthy();
      expect((await other.http.get('/api/auth/me')).body.data.setupPending).toBe(true);
      other.ctx.db.prepare("INSERT INTO accounts (username, domain, owner_id) VALUES ('legacy', 'legacy.example.com', 1)").run();
      expect((await other.http.get('/api/auth/me')).body.data.setupPending).toBe(false);
      expect(other.ctx.settings.get('setup.completed')).toBe(true);
      expect(other.ctx.settings.get('setup.completed_reason')).toBe('existing-install');
    } finally { await other.close(); }
  });
});
