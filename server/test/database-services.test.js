import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';

// What MariaDB (and MySQL <= 5.6) prints in the USAGE line of SHOW GRANTS: the
// account's password hash, which must never reach the API.
const MARIADB_HASH = '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19';

// A mock agent that behaves like a host with MariaDB installed: it keeps an
// in-memory catalogue of databases, users (per host) and grants so the service's
// bookkeeping can be checked end to end without a daemon.
function mysqlAgent() {
  const state = {
    databases: new Map([['mysql', { system: true }], ['information_schema', { system: true }], ['legacy_shop', { system: false }]]),
    // remote_app exists only at '%', as remote-application users typically do.
    users: new Map([['root@localhost', {}], ['legacy_app@localhost', {}], ['remote_app@%', {}]]),
    grants: new Map([['legacy_app@localhost', new Map([['legacy_shop', ['ALL PRIVILEGES']]])], ['remote_app@%', new Map([['legacy_shop', ['SELECT']]])]]),
    installed: [],
    processes: [{ id: 7, user: 'alice_app', host: 'localhost', db: 'alice_shop', command: 'Query', time: 12, state: 'Sending data', info: 'SELECT 1' }, { id: 9, user: 'root', host: 'localhost', db: null, command: 'Sleep', time: 400, state: '', info: null }],
    config: {},
    rootPassword: null,
    killed: [],
  };
  const hostsOf = (user) => [...state.users.keys()].filter((k) => k.startsWith(`${user}@`)).map((k) => k.split('@')[1]);
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['mysql', 'mysqld', 'mysqlcheck', 'mysqldump', 'mariadb-upgrade', 'systemctl'].includes(n)])),
    'svc.list_units': () => ['mariadb', 'ssh'],
    'db.detect': () => ({ installed: true, serverInstalled: true, engine: 'mariadb', binaries: { client: 'mysql', server: 'mysqld', check: 'mysqlcheck', dump: 'mysqldump', upgradeTool: 'mariadb-upgrade', psql: null, runuser: true }, units: ['mariadb', 'mysql', 'mysqld'], layout: { flavor: 'debian', managedInclude: '/etc/mysql/mariadb.conf.d/zz-whm.cnf', mainConf: '/etc/mysql/my.cnf', confDirs: ['/etc/mysql/conf.d', '/etc/mysql/mariadb.conf.d'], rootMyCnf: true }, postgres: { installed: false, dataDirs: [] } }),
    'db.version': () => ({ version: '10.11.6-MariaDB', comment: 'Debian 12', engine: 'mariadb', major: '10.11.6', port: 3306 }),
    'db.ping': ({ credentials }) => (credentials?.user === 'bad' ? { ok: false, code: 'db_auth_failed', error: 'Access denied', ms: 3 } : { ok: true, version: '10.11.6-MariaDB', user: `${credentials?.user || 'root'}@localhost`, ms: 4 }),
    'db.unit': () => ({ unit: 'mariadb', state: 'active', subState: 'running', pid: 1234 }),
    'db.databases.list': () => [...state.databases].map(([name, d]) => ({ name, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', sizeBytes: 4096, tables: 2, system: d.system })),
    'db.database.create': ({ name, charset, collation }) => { if (state.databases.has(name)) throw Object.assign(new Error(`MySQL: Can't create database '${name}'; database exists`), { agentError: true, code: 'exists', details: {} }); state.databases.set(name, { system: false }); return { name, charset, collation }; },
    'db.database.drop': ({ name }) => { state.databases.delete(name); return { name, dropped: true }; },
    'db.users.list': () => [...state.users.keys()].map((k) => { const [user, host] = k.split('@'); return { user, host, plugin: 'mysql_native_password', system: user === 'root' }; }),
    'db.user.create': ({ user, hosts }) => { for (const h of hosts) { if (state.users.has(`${user}@${h}`)) throw Object.assign(new Error('MySQL: Operation CREATE USER failed'), { agentError: true, code: 'exists', details: {} }); state.users.set(`${user}@${h}`, {}); } return { user, hosts }; },
    // Strict like a server without the op's existence filter: DROP USER at a
    // missing host fails as a whole with errno 1396.
    'db.user.drop': ({ user, hosts }) => { const targets = hosts || hostsOf(user); const missing = targets.filter((h) => !state.users.has(`${user}@${h}`)); if (missing.length) throw Object.assign(new Error(`MySQL: Operation DROP USER failed for '${user}'@'${missing[0]}'`), { agentError: true, code: 'exists', details: { errno: 1396 } }); for (const h of targets) { state.users.delete(`${user}@${h}`); state.grants.delete(`${user}@${h}`); } return { user, dropped: targets, missing: [] }; },
    'db.user.set_password': ({ user }) => { const hosts = hostsOf(user); if (!hosts.length) throw Object.assign(new Error(`No MySQL user named "${user}"`), { agentError: true, code: 'not_found', details: {} }); return { user, hosts }; },
    'db.user.add_host': ({ user, fromHost, toHost }) => { if (!state.users.has(`${user}@${fromHost}`)) throw Object.assign(new Error('missing'), { agentError: true, code: 'not_found', details: {} }); const created = !state.users.has(`${user}@${toHost}`); state.users.set(`${user}@${toHost}`, {}); state.grants.set(`${user}@${toHost}`, new Map(state.grants.get(`${user}@${fromHost}`) || [])); return { user, host: toHost, created, grants: 0 }; },
    'db.grants.list': ({ user, host }) => { if (!state.users.has(`${user}@${host}`)) throw Object.assign(new Error(`MySQL: There is no such grant defined for user '${user}' on host '${host}'`), { agentError: true, code: 'not_found', details: { errno: 1141 } }); const grants = [...(state.grants.get(`${user}@${host}`) || new Map())].map(([database, privileges]) => ({ database, table: '*', privileges })); return { user, host, raw: [`GRANT USAGE ON *.* TO \`${user}\`@\`${host}\` IDENTIFIED BY PASSWORD '${MARIADB_HASH}'`, ...grants.map((g) => `GRANT ${g.privileges.join(', ')} ON \`${g.database}\`.* TO \`${user}\`@\`${host}\``)], grants }; },
    'db.grant': ({ user, database, privileges, hosts }) => { for (const h of hosts) { const g = state.grants.get(`${user}@${h}`) || new Map(); g.set(database, privileges); state.grants.set(`${user}@${h}`, g); } return { user, database, privileges, hosts }; },
    'db.revoke': ({ user, database, hosts }) => { for (const h of hosts) state.grants.get(`${user}@${h}`)?.delete(database); return { user, database, hosts, revoked: true }; },
    'db.root_password.set': ({ password, updateMyCnf }) => { state.rootPassword = password; return { hosts: ['localhost', '127.0.0.1'], myCnfUpdated: updateMyCnf, path: updateMyCnf ? '/root/.my.cnf' : null }; },
    'db.processlist': () => state.processes,
    'db.kill': ({ id, queryOnly }) => { state.killed.push(id); return { id, queryOnly, killed: true }; },
    'db.check': ({ action, databases }) => ({ action, databases: databases || null, exitCode: 0, results: (databases || ['legacy_shop']).map((d) => ({ table: `${d}.orders`, status: action === 'repair' ? 'repaired' : 'ok', messages: [] })), summary: { tables: (databases || ['legacy_shop']).length, ok: action === 'repair' ? 0 : (databases || ['x']).length, repaired: action === 'repair' ? (databases || ['x']).length : 0, warnings: 0, errors: 0 }, stderr: '' }),
    'db.variables.get': () => ({ variables: { max_connections: '151', innodb_buffer_pool_size: '134217728' }, status: { Uptime: 100, Threads_connected: 3 } }),
    'db.config.read': () => ({ path: '/etc/mysql/mariadb.conf.d/zz-whm.cnf', exists: Object.keys(state.config).length > 0, raw: null, settings: { ...state.config }, files: [{ path: '/etc/mysql/my.cnf', mysqld: {} }], layout: { flavor: 'debian' } }),
    'db.config.write': ({ settings, replace }) => { if (settings['bogus-option'] !== undefined) throw Object.assign(new Error('The database server rejected the configuration; the previous file was restored: unknown variable'), { agentError: true, code: 'config_invalid', details: { output: 'unknown variable bogus-option' } }); if (replace) state.config = {}; for (const [k, v] of Object.entries(settings)) { if (v === null) delete state.config[k]; else state.config[k] = v; } return { path: '/etc/mysql/mariadb.conf.d/zz-whm.cnf', settings: { ...state.config }, validated: true, restartRequired: true }; },
    'db.restart': () => ({ unit: 'mariadb', state: 'active', subState: 'running', pid: 2345 }),
    'db.packages': () => ({ manager: 'apt', installed: [{ name: 'mariadb-server', version: '1:10.11.6-0+deb12u1', installed: true }], available: [{ name: 'mariadb-server', candidate: '1:10.11.8-0+deb12u1', installed: '1:10.11.6-0+deb12u1' }], engine: 'mariadb' }),
    'db.upgrade_tables': () => ({ ran: true, tool: 'mariadb-upgrade', exitCode: 0, output: 'OK' }),
    'db.dump': ({ path }) => ({ path, sizeBytes: 2048, databases: 'all' }),
    'db.phpmyadmin.detect': () => ({ installed: true, dir: '/usr/share/phpmyadmin', version: '5.2.1', configFile: '/etc/phpmyadmin/config.inc.php', webConfigs: [{ path: '/etc/apache2/conf-enabled/phpmyadmin.conf', enabled: true, server: 'apache', urlPath: '/phpmyadmin' }], urlPath: '/phpmyadmin', php: true, candidates: [], packageHint: 'apt-get install phpmyadmin' }),
    'pkg.install': ({ packages }) => { state.installed.push(...packages); return { manager: 'apt', packages, output: packages.map((p) => `Setting up ${p} (1:10.11.8-0+deb12u1) ...`) }; },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  agent.ops = ops;
  return agent;
}

// A host with only PostgreSQL: psql present, no mysql binaries, pg.* ops answer
// from an in-memory catalogue of databases, roles and database-level grants.
function pgAgent() {
  const state = {
    databases: new Map([['postgres', { owner: 'postgres' }], ['legacy_pg', { owner: 'legacy_role' }]]),
    roles: new Map([['postgres', { superuser: true }], ['legacy_role', { superuser: false }]]),
    grants: new Map([['legacy_role', new Map([['legacy_pg', ['ALL PRIVILEGES']]])]]),
    processes: [{ id: 4321, user: 'dana_app', host: '10.0.0.9', db: 'dana_shop', command: 'active', time: 3, state: 'active', info: 'SELECT 1' }],
    rootPassword: null,
    killed: [],
    restarts: 0,
    installed: [],
  };
  const fail = (code, message) => Object.assign(new Error(message), { agentError: true, code, details: {} });
  const ops = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, ['psql', 'pg_dump', 'runuser', 'systemctl'].includes(n)])),
    'svc.list_units': () => ['postgresql', 'ssh'],
    'db.detect': () => ({ installed: false, serverInstalled: false, engine: null, binaries: { client: null, server: null, check: null, dump: null, upgradeTool: null, psql: 'psql', runuser: true }, units: ['mariadb', 'mysql', 'mysqld'], layout: { flavor: null, mainConf: null, confDirs: [], managedInclude: null, dataDir: null, rootMyCnf: false }, postgres: { installed: true, dataDirs: ['/var/lib/postgresql'] } }),
    'pg.version': () => ({ version: 'PostgreSQL 16.3 (Debian 16.3-1.pgdg120+1) on x86_64-pc-linux-gnu', major: '16.3', engine: 'postgres' }),
    'pg.ping': ({ credentials }) => ({ ok: true, version: 'PostgreSQL 16.3', user: credentials?.user || 'postgres', ms: 2 }),
    'pg.unit': () => ({ unit: 'postgresql', state: 'active', subState: 'exited', pid: null, startedAt: null }),
    'pg.restart': () => { state.restarts += 1; return { unit: 'postgresql', state: 'active', subState: 'exited', pid: null }; },
    'pg.databases.list': () => [...state.databases].map(([name, d]) => ({ name, owner: d.owner, sizeBytes: 8192, charset: 'UTF8', collation: null, tables: null, system: name === 'postgres' })),
    'pg.database.create': ({ name, owner }) => { if (state.databases.has(name)) throw fail('exists', `PostgreSQL: database "${name}" already exists`); state.databases.set(name, { owner: owner || 'postgres' }); return { name, owner: owner || null }; },
    'pg.database.drop': ({ name }) => { if (!state.databases.has(name)) throw fail('not_found', `PostgreSQL: database "${name}" does not exist`); state.databases.delete(name); return { name, dropped: true }; },
    'pg.users.list': () => [...state.roles].map(([user, r]) => ({ user, host: null, plugin: null, superuser: r.superuser, login: true, system: user === 'postgres' })),
    'pg.user.create': ({ user }) => { if (state.roles.has(user)) throw fail('exists', `PostgreSQL: role "${user}" already exists`); state.roles.set(user, { superuser: false }); return { user, hosts: [] }; },
    'pg.user.drop': ({ user }) => { state.roles.delete(user); state.grants.delete(user); return { user, dropped: ['*'] }; },
    'pg.user.set_password': ({ user }) => { if (!state.roles.has(user)) throw fail('not_found', `PostgreSQL: role "${user}" does not exist`); return { user, hosts: [] }; },
    'pg.grants.list': ({ user }) => ({ user, host: null, raw: [], grants: [...(state.grants.get(user) || new Map())].map(([database, privileges]) => ({ database, table: '*', privileges })) }),
    'pg.grant': ({ user, database, privileges }) => { const g = state.grants.get(user) || new Map(); g.set(database, privileges); state.grants.set(user, g); return { user, database, privileges, hosts: [] }; },
    'pg.revoke': ({ user, database }) => { state.grants.get(user)?.delete(database); return { user, database, revoked: true }; },
    'pg.root_password.set': ({ password }) => { state.rootPassword = password; return { hosts: ['*'], myCnfUpdated: false, path: null }; },
    'pg.processlist': () => state.processes,
    'pg.kill': ({ id, queryOnly }) => { state.killed.push(id); return { id, queryOnly, killed: true }; },
    'pg.check': ({ action, databases }) => { const targets = databases || ['legacy_pg']; return { action, databases: targets, exitCode: 0, results: targets.map((d) => ({ table: `${d}.*`, status: 'ok', messages: [] })), summary: { tables: targets.length, ok: targets.length, repaired: 0, warnings: 0, errors: 0 }, stderr: '' }; },
    'pg.variables.get': () => ({ variables: { max_connections: '100', shared_buffers: '16384' }, status: { Uptime: 50, Threads_connected: 2, Threads_running: 1 } }),
    'db.packages': () => ({ manager: 'apt', installed: [{ name: 'postgresql-16', version: '16.3-1.pgdg120+1', installed: true }], available: [], engine: null }),
    'db.phpmyadmin.detect': () => ({ installed: false, dir: null, version: null, configFile: null, webConfigs: [], urlPath: null, php: false, candidates: [], packageHint: 'apt-get install phpmyadmin' }),
    'pkg.install': ({ packages }) => { state.installed.push(...packages); return { manager: 'apt', packages, output: ['Setting up postgresql-17 ...'] }; },
  };
  const agent = createMockAgent(ops);
  agent.state = state;
  agent.ops = ops;
  return agent;
}

describe('Database Services API (MariaDB via mock agent)', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  beforeAll(async () => {
    app = await createTestApp({ agent: mysqlAgent() });
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', owner: 'resell1' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com' }).expect(201);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const get = (path) => app.http.get(`/api/databases${path}`);
  const post = (path, body) => app.http.post(`/api/databases${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/databases${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/databases${path}`).set('X-CSRF-Token', csrf);
  const rGet = (path) => resellerHttp.get(`/api/databases${path}`);
  const rPost = (path, body) => resellerHttp.post(`/api/databases${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rPut = (path, body) => resellerHttp.put(`/api/databases${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rDel = (path) => resellerHttp.delete(`/api/databases${path}`).set('X-CSRF-Token', resellerCsrf);

  it('reports status with the active profile, engine detection and version', async () => {
    const res = await get('/status').expect(200);
    expect(res.body.data.profile).toMatchObject({ profile_name: 'localhost', engine: 'mysql', is_active: true, has_password: false });
    expect(res.body.data.detect.engine).toBe('mariadb');
    expect(res.body.data.detect.layout.managedInclude).toBe('/etc/mysql/mariadb.conf.d/zz-whm.cnf');
    expect(res.body.data.version.version).toBe('10.11.6-MariaDB');
    expect(res.body.data.capabilities.mysql).toBe(true);
    expect(res.body.data.unit.unit).toBe('mariadb');
  });

  it('hides the server layout, profile connection details and unit PID from resellers', async () => {
    const res = await rGet('/status').expect(200);
    expect(res.body.data.profile).toEqual({ id: expect.any(Number), profile_name: 'localhost', engine: 'mysql', is_local: true, is_active: true });
    expect(res.body.data.profile.host).toBeUndefined();
    expect(res.body.data.profile.admin_user).toBeUndefined();
    expect(res.body.data.detect).toEqual({ installed: true, serverInstalled: true, engine: 'mariadb', postgres: { installed: false } });
    expect(res.body.data.version).toEqual({ version: '10.11.6-MariaDB', engine: 'mariadb', major: '10.11.6' });
    expect(res.body.data.unit).toEqual({ unit: 'mariadb', state: 'active' });
    expect(res.body.data.capabilities.mysql).toBe(true);
    expect(JSON.stringify(res.body.data)).not.toMatch(/\/etc\/mysql|\/var\/lib|rootMyCnf|binaries|pid/);
  });

  describe('Manage Databases', () => {
    it('creates a prefixed database for an account and records the mapping', async () => {
      const res = await post('/databases', { name: 'shop', account: 'alice' }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'alice_shop', account: 'alice', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' });
      expect(res.body.data.quota).toMatchObject({ max: 10, used: 1, remaining: 9 });
      expect(app.agent.callsTo('db.database.create')[0].args).toEqual({ name: 'alice_shop', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' });
      expect(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'db.database.create' AND target = 'alice_shop'").get()).toBeTruthy();
      await post('/databases', { name: 'alice_shop', account: 'alice' }).expect(409);
    });

    it('lets root create unassigned databases but not resellers', async () => {
      await post('/databases', { name: 'shared_cache' }).expect(201);
      await rPost('/databases', { name: 'rogue' }).expect(403);
      await rPost('/databases', { name: 'x', account: 'bob' }).expect(403);
    });

    it('enforces the package database quota', async () => {
      app.ctx.db.prepare("UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.max_db', 1) WHERE username = 'alice'").run();
      const res = await post('/databases', { name: 'second', account: 'alice' }).expect(409);
      expect(res.body.error.message).toMatch(/database limit/);
      app.ctx.db.prepare("UPDATE accounts SET plan_snapshot_json = json_set(plan_snapshot_json, '$.max_db', 10) WHERE username = 'alice'").run();
    });

    it('validates names and rejects unknown fields and system databases', async () => {
      expect((await post('/databases', { name: 'Bad Name' }).expect(422)).body.error.fields.name).toBeDefined();
      await post('/databases', { name: 'ok_name', bogus: true }).expect(422);
      await post('/databases', { name: 'mysql' }).expect(400);
      await del('/databases/mysql').expect(400);
      await del('/databases/not%20valid').expect(422);
    });

    it('lists databases merged with server data, scoped per role', async () => {
      const root = await get('/databases?pageSize=100').expect(200);
      const names = root.body.data.map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(['alice_shop', 'legacy_shop', 'shared_cache']));
      expect(names).not.toContain('mysql');
      expect(root.body.data.find((d) => d.name === 'alice_shop')).toMatchObject({ account: 'alice', mapped: true, onServer: true, sizeBytes: 4096 });
      expect(root.body.data.find((d) => d.name === 'legacy_shop')).toMatchObject({ account: null, mapped: false });
      const mine = await rGet('/databases').expect(200);
      expect(mine.body.data.map((d) => d.name)).toEqual(['alice_shop']);
      expect(mine.body.meta.total).toBe(1);
      const withSystem = await get('/databases?system=true&pageSize=100').expect(200);
      expect(withSystem.body.data.some((d) => d.name === 'mysql')).toBe(true);
    });

    it('sorts by size through the wire key size_bytes; the camelCase field name fails the sort validator', async () => {
      const original = app.agent.ops['db.databases.list'];
      const sizes = { alice_shop: 1, legacy_shop: 99999 };
      app.agent.set('db.databases.list', () => original().map((d) => ({ ...d, sizeBytes: sizes[d.name] ?? 4096 })));
      try {
        const desc = await get('/databases?sort=size_bytes&dir=desc&pageSize=100').expect(200);
        expect(desc.body.data[0]).toMatchObject({ name: 'legacy_shop', sizeBytes: 99999 });
        const asc = await get('/databases?sort=size_bytes&pageSize=100').expect(200);
        expect(asc.body.data[0]).toMatchObject({ name: 'alice_shop', sizeBytes: 1 });
        expect(asc.body.data.map((d) => d.sizeBytes)).toEqual([...asc.body.data.map((d) => d.sizeBytes)].sort((a, b) => a - b));
        expect((await get('/databases?sort=sizeBytes').expect(422)).body.error.fields.sort).toBeDefined();
      } finally { app.agent.set('db.databases.list', original); }
    });

    it('resellers can drop their own databases only', async () => {
      await rDel('/databases/shared_cache').expect(403);
      await rDel('/databases/legacy_shop').expect(403);
      await post('/databases', { name: 'temp', account: 'alice' }).expect(201);
      const res = await rDel('/databases/alice_temp').expect(200);
      expect(res.body.data).toMatchObject({ name: 'alice_temp', dropped: true, account: 'alice' });
      expect(app.agent.callsTo('db.database.drop')).toHaveLength(1);
    });
  });

  describe('Manage Database Users and grants', () => {
    it('creates a prefixed user at localhost plus access hosts and grants the requested databases', async () => {
      await post('/access-hosts', { host: '203.0.113.5', account: 'alice' }).expect(201);
      const res = await post('/users', { name: 'app', password: 'Str0ng-Passw0rd!', account: 'alice', databases: ['alice_shop'] }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'alice_app', account: 'alice', hosts: ['localhost', '203.0.113.5'] });
      expect(res.body.data.grants).toEqual([{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }]);
      expect(app.agent.callsTo('db.user.create')[0].args).toMatchObject({ user: 'alice_app', hosts: ['localhost', '203.0.113.5'] });
      expect(app.agent.callsTo('db.user.create')[0].args.password).toBe('Str0ng-Passw0rd!');
      expect(app.agent.callsTo('db.grant')[0].args).toMatchObject({ user: 'alice_app', database: 'alice_shop', hosts: ['localhost', '203.0.113.5'] });
      const audit = app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action LIKE 'POST %/databases/users' ORDER BY id DESC LIMIT 1").get();
      expect(audit.args_redacted).toContain('[redacted]');
      expect(audit.args_redacted).not.toContain('Str0ng-Passw0rd!');
    });

    it('validates user input (password length, name charset, unknown fields)', async () => {
      expect((await post('/users', { name: 'x', password: 'short' }).expect(422)).body.error.fields.password).toBeDefined();
      await post('/users', { name: 'a;b', password: 'Str0ng-Passw0rd!' }).expect(422);
      await post('/users', { name: 'ok', password: 'Str0ng-Passw0rd!', extra: 1 }).expect(422);
      await post('/users', { name: 'root', password: 'Str0ng-Passw0rd!' }).expect(400);
    });

    it('checks the requested databases before creating the user, and drops it when the grant step fails', async () => {
      // A reseller naming a database it does not own is refused before CREATE USER.
      await rPost('/users', { name: 'rogue', password: 'Str0ng-Passw0rd!', account: 'alice', databases: ['shared_cache'] }).expect(403);
      await post('/users', { name: 'sys', password: 'Str0ng-Passw0rd!', account: 'alice', databases: ['mysql'] }).expect(400);
      expect(app.agent.callsTo('db.user.create')).toEqual([]);
      expect(app.ctx.db.prepare("SELECT 1 FROM db_users WHERE name IN ('alice_rogue', 'alice_sys')").get()).toBeUndefined();
      // The server refuses the GRANT: the freshly created user is removed again.
      app.agent.fail('db.grant', 'db_error', 'MySQL: GRANT failed');
      const res = await post('/users', { name: 'ghost', password: 'Str0ng-Passw0rd!', account: 'alice', databases: ['alice_shop'] });
      app.agent.set('db.grant', app.agent.ops['db.grant']);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(app.agent.callsTo('db.user.create')).toHaveLength(1);
      expect(app.agent.callsTo('db.user.drop')[0].args).toMatchObject({ user: 'alice_ghost' });
      expect(app.agent.state.users.has('alice_ghost@localhost')).toBe(false);
      expect(app.ctx.db.prepare("SELECT 1 FROM db_users WHERE name = 'alice_ghost'").get()).toBeUndefined();
    });

    it('edits grants as a diff of revoke/grant calls and refuses cross-account grants', async () => {
      await post('/databases', { name: 'blog', account: 'alice' }).expect(201);
      const res = await rPut('/users/alice_app/grants', { grants: [{ database: 'alice_blog', privileges: ['SELECT', 'INSERT', 'update'] }] }).expect(200);
      expect(res.body.data.grants).toEqual([{ database: 'alice_blog', privileges: ['INSERT', 'SELECT', 'UPDATE'] }]);
      expect(res.body.data.changes).toEqual(expect.arrayContaining([expect.objectContaining({ database: 'alice_shop', action: 'revoked' }), expect.objectContaining({ database: 'alice_blog', action: 'granted' })]));
      const live = await rGet('/users/alice_app/grants').expect(200);
      expect(live.body.data.grants).toEqual([{ database: 'alice_blog', privileges: ['INSERT', 'SELECT', 'UPDATE'], hosts: ['localhost', '203.0.113.5'], mixed: false }]);
      await rPut('/users/alice_app/grants', { grants: [{ database: 'shared_cache', privileges: ['SELECT'] }] }).expect(403);
      await rPut('/users/alice_app/grants', { grants: [{ database: 'alice_blog', privileges: ['SUPER'] }] }).expect(422);
      await rPut('/users/legacy_app/grants', { grants: [] }).expect(403);
      await put('/users/alice_app/grants', { grants: [{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }] }).expect(200);
    });

    it('reads grants at every host and revokes privileges that drifted onto one host only', async () => {
      // A manual GRANT on the remote host only: localhost knows nothing about it.
      app.agent.state.grants.get('alice_app@203.0.113.5').set('legacy_shop', ['SELECT']);
      const live = await get('/users/alice_app/grants').expect(200);
      expect(live.body.data.hosts).toEqual(['localhost', '203.0.113.5']);
      expect(live.body.data.grants).toEqual([
        { database: 'alice_shop', privileges: ['ALL PRIVILEGES'], hosts: ['localhost', '203.0.113.5'], mixed: false },
        { database: 'legacy_shop', privileges: ['SELECT'], hosts: ['203.0.113.5'], mixed: true },
      ]);
      expect(live.body.data.perHost['203.0.113.5'].map((g) => g.database)).toEqual(['alice_shop', 'legacy_shop']);
      expect(app.agent.callsTo('db.grants.list').map((c) => c.args.host).sort()).toEqual(['203.0.113.5', 'localhost']);
      app.agent.calls.length = 0;
      const res = await put('/users/alice_app/grants', { grants: [{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }] }).expect(200);
      expect(res.body.data.changes).toEqual([{ database: 'legacy_shop', action: 'revoked' }]);
      expect(app.agent.callsTo('db.revoke')).toHaveLength(1);
      expect(app.agent.callsTo('db.revoke')[0].args).toMatchObject({ user: 'alice_app', database: 'legacy_shop', hosts: ['localhost', '203.0.113.5'] });
      expect(app.agent.callsTo('db.grant')).toEqual([]);
      expect(app.agent.state.grants.get('alice_app@203.0.113.5').has('legacy_shop')).toBe(false);
      // Privileges that differ per host are normalised to the requested set everywhere.
      app.agent.state.grants.get('alice_app@203.0.113.5').set('alice_shop', ['SELECT']);
      app.agent.calls.length = 0;
      const fixed = await put('/users/alice_app/grants', { grants: [{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }] }).expect(200);
      expect(fixed.body.data.changes).toEqual([{ database: 'alice_shop', action: 'changed', privileges: ['ALL PRIVILEGES'] }]);
      expect(app.agent.callsTo('db.grant')[0].args).toMatchObject({ database: 'alice_shop', hosts: ['localhost', '203.0.113.5'] });
      expect(app.agent.state.grants.get('alice_app@203.0.113.5').get('alice_shop')).toEqual(['ALL PRIVILEGES']);
    });

    it('never returns the raw SHOW GRANTS text, which carries the password hash on MariaDB', async () => {
      expect(app.agent.ops['db.grants.list']({ user: 'alice_app', host: 'localhost' }).raw.join('\n')).toContain(MARIADB_HASH);
      for (const res of [await get('/users/alice_app/grants').expect(200), await rGet('/users/alice_app/grants').expect(200)]) {
        expect(res.body.data).not.toHaveProperty('raw');
        expect(res.body.data.grants).toEqual([{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'], hosts: ['localhost', '203.0.113.5'], mixed: false }]);
        expect(res.text).not.toContain(MARIADB_HASH);
        expect(res.text).not.toMatch(/IDENTIFIED BY/i);
      }
    });

    it('lists users with hosts and grants, scoped per role', async () => {
      const root = await get('/users?pageSize=100').expect(200);
      const alice = root.body.data.find((u) => u.name === 'alice_app');
      expect(alice).toMatchObject({ account: 'alice', mapped: true, onServer: true });
      expect(alice.hosts).toEqual(expect.arrayContaining(['localhost', '203.0.113.5']));
      expect(alice.grants).toEqual([{ database: 'alice_shop', privileges: ['ALL PRIVILEGES'] }]);
      expect(root.body.data.some((u) => u.name === 'root')).toBe(false);
      expect(root.body.data.find((u) => u.name === 'legacy_app')).toMatchObject({ mapped: false, account: null });
      const mine = await rGet('/users').expect(200);
      expect(mine.body.data.map((u) => u.name)).toEqual(['alice_app']);
    });

    it('changes a user password with ownership checks', async () => {
      await rPut('/users/alice_app/password', { password: 'N3w-Passw0rd!!' }).expect(200);
      expect(app.agent.callsTo('db.user.set_password')[0].args).toMatchObject({ user: 'alice_app', password: 'N3w-Passw0rd!!' });
      await rPut('/users/legacy_app/password', { password: 'N3w-Passw0rd!!' }).expect(403);
      await put('/users/root/password', { password: 'N3w-Passw0rd!!' }).expect(400);
      await put('/users/ghost_user/password', { password: 'N3w-Passw0rd!!' }).expect(404);
      await put('/users/alice_app/password', { password: 'short' }).expect(422);
    });

    it('root can create a user at explicit hosts without localhost and still edit its grants', async () => {
      const res = await post('/users', { name: 'remote_ro', password: 'Str0ng-Passw0rd!', hosts: ['203.0.113.77'], databases: ['shared_cache'] }).expect(201);
      expect(res.body.data).toMatchObject({ name: 'remote_ro', account: null, hosts: ['203.0.113.77'] });
      expect(app.agent.callsTo('db.user.create')[0].args.hosts).toEqual(['203.0.113.77']);
      expect(app.agent.callsTo('db.grant')[0].args).toMatchObject({ user: 'remote_ro', database: 'shared_cache', hosts: ['203.0.113.77'] });
      expect(app.agent.state.users.has('remote_ro@localhost')).toBe(false);
      const live = await get('/users/remote_ro/grants').expect(200);
      expect(live.body.data).toMatchObject({ hosts: ['203.0.113.77'], grants: [{ database: 'shared_cache', privileges: ['ALL PRIVILEGES'], hosts: ['203.0.113.77'], mixed: false }] });
      expect(app.agent.callsTo('db.grants.list').every((c) => c.args.host === '203.0.113.77')).toBe(true);
      await del('/users/remote_ro').expect(200);
    });

    it('drops users (reseller: own only)', async () => {
      await post('/users', { name: 'tmp', password: 'Str0ng-Passw0rd!', account: 'alice' }).expect(201);
      await rDel('/users/legacy_app').expect(403);
      const res = await rDel('/users/alice_tmp').expect(200);
      expect(res.body.data.dropped).toEqual(expect.arrayContaining(['localhost', '203.0.113.5']));
      expect(app.ctx.db.prepare("SELECT 1 FROM db_users WHERE name = 'alice_tmp'").get()).toBeUndefined();
    });
  });

  describe('Change Database Root Password', () => {
    it('rotates root everywhere, updates /root/.my.cnf and audits without the secret', async () => {
      const res = await put('/root-password', { password: 'R00t-Passw0rd!!' }).expect(200);
      expect(res.body.data).toMatchObject({ hosts: ['localhost', '127.0.0.1'], myCnfUpdated: true, profile: 'localhost' });
      expect(app.agent.state.rootPassword).toBe('R00t-Passw0rd!!');
      const audit = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'db.root_password'").get();
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain('R00t-Passw0rd');
      await put('/root-password', { password: 'short' }).expect(422);
      await rPut('/root-password', { password: 'R00t-Passw0rd!!' }).expect(403);
    });
  });

  describe('Database Map Tool', () => {
    it('shows server objects with mappings and prefix suggestions; assigns and unassigns', async () => {
      await post('/databases', { name: 'bob_legacy' }).expect(201);
      const res = await get('/map').expect(200);
      expect(res.body.data.databases.find((d) => d.name === 'legacy_shop')).toMatchObject({ account: null, onServer: true });
      expect(res.body.data.databases.find((d) => d.name === 'bob_legacy')).toMatchObject({ account: null, suggested: 'bob' });
      expect(res.body.data.users.find((u) => u.name === 'legacy_app')).toMatchObject({ account: null, hosts: ['localhost'] });
      expect(res.body.data.accounts).toEqual(['alice', 'bob']);
      await post('/map/assign', { kind: 'database', name: 'legacy_shop', account: 'bob' }).expect(200);
      await post('/map/assign', { kind: 'user', name: 'legacy_app', account: 'bob' }).expect(200);
      const after = await get('/map').expect(200);
      expect(after.body.data.databases.find((d) => d.name === 'legacy_shop').account).toBe('bob');
      expect(after.body.data.users.find((u) => u.name === 'legacy_app').account).toBe('bob');
      await post('/map/assign', { kind: 'database', name: 'legacy_shop', account: null }).expect(200);
      expect((await get('/map').expect(200)).body.data.databases.find((d) => d.name === 'legacy_shop').account).toBeNull();
      await post('/map/assign', { kind: 'database', name: 'legacy_shop', account: 'nobody' }).expect(404);
      await post('/map/assign', { kind: 'table', name: 'x' }).expect(422);
      await rGet('/map').expect(403);
      await rPost('/map/assign', { kind: 'database', name: 'legacy_shop', account: 'alice' }).expect(403);
    });

    it('adopts a user that only exists at % and edits its privileges at that host', async () => {
      expect((await get('/map').expect(200)).body.data.users.find((u) => u.name === 'remote_app')).toMatchObject({ account: null, hosts: ['%'], onServer: true });
      const assigned = await post('/map/assign', { kind: 'user', name: 'remote_app', account: 'bob' }).expect(200);
      expect(assigned.body.data).toMatchObject({ kind: 'user', account: 'bob', hosts: ['%'] });
      expect(app.ctx.db.prepare("SELECT h.host FROM db_user_hosts h JOIN db_users u ON u.id = h.db_user_id WHERE u.name = 'remote_app'").all().map((r) => r.host)).toEqual(['%']);
      const live = await get('/users/remote_app/grants').expect(200);
      expect(live.body.data).toMatchObject({ account: 'bob', hosts: ['%'], grants: [{ database: 'legacy_shop', privileges: ['SELECT'] }] });
      const edited = await put('/users/remote_app/grants', { grants: [{ database: 'legacy_shop', privileges: ['ALL PRIVILEGES'] }] }).expect(200);
      expect(edited.body.data).toMatchObject({ hosts: ['%'], changes: [{ database: 'legacy_shop', action: 'changed', privileges: ['ALL PRIVILEGES'] }] });
      expect(app.agent.callsTo('db.grants.list').map((c) => c.args.host)).toEqual(['%', '%']);
      expect(app.agent.callsTo('db.revoke')[0].args).toMatchObject({ user: 'remote_app', hosts: ['%'] });
      expect(app.agent.callsTo('db.grant')[0].args).toMatchObject({ user: 'remote_app', database: 'legacy_shop', hosts: ['%'] });
      expect(app.agent.state.users.has('remote_app@localhost')).toBe(false);
      expect(app.agent.state.grants.get('remote_app@%').get('legacy_shop')).toEqual(['ALL PRIVILEGES']);
      await get('/users/ghost_user/grants').expect(404);
    });
  });

  describe('Manage Database Access Hosts', () => {
    it('adds a host, clones existing users to it and removes it again', async () => {
      const add = await rPost('/access-hosts', { host: '198.51.100.%', account: 'alice' }).expect(201);
      expect(add.body.data).toMatchObject({ host: '198.51.100.%', account: 'alice', scope: 'account', supported: true });
      expect(add.body.data.applied).toEqual([{ user: 'alice_app', created: true }]);
      expect(app.agent.callsTo('db.user.add_host')[0].args).toEqual({ user: 'alice_app', fromHost: 'localhost', toHost: '198.51.100.%' });
      expect(app.agent.state.users.has('alice_app@198.51.100.%')).toBe(true);
      const list = await rGet('/access-hosts').expect(200);
      expect(list.body.data.map((h) => h.host)).toEqual(expect.arrayContaining(['203.0.113.5', '198.51.100.%']));
      await rPost('/access-hosts', { host: '198.51.100.%', account: 'alice' }).expect(409);
      await rPost('/access-hosts', { host: 'localhost', account: 'alice' }).expect(400);
      await rPost('/access-hosts', { host: 'bad host;', account: 'alice' }).expect(422);
      await rPost('/access-hosts', { host: '203.0.113.9' }).expect(403);
      await rPost('/access-hosts', { host: '203.0.113.9', account: 'bob' }).expect(403);
      const rm = await rDel(`/access-hosts/${add.body.data.id}`).expect(200);
      expect(rm.body.data.removedFrom).toEqual(['alice_app']);
      expect(app.agent.callsTo('db.user.drop')[0].args).toEqual({ user: 'alice_app', hosts: ['198.51.100.%'] });
      expect(app.agent.state.users.has('alice_app@198.51.100.%')).toBe(false);
      await rDel(`/access-hosts/${add.body.data.id}`).expect(404);
    });

    it('root manages global hosts that apply to every account user, skipping users never provisioned there on removal', async () => {
      const original = app.agent.ops['db.user.add_host'];
      app.agent.set('db.user.add_host', (args) => { if (args.user === 'legacy_app') throw Object.assign(new Error('MySQL: Operation CREATE USER failed for legacy_app@office.example.com'), { agentError: true, code: 'db_error', details: {} }); return original(args); });
      const add = await post('/access-hosts', { host: 'office.example.com' }).expect(201);
      app.agent.set('db.user.add_host', original);
      expect(add.body.data.scope).toBe('global');
      expect(add.body.data.applied.map((a) => a.user)).toEqual(expect.arrayContaining(['alice_app', 'remote_app']));
      expect(add.body.data.failed).toEqual([{ user: 'legacy_app', error: expect.stringMatching(/legacy_app/) }]);
      // The adopted user is cloned from the host it really exists at, not localhost.
      expect(app.agent.callsTo('db.user.add_host').find((c) => c.args.user === 'remote_app').args.fromHost).toBe('%');
      // Resellers see the global host their users were provisioned at, read-only.
      const mine = await rGet('/access-hosts').expect(200);
      expect(mine.body.data.find((h) => h.host === 'office.example.com')).toMatchObject({ scope: 'global', account: null, editable: false });
      expect(mine.body.data.find((h) => h.host === '203.0.113.5')).toMatchObject({ scope: 'account', account: 'alice', editable: true });
      expect((await rGet('/access-hosts?account=alice').expect(200)).body.data.map((h) => h.host)).toEqual(expect.arrayContaining(['203.0.113.5', 'office.example.com']));
      await rDel(`/access-hosts/${add.body.data.id}`).expect(403);
      app.agent.calls.length = 0;
      const rm = await del(`/access-hosts/${add.body.data.id}`).expect(200);
      expect(rm.body.data.removedFrom).toEqual(expect.arrayContaining(['alice_app', 'remote_app']));
      expect(rm.body.data.removedFrom).not.toContain('legacy_app');
      expect(app.agent.callsTo('db.user.drop').map((c) => c.args.user)).not.toContain('legacy_app');
      expect(app.ctx.db.prepare("SELECT 1 FROM db_access_hosts WHERE host = 'office.example.com'").get()).toBeUndefined();
      expect(app.agent.state.users.has('alice_app@office.example.com')).toBe(false);
    });

    it('does not record a host when no user could be provisioned at it', async () => {
      app.agent.fail('db.user.add_host', 'db_error', 'MySQL: Operation CREATE USER failed for alice_app@192.0.2.10');
      const res = await rPost('/access-hosts', { host: '192.0.2.10', account: 'alice' }).expect(502);
      expect(res.body.error.code).toBe('db_error');
      expect(res.body.error.message).toMatch(/alice_app/);
      expect(app.ctx.db.prepare("SELECT 1 FROM db_access_hosts WHERE host = '192.0.2.10'").get()).toBeUndefined();
      expect((await rGet('/access-hosts').expect(200)).body.data.map((h) => h.host)).not.toContain('192.0.2.10');
      app.agent.set('db.user.add_host', app.agent.ops['db.user.add_host']);
      const ok = await rPost('/access-hosts', { host: '192.0.2.10', account: 'alice' }).expect(201);
      expect(ok.body.data.failed).toEqual([]);
      await rDel(`/access-hosts/${ok.body.data.id}`).expect(200);
    });
  });

  describe('Manage Database Profiles', () => {
    it('creates, tests, activates, updates and deletes profiles (root only)', async () => {
      await rGet('/profiles').expect(403);
      const created = await post('/profiles', { profile_name: 'Remote MariaDB', engine: 'mariadb', host: 'db.example.net', port: 3307, admin_user: 'admin', admin_password: 'Adm1n-Secret!' }).expect(201);
      expect(created.body.data).toMatchObject({ profile_name: 'Remote MariaDB', engine: 'mariadb', host: 'db.example.net', port: 3307, is_local: false, is_active: false, has_password: true });
      expect(created.body.data.admin_password_enc).toBeUndefined();
      const stored = app.ctx.db.prepare('SELECT admin_password_enc FROM db_instances WHERE id = ?').get(created.body.data.id);
      expect(stored.admin_password_enc).toMatch(/^v1:/);
      expect(app.ctx.crypto.decrypt(stored.admin_password_enc)).toBe('Adm1n-Secret!');

      const test = await post(`/profiles/${created.body.data.id}/test`).expect(200);
      expect(test.body.data).toMatchObject({ ok: true, version: '10.11.6-MariaDB' });
      expect(app.agent.callsTo('db.ping')[0].args.credentials).toEqual({ host: 'db.example.net', port: 3307, user: 'admin', password: 'Adm1n-Secret!' });
      const list = await get('/profiles').expect(200);
      expect(list.body.data.find((p) => p.id === created.body.data.id).status).toMatchObject({ ok: true, version: '10.11.6-MariaDB' });

      await put(`/profiles/${created.body.data.id}`, { admin_user: 'bad' }).expect(200);
      const failed = await post(`/profiles/${created.body.data.id}/test`).expect(200);
      expect(failed.body.data.ok).toBe(false);

      await post('/profiles', { profile_name: 'Remote MariaDB', engine: 'mysql', host: 'localhost' }).expect(409);
      await post('/profiles', { profile_name: 'needs user', engine: 'mysql', host: 'db2.example.net' }).expect(400);
      await post('/profiles', { profile_name: 'bad', engine: 'oracle', host: 'localhost' }).expect(422);

      await post(`/profiles/${created.body.data.id}/activate`).expect(200);
      expect((await get('/status').expect(200)).body.data.profile.profile_name).toBe('Remote MariaDB');
      await del(`/profiles/${created.body.data.id}`).expect(409);
      const local = list.body.data.find((p) => p.profile_name === 'localhost');
      await post(`/profiles/${local.id}/activate`).expect(200);
      await del(`/profiles/${created.body.data.id}`).expect(200);
      await del(`/profiles/${created.body.data.id}`).expect(404);
    });
  });

  describe('Configure Remote Service IPs hook (ctx.databases.setClientAddresses)', () => {
    it('records the source address and binds connections to remote profiles to it', async () => {
      expect(app.ctx.databases.clientAddresses()).toEqual({ ipv4: null, ipv6: null });
      // Local profile active: recorded, nothing to verify yet.
      const saved = await app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.10', ipv6: null });
      expect(saved).toMatchObject({ applied: true, changed: true, verified: null, ipv4: '203.0.113.10', ipv6: null });
      expect(app.ctx.settings.get('db.client.bind_address_ipv4')).toBe('203.0.113.10');
      expect(app.agent.callsTo('db.ping')).toEqual([]);
      // Local connections never carry a bind address.
      await get('/databases').expect(200);
      expect(app.agent.callsTo('db.databases.list')[0].args.credentials).toBeUndefined();

      const remote = await post('/profiles', { profile_name: 'Remote', engine: 'mariadb', host: '198.51.100.20', admin_user: 'admin', admin_password: 'Adm1n-Secret!' }).expect(201);
      await post(`/profiles/${remote.body.data.id}/activate`).expect(200);
      app.agent.calls.length = 0;
      await get('/databases').expect(200);
      expect(app.agent.callsTo('db.databases.list')[0].args.credentials).toMatchObject({ host: '198.51.100.20', user: 'admin', bindAddress: '203.0.113.10' });

      // With a remote profile active the new address is verified with a connection test.
      app.agent.calls.length = 0;
      const audits = [];
      const verified = await app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.11', ipv6: '2001:db8::11' }, { audit: (e) => audits.push(e) });
      expect(verified).toMatchObject({ applied: true, changed: true, verified: true, warnings: [] });
      expect(app.agent.callsTo('db.ping')[0].args.credentials).toMatchObject({ host: '198.51.100.20', bindAddress: '203.0.113.11' });
      expect(audits).toEqual([{ action: 'db.client_addresses', target: 'Remote', args: { ipv4: '203.0.113.11', ipv6: '2001:db8::11', changed: true, verified: true } }]);

      // An IPv6 server picks the IPv6 source; a hostname prefers IPv4.
      await put(`/profiles/${remote.body.data.id}`, { host: '2001:db8::20' }).expect(200);
      app.agent.calls.length = 0;
      await get('/databases').expect(200);
      expect(app.agent.callsTo('db.databases.list')[0].args.credentials.bindAddress).toBe('2001:db8::11');
      await put(`/profiles/${remote.body.data.id}`, { host: 'db.example.net' }).expect(200);
      app.agent.calls.length = 0;
      await get('/databases').expect(200);
      expect(app.agent.callsTo('db.databases.list')[0].args.credentials.bindAddress).toBe('203.0.113.11');

      // A client that ignores bind-address is reported, not treated as a failure.
      app.agent.set('db.ping', ({ credentials }) => ({ ok: true, version: '10.11.6-MariaDB', user: `${credentials?.user}@h`, ms: 4, warnings: [`mariadb: unknown variable 'loose-bind-address=${credentials?.bindAddress}'`] }));
      const warned = await app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.12', ipv6: null });
      expect(warned.verified).toBe(true);
      expect(warned.warnings[0]).toMatch(/ignores bind-address/);

      // A failing connection keeps the previous address.
      app.agent.set('db.ping', () => ({ ok: false, code: 'db_unreachable', error: "Can't assign requested address", ms: 2 }));
      await expect(app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.99', ipv6: null })).rejects.toMatchObject({ status: 502, code: 'db_bind_failed' });
      expect(app.ctx.settings.get('db.client.bind_address_ipv4')).toBe('203.0.113.12');
      app.agent.set('db.ping', app.agent.ops['db.ping']);

      await expect(app.ctx.databases.setClientAddresses({ ipv4: 'not-an-ip' })).rejects.toMatchObject({ status: 422 });
      await expect(app.ctx.databases.setClientAddresses({ ipv6: '203.0.113.1' })).rejects.toMatchObject({ status: 422 });

      // Clearing is applied without a connection test.
      app.agent.calls.length = 0;
      expect(await app.ctx.databases.setClientAddresses({ ipv4: null, ipv6: null })).toMatchObject({ applied: true, changed: true, verified: null });
      expect(app.agent.callsTo('db.ping')).toEqual([]);
      expect(app.ctx.databases.clientAddresses()).toEqual({ ipv4: null, ipv6: null });

      const local = (await get('/profiles').expect(200)).body.data.find((p) => p.profile_name === 'localhost');
      await post(`/profiles/${local.id}/activate`).expect(200);
      await del(`/profiles/${remote.body.data.id}`).expect(200);
    });
  });

  describe('Edit Database Configuration', () => {
    it('reads the managed include with runtime variables and writes validated changes', async () => {
      const before = await get('/config').expect(200);
      expect(before.body.data).toMatchObject({ path: '/etc/mysql/mariadb.conf.d/zz-whm.cnf', exists: false });
      expect(before.body.data.runtime.variables.max_connections).toBe('151');
      expect(before.body.data.tunables.some((t) => t.key === 'max-connections')).toBe(true);
      const res = await put('/config', { settings: { 'max-connections': '300', 'innodb-buffer-pool-size': '1G' }, restart: true }).expect(200);
      expect(res.body.data.settings).toEqual({ 'max-connections': '300', 'innodb-buffer-pool-size': '1G' });
      expect(res.body.data.restart).toMatchObject({ unit: 'mariadb', state: 'active' });
      expect(app.agent.callsTo('db.restart')).toHaveLength(1);
      const removed = await put('/config', { settings: { 'innodb-buffer-pool-size': null } }).expect(200);
      expect(removed.body.data.settings).toEqual({ 'max-connections': '300' });
      expect(removed.body.data.restart).toBeNull();
      // Custom options in the managed include get a running value too.
      await put('/config', { settings: { 'innodb-io-capacity': '2000' } }).expect(200);
      app.agent.calls.length = 0;
      await get('/config').expect(200);
      const names = app.agent.callsTo('db.variables.get')[0].args.names;
      expect(names).toEqual(expect.arrayContaining(['max_connections', 'innodb_io_capacity']));
      expect(new Set(names).size).toBe(names.length);
      await put('/config', { settings: { 'innodb-io-capacity': null } }).expect(200);
      await put('/config', { settings: { 'max connections': '1' } }).expect(422);
      await put('/config', { settings: { 'max-connections': '1; rm -rf /' } }).expect(422);
      const invalid = await put('/config', { settings: { 'bogus-option': '1' } }).expect(400);
      expect(invalid.body.error.code).toBe('config_invalid');
      await rGet('/config').expect(403);
      await post('/restart').expect(200);
      expect((await get('/variables').expect(200)).body.data.status.Uptime).toBe(100);
    });
  });

  describe('Repair Databases', () => {
    it('runs mysqlcheck as a job and records history', async () => {
      const res = await post('/repair', { action: 'repair', databases: ['alice_shop'] }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(job.result.summary.repaired).toBe(1);
      expect(app.agent.callsTo('db.check')[0].args).toMatchObject({ action: 'repair', databases: ['alice_shop'], autoRepair: false });
      const history = await get('/repair').expect(200);
      expect(history.body.data.runs[0]).toMatchObject({ action: 'repair', databases: ['alice_shop'], job_status: 'done' });
      expect(history.body.data.runs[0].summary.repaired).toBe(1);
    });

    it('limits resellers to their own databases', async () => {
      await rPost('/repair', { databases: ['legacy_shop'] }).expect(403);
      const res = await rPost('/repair', {}).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.params.databases).toEqual(['alice_blog', 'alice_shop']);
      expect((await rGet('/repair').expect(200)).body.data.databases).toEqual(['alice_blog', 'alice_shop']);
      await post('/repair', { action: 'defrag' }).expect(422);
    });
  });

  describe('Show Database Processes', () => {
    it('lists live processes and kills one (root only)', async () => {
      const res = await get('/processes').expect(200);
      expect(res.body.data.processes).toHaveLength(2);
      expect(res.body.data.processes[0]).toMatchObject({ id: 7, user: 'alice_app' });
      await post('/processes/7/kill', { queryOnly: true }).expect(200);
      expect(app.agent.callsTo('db.kill')[0].args).toMatchObject({ id: 7, queryOnly: true });
      await post('/processes/abc/kill', {}).expect(422);
      await rGet('/processes').expect(403);
      await rPost('/processes/7/kill', {}).expect(403);
    });
  });

  describe('Upgrade Database Version', () => {
    it('reports packages and finishes with a not-available result when no package manager exists', async () => {
      const status = await get('/upgrade').expect(200);
      expect(status.body.data.packages.installed[0].name).toBe('mariadb-server');
      expect(status.body.data).toMatchObject({ packageManager: 'apt', installerAvailable: true });
      app.agent.set('db.packages', () => ({ manager: null, installed: [], available: [], engine: 'mariadb' }));
      expect((await get('/upgrade').expect(200)).body.data).toMatchObject({ packageManager: null, installerAvailable: false });
      const res = await post('/upgrade', { target: 'mariadb-server' }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      app.agent.set('db.packages', app.agent.ops['db.packages']);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ available: false, installed: false, versionBefore: '10.11.6-MariaDB' });
      expect(job.result.reason).toMatch(/package manager/);
      expect(app.agent.callsTo('pkg.install')).toEqual([]);
      expect(app.agent.callsTo('db.dump')).toEqual([]);
    });

    it('backs up, installs the package through the agent, restarts and upgrades tables', async () => {
      const res = await post('/upgrade', { target: 'mariadb-server' }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      expect(job.status).toBe('done');
      expect(app.agent.callsTo('db.packages')[0].args).toEqual({ candidates: ['mariadb-server'] });
      expect(app.agent.callsTo('pkg.install')).toHaveLength(1);
      expect(app.agent.callsTo('pkg.install')[0].args).toEqual({ packages: ['mariadb-server'] });
      expect(app.agent.state.installed).toEqual(['mariadb-server']);
      expect(job.result).toMatchObject({ installed: true, available: true, manager: 'apt', versionAfter: '10.11.6-MariaDB' });
      expect(job.result.backup.path).toMatch(/^\/var\/backups\/whm\/db\/pre-upgrade-/);
      expect(job.result.tablesUpgraded.ran).toBe(true);
      expect(app.agent.callsTo('db.restart')).toHaveLength(1);
      // The dump, the install and the restart run in that order.
      const order = app.agent.calls.map((c) => c.name).filter((n) => ['db.dump', 'pkg.install', 'db.restart', 'db.upgrade_tables'].includes(n));
      expect(order).toEqual(['db.dump', 'pkg.install', 'db.restart', 'db.upgrade_tables']);
      await post('/upgrade', { target: 'bad name' }).expect(422);
      await rPost('/upgrade', { target: 'mariadb-server' }).expect(403);
    });

    it('leaves the server alone when the package was already at the newest version', async () => {
      app.agent.set('pkg.install', ({ packages }) => ({ manager: 'apt', packages, output: [`${packages[0]} is already the newest version (1:10.11.8-0+deb12u1).`, '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'] }));
      const res = await post('/upgrade', { target: 'mariadb-server', backup: false }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      app.agent.set('pkg.install', app.agent.ops['pkg.install']);
      expect(job.status).toBe('done');
      expect(job.result).toMatchObject({ alreadyCurrent: true, installed: false, restarted: null, tablesUpgraded: null, versionBefore: '10.11.6-MariaDB', versionAfter: '10.11.6-MariaDB' });
      expect(job.result.reason).toMatch(/already at the newest version/);
      expect(app.agent.callsTo('db.restart')).toEqual([]);
      expect(app.agent.callsTo('db.upgrade_tables')).toEqual([]);
    });

    it('fails the job when the package manager cannot install the target', async () => {
      app.agent.fail('pkg.install', 'command_failed', 'E: Unable to locate package mariadb-server-99');
      const res = await post('/upgrade', { target: 'mariadb-server-99', backup: false }).expect(202);
      const job = await waitForJob(app.ctx, res.body.data.job.id);
      app.agent.set('pkg.install', app.agent.ops['pkg.install']);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/apt could not install mariadb-server-99/);
      expect(app.agent.callsTo('db.restart')).toEqual([]);
    });
  });

  describe('phpMyAdmin', () => {
    it('detects the install and builds the URL, with a root-only override', async () => {
      const res = await get('/phpmyadmin').expect(200);
      expect(res.body.data).toMatchObject({ installed: true, version: '5.2.1', urlPath: '/phpmyadmin' });
      expect(res.body.data.url).toMatch(/^https:\/\/.+\/phpmyadmin$/);
      expect(res.body.data.configFile).toBe('/etc/phpmyadmin/config.inc.php');
      await put('/phpmyadmin', { url: 'https://pma.example.com/' }).expect(200);
      const mine = await rGet('/phpmyadmin').expect(200);
      expect(mine.body.data).toEqual({ installed: true, version: '5.2.1', url: 'https://pma.example.com/', php: true, featureEnabled: true });
      expect(JSON.stringify(mine.body.data)).not.toMatch(/\/usr\/share|\/etc\/|webConfigs|candidates|packageHint/);
      await rPut('/phpmyadmin', { url: '' }).expect(403);
      await put('/phpmyadmin', { url: 'javascript:alert(1)' }).expect(422);
      await put('/phpmyadmin', { url: '//evil.example/pma' }).expect(422);
      await put('/phpmyadmin', { url: 'https:///nohost' }).expect(422);
      await put('/phpmyadmin', { url: '/pma' }).expect(200);
      await put('/phpmyadmin', { url: '' }).expect(200);
    });
  });

  describe('per-account summary', () => {
    it('exposes databases, users, access hosts and quota for an account', async () => {
      const res = await rGet('/accounts/alice').expect(200);
      expect(res.body.data.databases.map((d) => d.name)).toEqual(['alice_blog', 'alice_shop']);
      expect(res.body.data.users[0]).toMatchObject({ name: 'alice_app' });
      expect(res.body.data.accessHosts).toEqual(['203.0.113.5']);
      expect(res.body.data.quota).toMatchObject({ max: 10, used: 2 });
      expect(res.body.data.prefix).toBe('alice_');
      await rGet('/accounts/bob').expect(403);
      await get('/accounts/nobody').expect(404);
    });

    it('removeAccountData drops everything an account owns', async () => {
      const result = await app.ctx.databases.removeAccountData('alice');
      expect(result.users).toEqual(['alice_app']);
      expect(result.databases).toEqual(['alice_blog', 'alice_shop']);
      expect(app.agent.state.databases.has('alice_shop')).toBe(false);
      expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM databases WHERE name LIKE 'alice_%'").get().n).toBe(0);
    });
  });
});

describe('Database Services API without a database server', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'carol', domain: 'carol.com' }).expect(201);
  });
  afterAll(() => app.close());

  it('answers 501 capability_missing for every engine-backed function and never calls a db.* op', async () => {
    const calls = [
      () => app.http.get('/api/databases/databases'),
      () => app.http.get('/api/databases/users'),
      () => app.http.post('/api/databases/databases').set('X-CSRF-Token', csrf).send({ name: 'shop', account: 'carol' }),
      () => app.http.post('/api/databases/users').set('X-CSRF-Token', csrf).send({ name: 'app', password: 'Str0ng-Passw0rd!', account: 'carol' }),
      () => app.http.put('/api/databases/root-password').set('X-CSRF-Token', csrf).send({ password: 'R00t-Passw0rd!!' }),
      () => app.http.get('/api/databases/map'),
      () => app.http.get('/api/databases/processes'),
      () => app.http.post('/api/databases/repair').set('X-CSRF-Token', csrf).send({}),
      () => app.http.get('/api/databases/variables'),
      () => app.http.post('/api/databases/access-hosts').set('X-CSRF-Token', csrf).send({ host: '203.0.113.5', account: 'carol' }),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status, res.request?.url).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'mysql' });
    }
    expect(app.agent.calls.filter((c) => c.name.startsWith('db.') && c.name !== 'db.detect')).toEqual([]);
  });

  it('status, profiles, access-host listing and phpMyAdmin still work', async () => {
    const status = await app.http.get('/api/databases/status').expect(200);
    expect(status.body.data.capabilities.mysql).toBe(false);
    expect(status.body.data.version).toBeNull();
    expect((await app.http.get('/api/databases/profiles').expect(200)).body.data).toHaveLength(1);
    expect((await app.http.get('/api/databases/access-hosts').expect(200)).body.data).toEqual([]);
    const pma = await app.http.get('/api/databases/phpmyadmin').expect(200);
    expect(pma.body.data.installed).toBe(false);
    const upgrade = await app.http.get('/api/databases/upgrade').expect(200);
    expect(upgrade.body.data.error).toMatchObject({ code: 'capability_missing' });
  });

  it('config editing reports the missing engine through the agent', async () => {
    app.agent.fail('db.config.read', 'capability_missing', 'No MySQL/MariaDB configuration directory exists on this server');
    const res = await app.http.get('/api/databases/config');
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('capability_missing');
  });

  it('setClientAddresses records the address, then reports the missing client tools as a capability error', async () => {
    app.agent.calls.length = 0;
    await expect(app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.10', ipv6: null })).rejects.toMatchObject({ status: 501, code: 'capability_missing', capability: 'mysql' });
    expect(app.ctx.databases.clientAddresses()).toEqual({ ipv4: '203.0.113.10', ipv6: null });
    expect(app.agent.calls.filter((c) => c.name.startsWith('db.') && c.name !== 'db.detect')).toEqual([]);
  });

  it('names the postgres capability when the active profile is PostgreSQL', async () => {
    const created = await app.http.post('/api/databases/profiles').set('X-CSRF-Token', csrf).send({ profile_name: 'Local PostgreSQL', engine: 'postgres', host: 'localhost' }).expect(201);
    expect(created.body.data).toMatchObject({ engine: 'postgres', port: 5432, is_local: true });
    await app.http.post(`/api/databases/profiles/${created.body.data.id}/activate`).set('X-CSRF-Token', csrf).expect(200);
    for (const call of [
      () => app.http.get('/api/databases/databases'),
      () => app.http.get('/api/databases/users'),
      () => app.http.put('/api/databases/root-password').set('X-CSRF-Token', csrf).send({ password: 'R00t-Passw0rd!!' }),
      () => app.http.get('/api/databases/processes'),
      () => app.http.get('/api/databases/variables'),
      () => app.http.post('/api/databases/repair').set('X-CSRF-Token', csrf).send({}),
      () => app.http.post('/api/databases/restart').set('X-CSRF-Token', csrf),
    ]) {
      const res = await call();
      expect(res.status, res.request?.url).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'postgres' });
    }
    expect((await app.http.get('/api/databases/status').expect(200)).body.data.capabilities).toEqual({ mysql: false, postgres: false });
    expect(app.agent.calls.filter((c) => c.name.startsWith('pg.'))).toEqual([]);
  });
});

describe('Database Services API (PostgreSQL via mock agent)', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  beforeAll(async () => {
    app = await createTestApp({ agent: pgAgent() });
    csrf = await app.login();
    reseller = await app.createUser('resell2', 'reseller');
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'dana', domain: 'dana.com', owner: 'resell2' }).expect(201);
    const created = await app.http.post('/api/databases/profiles').set('X-CSRF-Token', csrf).send({ profile_name: 'Local PostgreSQL', engine: 'postgres', host: 'localhost' }).expect(201);
    await app.http.post(`/api/databases/profiles/${created.body.data.id}/activate`).set('X-CSRF-Token', csrf).expect(200);
    const { default: request } = await import('supertest');
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell2', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const get = (path) => app.http.get(`/api/databases${path}`);
  const post = (path, body) => app.http.post(`/api/databases${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body) => app.http.put(`/api/databases${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/databases${path}`).set('X-CSRF-Token', csrf);
  const rGet = (path) => resellerHttp.get(`/api/databases${path}`);
  const rPost = (path, body) => resellerHttp.post(`/api/databases${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rPut = (path, body) => resellerHttp.put(`/api/databases${path}`).set('X-CSRF-Token', resellerCsrf).send(body);

  it('reports the postgres profile, capability, version and unit', async () => {
    const res = await get('/status').expect(200);
    expect(res.body.data.profile).toMatchObject({ profile_name: 'Local PostgreSQL', engine: 'postgres', is_active: true, is_local: true });
    expect(res.body.data.capabilities).toEqual({ mysql: false, postgres: true });
    expect(res.body.data.version).toMatchObject({ engine: 'postgres', major: '16.3' });
    expect(res.body.data.unit).toMatchObject({ unit: 'postgresql', state: 'active' });
    expect(app.agent.callsTo('db.unit')).toEqual([]);
    expect(app.agent.callsTo('pg.unit')).toHaveLength(1);
  });

  it('creates and lists databases through pg.* ops without MySQL-only arguments', async () => {
    const res = await post('/databases', { name: 'shop', account: 'dana' }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'dana_shop', account: 'dana' });
    expect(app.agent.callsTo('pg.database.create')[0].args).toEqual({ name: 'dana_shop' });
    expect(app.agent.callsTo('db.database.create')).toEqual([]);
    await post('/databases', { name: 'dana_shop', account: 'dana' }).expect(409);
    const list = await get('/databases?pageSize=100').expect(200);
    expect(list.body.data.find((d) => d.name === 'dana_shop')).toMatchObject({ account: 'dana', mapped: true, onServer: true, charset: 'UTF8' });
    expect(list.body.data.find((d) => d.name === 'legacy_pg')).toMatchObject({ mapped: false });
    expect(list.body.data.some((d) => d.name === 'postgres')).toBe(false);
    expect((await rGet('/databases').expect(200)).body.data.map((d) => d.name)).toEqual(['dana_shop']);
  });

  it('creates roles without hosts and grants PostgreSQL privileges', async () => {
    const res = await post('/users', { name: 'app', password: 'Str0ng-Passw0rd!', account: 'dana', databases: ['dana_shop'] }).expect(201);
    expect(res.body.data).toMatchObject({ name: 'dana_app', account: 'dana', hosts: [] });
    expect(res.body.data.grants).toEqual([{ database: 'dana_shop', privileges: ['ALL PRIVILEGES'] }]);
    expect(app.agent.callsTo('pg.user.create')[0].args).toEqual({ user: 'dana_app', password: 'Str0ng-Passw0rd!' });
    expect(app.agent.callsTo('pg.grant')[0].args).toEqual({ user: 'dana_app', database: 'dana_shop', privileges: ['ALL PRIVILEGES'] });
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM db_user_hosts h JOIN db_users u ON u.id = h.db_user_id WHERE u.name = 'dana_app'").get().n).toBe(0);
    const edited = await rPut('/users/dana_app/grants', { grants: [{ database: 'dana_shop', privileges: ['connect', 'CREATE'] }] }).expect(200);
    expect(edited.body.data.grants).toEqual([{ database: 'dana_shop', privileges: ['CONNECT', 'CREATE'] }]);
    expect(app.agent.callsTo('pg.revoke')[0].args).toEqual({ user: 'dana_app', database: 'dana_shop' });
    const live = await rGet('/users/dana_app/grants').expect(200);
    expect(live.body.data.grants).toEqual([{ database: 'dana_shop', privileges: ['CONNECT', 'CREATE'] }]);
    expect(live.body.data).not.toHaveProperty('raw');
    const bad = await rPut('/users/dana_app/grants', { grants: [{ database: 'dana_shop', privileges: ['INSERT'] }] }).expect(422);
    expect(bad.body.error.fields.privileges[0]).toMatch(/INSERT/);
    await rPut('/users/legacy_role/grants', { grants: [] }).expect(403);
    const users = await get('/users?pageSize=100').expect(200);
    expect(users.body.data.find((u) => u.name === 'dana_app')).toMatchObject({ account: 'dana', hosts: [], onServer: true });
    expect(users.body.data.find((u) => u.name === 'legacy_role')).toMatchObject({ mapped: false });
    expect(users.body.data.some((u) => u.name === 'postgres')).toBe(false);
  });

  it('changes role passwords and rotates the postgres superuser password', async () => {
    await rPut('/users/dana_app/password', { password: 'N3w-Passw0rd!!' }).expect(200);
    expect(app.agent.callsTo('pg.user.set_password')[0].args).toEqual({ user: 'dana_app', password: 'N3w-Passw0rd!!' });
    await put('/users/postgres/password', { password: 'N3w-Passw0rd!!' }).expect(400);
    const res = await put('/root-password', { password: 'Sup3r-Passw0rd!!' }).expect(200);
    expect(res.body.data).toMatchObject({ hosts: ['*'], myCnfUpdated: false, engine: 'postgres', profile: 'Local PostgreSQL' });
    expect(app.agent.callsTo('pg.root_password.set')[0].args).toEqual({ password: 'Sup3r-Passw0rd!!' });
    expect(app.agent.state.rootPassword).toBe('Sup3r-Passw0rd!!');
    expect(JSON.stringify(app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'db.root_password'").get())).not.toContain('Sup3r-Passw0rd');
    await rPut('/root-password', { password: 'Sup3r-Passw0rd!!' }).expect(403);
  });

  it('lists and kills backends, reads pg_settings and restarts the postgresql unit', async () => {
    const procs = await get('/processes').expect(200);
    expect(procs.body.data.processes[0]).toMatchObject({ id: 4321, user: 'dana_app' });
    await post('/processes/4321/kill', {}).expect(200);
    expect(app.agent.callsTo('pg.kill')[0].args).toMatchObject({ id: 4321, queryOnly: false });
    const vars = await get('/variables').expect(200);
    expect(vars.body.data.variables.max_connections).toBe('100');
    expect(vars.body.data.status.Uptime).toBe(50);
    expect(app.agent.callsTo('pg.variables.get')).toHaveLength(1);
    const restart = await post('/restart').expect(200);
    expect(restart.body.data.unit).toBe('postgresql');
    expect(app.agent.callsTo('db.restart')).toEqual([]);
    expect(app.agent.state.restarts).toBe(1);
    await rGet('/processes').expect(403);
  });

  it('configuration editing and access hosts are MySQL-only features', async () => {
    // A PostgreSQL profile is not a missing MySQL: no install prompt, a plain notice.
    const cfg = await get('/config').expect(409);
    expect(cfg.body.error.code).toBe('unsupported_engine');
    expect(cfg.body.error.message).toMatch(/postgresql\.conf/);
    expect((await put('/config', { settings: { 'max-connections': '200' } }).expect(409)).body.error.code).toBe('unsupported_engine');
    expect(app.agent.callsTo('db.config.read')).toEqual([]);
    expect(app.agent.callsTo('db.config.write')).toEqual([]);
    // No MySQL client on a PostgreSQL-only host: the address is kept for later.
    await expect(app.ctx.databases.setClientAddresses({ ipv4: '203.0.113.10', ipv6: null })).rejects.toMatchObject({ status: 501, capability: 'mysql' });
    expect(app.ctx.databases.clientAddresses()).toEqual({ ipv4: '203.0.113.10', ipv6: null });
    expect(app.agent.callsTo('pg.ping')).toEqual([]);
    const hosts = await rPost('/access-hosts', { host: '203.0.113.5', account: 'dana' }).expect(201);
    expect(hosts.body.data).toMatchObject({ supported: false, applied: [], failed: [] });
    expect((await rGet('/access-hosts').expect(200)).body.meta).toMatchObject({ engine: 'postgres', supported: false });
    expect(app.agent.calls.filter((c) => c.name.startsWith('db.user') || c.name.startsWith('pg.user'))).toEqual([]);
  });

  it('runs VACUUM-style checks as a job scoped to the caller', async () => {
    const res = await rPost('/repair', { action: 'analyze' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('pg.check')[0].args).toEqual({ action: 'analyze', databases: ['dana_shop'] });
    expect(job.result.summary.ok).toBe(1);
    await rPost('/repair', { databases: ['legacy_pg'] }).expect(403);
  });

  it('tests profiles with pg.ping and upgrades through pg.restart without a dump', async () => {
    const profiles = await get('/profiles').expect(200);
    const pg = profiles.body.data.find((p) => p.engine === 'postgres');
    const test = await post(`/profiles/${pg.id}/test`).expect(200);
    expect(test.body.data).toMatchObject({ ok: true, version: 'PostgreSQL 16.3' });
    expect(app.agent.callsTo('pg.ping')).toHaveLength(1);
    const status = await get('/upgrade').expect(200);
    expect(status.body.data.packages.installed[0].name).toBe('postgresql-16');
    const res = await post('/upgrade', { target: 'postgresql-17' }).expect(202);
    const job = await waitForJob(app.ctx, res.body.data.job.id);
    expect(job.status).toBe('done');
    expect(app.agent.callsTo('pkg.install')[0].args).toEqual({ packages: ['postgresql-17'] });
    expect(app.agent.state.installed).toEqual(['postgresql-17']);
    expect(job.result).toMatchObject({ installed: true, manager: 'apt', backup: null, tablesUpgraded: null, restarted: { unit: 'postgresql' } });
    expect(app.agent.callsTo('db.restart')).toEqual([]);
    expect(app.agent.callsTo('db.dump')).toEqual([]);
  });

  it('drops roles and databases and cleans up an account', async () => {
    await post('/users', { name: 'tmp', password: 'Str0ng-Passw0rd!', account: 'dana' }).expect(201);
    const dropped = await del('/users/dana_tmp').expect(200);
    expect(dropped.body.data.dropped).toEqual(['*']);
    expect(app.agent.callsTo('pg.user.drop')[0].args).toEqual({ user: 'dana_tmp' });
    await post('/databases', { name: 'scratch', account: 'dana' }).expect(201);
    await del('/databases/dana_scratch').expect(200);
    expect(app.agent.state.databases.has('dana_scratch')).toBe(false);
    await del('/databases/postgres').expect(400);
    const result = await app.ctx.databases.removeAccountData('dana');
    expect(result.users).toEqual(['dana_app']);
    expect(result.databases).toEqual(['dana_shop']);
    expect(app.agent.state.roles.has('dana_app')).toBe(false);
  });
});
