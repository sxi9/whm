import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent, waitForJob } from './support/app.js';
import { parseGrantStatements, renameForAccount, targetDatabaseName, parseDomainLists, parseUserdata } from '../src/services/transfers.js';

// A host with the user tooling, ssh, rsync and tar but no Apache/BIND/MySQL:
// accounts and files move for real (mocked ops), daemon-bound steps end
// "pending". BINS is mutable so capability-missing paths can be exercised by
// flipping a binary and refreshing detection.
const BINS = { useradd: true, usermod: true, userdel: true, chpasswd: true, systemctl: true, ssh: true, scp: true, rsync: true, tar: true, sshpass: false, mysql: false, mysqld: false };
const NATIVE_HASH = '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19';
const SHADOW = '$6$saltsalt$k2aJ8rXb0Jm9d1fQ3hT6vLw4nP5sR7uY8zA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zA4bC5dE6fG7hI8jK9l';
const DB_USERS = new Set();
const capabilityMissing = (what) => Object.assign(new Error(`${what} is not installed on this server`), { agentError: true, code: 'capability_missing', details: {} });
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n';
const ZONE = (domain, ip) => `$TTL 14400\n${domain}. IN SOA ns1.example.com. hostmaster.${domain}. 2024010101 3600 1800 1209600 86400\n${domain}. 86400 IN NS ns1.example.com.\n${domain}. 14400 IN A ${ip}\nwww 14400 IN A ${ip}\n`;
const REMOTE_IP = '198.51.100.7';

const HANDLERS = {
    'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, Boolean(BINS[n])])),
    'fs.mkdir': ({ path }) => ({ path }),
    'fs.write_file': ({ path, content }) => ({ path, bytes: Buffer.byteLength(content) }),
    'fs.chown': ({ path, owner }) => ({ path, owner }),
    'fs.remove': ({ path }) => ({ path }),
    'fs.stat': ({ path }) => (path.endsWith('.tar.gz') ? { path, exists: true, isDirectory: false, size: 2048, mtime: '2026-10-26T00:00:00.000Z' } : { path, exists: true, isDirectory: true }),
    'fs.copy_tree': ({ from, to }) => ({ from, to }),
    'transfer.remote.probe': ({ connection }) => ({ ok: true, hostname: connection.host, kernel: '6.1.0', uid: 0, isRoot: true, addresses: [REMOTE_IP], tools: { rsync: true, mysqldump: true, mysql: true }, cpanel: true, os: { id: 'almalinux', name: 'AlmaLinux 9', version: '9' }, homeDisk: null }),
    'transfer.remote.list_accounts': () => ({ cpanel: true, accounts: [
      { username: 'bob', uid: 1001, gid: 1001, home: '/home/bob', shell: '/bin/bash', domain: 'bob.com', domains: ['shop.bob.com', 'bobshop.net'], homeListed: true },
      { username: 'carol', uid: 1002, gid: 1002, home: '/home/carol', shell: '/bin/bash', domain: 'carol.org', domains: [], homeListed: true },
      { username: 'nodomain', uid: 1003, gid: 1003, home: '/home/nodomain', shell: '/bin/bash', domain: null, domains: [], homeListed: true },
    ] }),
    'transfer.remote.rsync': ({ remotePath, localPath }) => ({ from: remotePath, to: localPath, code: 0, partial: false, files: 12, filesTransferred: 12, totalBytes: 4096, transferredBytes: 4096 }),
    'transfer.remote.databases': ({ prefix }) => ({ prefix, databases: prefix === 'bob' ? ['bob_shop'] : [] }),
    'transfer.remote.dump_database': ({ database }) => ({ database, remotePath: `/tmp/whm-transfer-${database}-abcd.sql`, sizeBytes: 1234 }),
    'transfer.remote.remove_file': ({ path }) => ({ path, removed: true }),
    'transfer.remote.db_grants': ({ prefix }) => ({ prefix, users: [
      { user: `${prefix}_app`, host: 'localhost', statements: [`CREATE USER '${prefix}_app'@'localhost' IDENTIFIED WITH 'mysql_native_password' AS '${NATIVE_HASH}' REQUIRE NONE PASSWORD EXPIRE DEFAULT ACCOUNT UNLOCK`, `GRANT USAGE ON *.* TO '${prefix}_app'@'localhost'`, `GRANT ALL PRIVILEGES ON \`${prefix}\\_shop\`.* TO '${prefix}_app'@'localhost'`, `GRANT SUPER ON *.* TO '${prefix}_app'@'localhost'`] },
    ] }),
    'transfer.remote.password_hash': ({ username }) => (username === 'bob' ? { username, hash: SHADOW, locked: false, available: true, reason: null } : { username, hash: null, locked: false, available: false, reason: 'no password hash on the source' }),
    'transfer.user.set_password_hash': ({ username }) => ({ username, applied: true }),
    'transfer.remote.read_file': ({ path }) => {
      const zone = path.match(/^\/var\/named\/([a-z0-9.-]+)\.db$/);
      if (zone) return { path, exists: true, content: ZONE(zone[1], REMOTE_IP) };
      const ud = path.match(/^\/var\/cpanel\/userdata\/bob\/(bobshop\.net)$/);
      if (ud) return { path, exists: true, content: `documentroot: /home/bob/public_html/bobshop\nservername: ${ud[1]}\n` };
      return { path, exists: false, content: null };
    },
    'transfer.mysql.import': ({ path, database }) => { if (!BINS.mysql) throw capabilityMissing('The MySQL client'); return { path, database, imported: true }; },
    'transfer.mysql.create_user': ({ user, host, grants }) => { if (!BINS.mysql) throw capabilityMissing('The MySQL client'); return { user, host, created: true, grants: grants.map((g) => g.database) }; },
    'db.database.create': ({ name }) => ({ name, created: true }),
    'db.users.list': () => [{ user: 'root', host: 'localhost', plugin: 'mysql_native_password', system: true }, ...[...DB_USERS].map((k) => ({ user: k.split('@')[0], host: k.split('@')[1], plugin: 'mysql_native_password', system: false }))],
    'db.user.create': ({ user, hosts }) => { for (const h of hosts) DB_USERS.add(`${user}@${h}`); return { user, hosts }; },
    'db.grants.list': ({ user, host }) => ({ user, host, raw: [], grants: [] }),
    'db.grant': ({ user, database, privileges, hosts }) => ({ user, database, privileges, hosts }),
    'transfer.archive.list': ({ path }) => ({ path, exists: path === '/var/lib/whm/transfers/uploads', archives: path === '/var/lib/whm/transfers/uploads' ? [{ name: 'cpmove-dave.tar.gz', path: '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz', sizeBytes: 2048, mtime: '2026-10-26T00:00:00.000Z' }] : [] }),
    'transfer.cpmove.inspect': ({ path }) => ({ path, sizeBytes: 2048, mtime: '2026-10-26T00:00:00.000Z', top: 'cpmove-dave', username: 'dave', databases: path.includes('evil') ? ['dave_blog', 'mysql', 'sys'] : ['dave_blog'], zones: ['dave.net', 'davestore.com'], userdata: ['davestore.com'], hasHomedir: true, hasGrants: true, hasShadow: true, hasAddons: true, hasParked: true, hasSubdomains: true, hasCpConfig: true, version: true, config: { domain: 'dave.net', plan: 'gold', contactEmail: 'dave@dave.net', ip: REMOTE_IP, raw: { USER: 'dave' } }, entries: 10, sample: [] }),
    'transfer.cpmove.extract': ({ destination, members }) => ({ destination, extracted: !members.some((m) => m.includes('missing')), members }),
    'transfer.cpmove.read_member': ({ member }) => {
      const map = {
        'cpmove-dave/addons': 'davestore.com=davestore.dave.net\n', 'cpmove-dave/pds': 'davealias.org\n', 'cpmove-dave/sds2': 'davestore_dave.net=/home/dave/public_html/davestore\n',
        'cpmove-dave/userdata/davestore.com': 'documentroot: /home/dave/public_html/davestore\nservername: davestore.com\n',
        'cpmove-dave/dnszones/dave.net.db': ZONE('dave.net', REMOTE_IP), 'cpmove-dave/dnszones/davestore.com.db': ZONE('davestore.com', REMOTE_IP),
        'cpmove-dave/shadow': `${SHADOW}\n`,
        'cpmove-dave/mysql.sql': [
          `GRANT USAGE ON *.* TO 'dave_app'@'localhost' IDENTIFIED BY PASSWORD '${NATIVE_HASH}';`,
          "GRANT ALL PRIVILEGES ON `dave\\_blog`.* TO 'dave_app'@'localhost';",
          "CREATE USER 'dave_ro'@'localhost' IDENTIFIED VIA unix_socket;",
          "GRANT SELECT, SHOW VIEW ON `dave\\_blog`.* TO 'dave_ro'@'localhost';",
          "GRANT ALL PRIVILEGES ON *.* TO 'dave_evil'@'%' WITH GRANT OPTION;",
          "GRANT ALL PRIVILEGES ON `mysql`.* TO 'dave_app'@'localhost';",
          "CREATE USER 'root'@'%' IDENTIFIED BY 'owned';",
          "GRANT FILE ON *.* TO 'dave_app'@'localhost';",
        ].join('\n') + '\n',
      };
      return map[member] ? { member, exists: true, content: map[member] } : { member, exists: false, content: null };
    },
    'transfer.upload.append': ({ path, data, truncate }) => ({ path, bytes: Buffer.byteLength(data, 'base64'), size: truncate ? Buffer.byteLength(data, 'base64') : 2 * Buffer.byteLength(data, 'base64') }),
};
const hostAgent = () => createMockAgent(HANDLERS);

describe('helpers', () => {
  it('parses grant statements into account-scoped users and refuses the rest', () => {
    const { users, refused } = parseGrantStatements([
      `CREATE USER 'bob_app'@'localhost' IDENTIFIED WITH 'mysql_native_password' AS '${NATIVE_HASH}' REQUIRE NONE`,
      "GRANT USAGE ON *.* TO 'bob_app'@'localhost'",
      "GRANT ALL ON `bob\\_shop`.* TO 'bob_app'@'localhost';",
      "GRANT SELECT, INSERT ON bob_x.* TO `bob`@`%`",
      "GRANT ALL PRIVILEGES ON *.* TO 'bob_app'@'localhost' WITH GRANT OPTION",
      "GRANT SUPER, FILE ON *.* TO 'bob_app'@'localhost'",
      "GRANT ALL PRIVILEGES ON `mysql`.* TO 'bob_app'@'localhost'",
      "GRANT SELECT ON `bob\\_shop`.`orders` TO 'bob_app'@'localhost'",
      "GRANT ALL ON `bobby_x`.* TO 'bobby'@'%'",
      "CREATE USER 'root'@'%' IDENTIFIED BY 'owned'",
      "GRANT PROCESS ON `bob\\_shop`.* TO 'bob_app'@'localhost'",
      "GRANT ALL ON `bob\\_shop`.* TO 'bob_app'@'localhost' WITH GRANT OPTION",
      "GRANT `admin_role`@`%` TO 'bob_app'@'localhost'",
      "DROP USER 'bob_app'@'localhost'",
    ], 'bob');
    expect(users).toEqual([
      { user: 'bob_app', host: 'localhost', auth: { plugin: 'mysql_native_password', hash: NATIVE_HASH }, grants: [{ database: 'bob_shop', privileges: ['ALL PRIVILEGES'] }] },
      { user: 'bob', host: '%', auth: null, grants: [{ database: 'bob_x', privileges: ['SELECT', 'INSERT'] }] },
    ]);
    expect(refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(/GRANT OPTION/), expect.stringMatching(/global privileges \(SUPER, FILE ON \*\.\*\)/), expect.stringMatching(/"mysql" does not belong/), expect.stringMatching(/table-level/),
      expect.stringMatching(/'bobby' does not belong/), expect.stringMatching(/'root' does not belong/), expect.stringMatching(/PROCESS is not a database-level/), expect.stringMatching(/GRANT OPTION/),
      expect.stringMatching(/only CREATE USER and GRANT/), expect.stringMatching(/only CREATE USER and GRANT/),
    ]);
    expect(parseGrantStatements(["GRANT USAGE ON *.* TO 'bob_app'@'localhost' IDENTIFIED BY PASSWORD '*ABC'"], 'bob').users[0].auth).toEqual({ plugin: 'mysql_native_password', hash: '*ABC' });
    expect(parseGrantStatements(["CREATE USER `bob_ro`@`localhost` IDENTIFIED VIA unix_socket"], 'bob').users[0].auth).toEqual({ plugin: 'unix_socket', hash: null });
  });

  it('renames users and databases for the local account', () => {
    expect(renameForAccount('bob', 'bob', 'robert')).toBe('robert');
    expect(renameForAccount('bob_app', 'bob', 'robert')).toBe('robert_app');
    expect(targetDatabaseName('bob_shop', 'bob', 'robert')).toBe('robert_shop');
    expect(targetDatabaseName('bob_shop', 'bob', 'bob')).toBe('bob_shop');
    expect(targetDatabaseName('mysql', 'bob', 'bob')).toBe('bob_mysql');
    expect(targetDatabaseName('sys', 'dave', 'dave2')).toBe('dave2_sys');
  });

  it('parses cPanel domain lists and userdata', () => {
    expect(parseDomainLists({ addons: 'shop.example.net=shop.alice.com\n', pds: 'alias.example.org\nnot a domain\n', sds2: 'shop_alice.com=/home/alice/public_html/shop\n' })).toEqual([
      { domain: 'shop.example.net', type: 'addon', via: 'shop.alice.com' }, { domain: 'alias.example.org', type: 'parked' }, { domain: 'shop.alice.com', type: 'sub', docroot: '/home/alice/public_html/shop' },
    ]);
    expect(parseUserdata('documentroot: /home/a/public_html/x\nservername: X.com\nphpversion: ea-php83\n')).toMatchObject({ documentroot: '/home/a/public_html/x', servername: 'x.com', phpversion: 'ea-php83' });
  });
});

describe('Transfers API', () => {
  let app;
  let csrf;
  let reseller;
  let resellerHttp;
  let resellerCsrf;

  // The mock records args only; the options of each call (socket-client
  // timeouts for the long ops) are captured here.
  const callOptions = [];
  const optionsOf = (name) => callOptions.filter((c) => c.name === name).map((c) => c.opts);

  beforeAll(async () => {
    app = await createTestApp({ agent: hostAgent() });
    const originalOp = app.agent.op;
    app.agent.op = (name, args, opts) => { callOptions.push({ name, opts }); return originalOp.call(app.agent, name, args, opts); };
    csrf = await app.login();
    reseller = await app.createUser('resell1', 'reseller');
    await app.http.post('/api/packages').set('X-CSRF-Token', csrf).send({ name: 'gold', disk_mb: 20480, bandwidth_mb: 204800, has_shell: true, max_db: 10 }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', contactEmail: 'alice@alice.com' }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'rbob', domain: 'rbob.com', owner: 'resell1' }).expect(201);
    resellerHttp = request.agent(app.ctx.app);
    const res = await resellerHttp.post('/api/auth/login').send({ username: 'resell1', password: reseller.password });
    resellerCsrf = res.body.data.csrfToken;
    app.ctx.jobs.start();
  });
  afterAll(() => app.close());
  beforeEach(() => { app.agent.calls.length = 0; });

  const post = (path, body = {}) => app.http.post(`/api/transfers${path}`).set('X-CSRF-Token', csrf).send(body);
  const put = (path, body = {}) => app.http.put(`/api/transfers${path}`).set('X-CSRF-Token', csrf).send(body);
  const del = (path) => app.http.delete(`/api/transfers${path}`).set('X-CSRF-Token', csrf);
  const get = (path) => app.http.get(`/api/transfers${path}`);
  const rpost = (path, body = {}) => resellerHttp.post(`/api/transfers${path}`).set('X-CSRF-Token', resellerCsrf).send(body);
  const rget = (path) => resellerHttp.get(`/api/transfers${path}`);
  const refreshCaps = async (patch) => { Object.assign(BINS, patch); await app.http.post('/api/system/capabilities/refresh').set('X-CSRF-Token', csrf).expect(200); };
  const finished = async (jobId) => { const job = await waitForJob(app.ctx, jobId); expect(job.status).toBe('done'); return job; };

  describe('capabilities', () => {
    it('reports the tooling state', async () => {
      const res = await get('/capabilities').expect(200);
      expect(res.body.data.ssh).toMatchObject({ installed: true });
      expect(res.body.data.sshpass).toMatchObject({ installed: false });
      expect(res.body.data.rsync.installed).toBe(true);
      expect(res.body.data.services.accounts).toBe(true);
      expect(res.body.data.stagingDir).toBe('/var/lib/whm/transfers');
      await rget('/capabilities').expect(200);
    });
  });

  describe('Transfer Tool', () => {
    let sessionId;

    it('is root only and validates the connection', async () => {
      expect((await rpost('/sessions', { host: 'src.example.com', authType: 'key', privateKey: KEY })).status).toBe(403);
      expect((await rget('/sessions')).status).toBe(403);
      expect((await post('/sessions', { host: '-oProxyCommand=id', authType: 'key', privateKey: KEY })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com;id', authType: 'key', privateKey: KEY })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', user: 'root;id', authType: 'key', privateKey: KEY })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', port: 70000, authType: 'key', privateKey: KEY })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', authType: 'key' })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', authType: 'password' })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', authType: 'password', password: 'a\nb' })).status).toBe(422);
      expect((await post('/sessions', { host: 'src.example.com', authType: 'key', privateKey: KEY, extra: 1 })).status).toBe(422);
    });

    it('needs sshpass for password logins and ssh at all', async () => {
      const res = await post('/sessions', { host: 'src.example.com', authType: 'password', password: 'secret' });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatchObject({ code: 'capability_missing', capability: 'sshpass' });
      await refreshCaps({ ssh: false });
      const noSsh = await post('/sessions', { host: 'src.example.com', authType: 'key', privateKey: KEY });
      expect(noSsh.status).toBe(501);
      expect(noSsh.body.error.capability).toBe('ssh');
      await refreshCaps({ ssh: true });
    });

    it('turns remote failures into 422 and never stores a session for them', async () => {
      app.agent.fail('transfer.remote.probe', 'ssh_auth_failed', 'The remote server rejected the login: Permission denied (publickey)');
      const res = await post('/sessions', { host: 'src.example.com', authType: 'key', privateKey: KEY });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ssh_auth_failed');
      app.agent.set('transfer.remote.probe', HANDLERS['transfer.remote.probe']);
      expect((await get('/sessions').expect(200)).body.data).toEqual([]);
    });

    it('connects, stores the secret encrypted and enumerates remote accounts', async () => {
      const res = await post('/sessions', { host: 'SRC.example.com', port: 2222, authType: 'key', privateKey: KEY }).expect(201);
      sessionId = res.body.data.id;
      expect(res.body.data).toMatchObject({ host: 'src.example.com', port: 2222, user: 'root', authType: 'key', probe: { cpanel: true, isRoot: true } });
      expect(JSON.stringify(res.body.data)).not.toContain('PRIVATE KEY');
      const row = app.ctx.db.prepare('SELECT secret_enc FROM transfer_sessions WHERE id = ?').get(sessionId);
      expect(row.secret_enc.startsWith('v1:')).toBe(true);
      expect(app.ctx.crypto.decrypt(row.secret_enc)).toBe(KEY);
      const probeCall = app.agent.callsTo('transfer.remote.probe')[0];
      expect(probeCall.args.connection).toMatchObject({ host: 'src.example.com', port: 2222, privateKey: KEY });

      const list = await get('/sessions').expect(200);
      expect(list.body.data.map((s) => s.id)).toEqual([sessionId]);
      const accounts = await get(`/sessions/${sessionId}/accounts`).expect(200);
      expect(accounts.body.data.cached).toBe(false);
      const bob = accounts.body.data.accounts.find((a) => a.username === 'bob');
      expect(bob).toMatchObject({ domain: 'bob.com', localExists: false, domains: ['shop.bob.com', 'bobshop.net'] });
      expect((await get(`/sessions/${sessionId}/accounts`).expect(200)).body.data.cached).toBe(true);
      expect(app.agent.callsTo('transfer.remote.list_accounts')).toHaveLength(1);
      await get(`/sessions/${sessionId}/accounts?refresh=true`).expect(200);
      expect(app.agent.callsTo('transfer.remote.list_accounts')).toHaveLength(2);
      expect((await get('/sessions/999')).status).toBe(404);
      const audit = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'transfer.session.create'").all();
      expect(audit).toHaveLength(1);
    });

    it('re-probes a stored connection (root only) and refreshes the stored probe', async () => {
      expect((await rpost(`/sessions/${sessionId}/probe`)).status).toBe(403);
      app.ctx.db.prepare("UPDATE transfer_sessions SET probe_json = '{\"stale\":true}', last_used_at = datetime('now', '-3 hours') WHERE id = ?").run(sessionId);
      const res = await post(`/sessions/${sessionId}/probe`).expect(200);
      expect(res.body.data.probe).toMatchObject({ hostname: 'src.example.com', cpanel: true, tools: { rsync: true } });
      const row = app.ctx.db.prepare('SELECT probe_json, last_used_at FROM transfer_sessions WHERE id = ?').get(sessionId);
      expect(JSON.parse(row.probe_json)).toMatchObject({ hostname: 'src.example.com', isRoot: true });
      expect(JSON.parse(row.probe_json).stale).toBeUndefined();
      expect(Date.now() - new Date(`${row.last_used_at.replace(' ', 'T')}Z`).getTime()).toBeLessThan(60_000);
      expect(app.agent.callsTo('transfer.remote.probe')[0].args.connection.privateKey).toBe(KEY);
      expect((await post('/sessions/999/probe')).status).toBe(404);
      app.agent.fail('transfer.remote.probe', 'ssh_unreachable', 'Could not connect to the remote server: Connection refused');
      expect((await post(`/sessions/${sessionId}/probe`)).status).toBe(422);
      app.agent.set('transfer.remote.probe', HANDLERS['transfer.remote.probe']);
    });

    it('previews the plan with conflicts and blocks a bad plan', async () => {
      expect((await post('/transfer/preview', { sessionId, accounts: [] })).status).toBe(422);
      expect((await post('/transfer/preview', { sessionId, accounts: [{ source: '-r' }] })).status).toBe(422);
      expect((await post('/transfer/preview', { sessionId, accounts: [{ source: 'bob', domain: 'not a domain' }] })).status).toBe(422);
      const res = await post('/transfer/preview', { sessionId, accounts: [{ source: 'bob' }, { source: 'carol', username: 'alice' }, { source: 'nodomain' }, { source: 'ghost' }, { source: 'carol', username: 'carol2', domain: 'alice.com' }] }).expect(200);
      const by = Object.fromEntries(res.body.data.items.map((i, n) => [n, i]));
      expect(by[0]).toMatchObject({ sourceUsername: 'bob', username: 'bob', domain: 'bob.com', issues: [] });
      expect(by[1].issues[0]).toMatch(/already exists/);
      expect(by[2].issues[0]).toMatch(/No domain/);
      expect(by[3].issues[0]).toMatch(/not found on the source/);
      expect(by[4].issues[0]).toMatch(/already hosted by alice/);
      expect(res.body.data.totals).toMatchObject({ accounts: 5, ready: 1, blocked: 4 });
      expect(res.body.data.ok).toBe(false);
      const start = await post('/transfer', { sessionId, accounts: [{ source: 'ghost' }] });
      expect(start.status).toBe(422);
      expect(start.body.error.fields.accounts[0]).toMatch(/ghost/);
      expect((await rpost('/transfer', { sessionId, accounts: [{ source: 'bob' }] })).status).toBe(403);
    });

    it('refuses to start without rsync unless home directories are skipped', async () => {
      await refreshCaps({ rsync: false });
      const res = await post('/transfer', { sessionId, accounts: [{ source: 'carol' }] });
      expect(res.status).toBe(501);
      expect(res.body.error.capability).toBe('rsync');
      await refreshCaps({ rsync: true });
    });

    it('runs the transfer job: account, home, databases, grants, domains, zones', async () => {
      const res = await post('/transfer', { sessionId, accounts: [{ source: 'bob', username: 'robert', package: 'gold' }], options: { overwrite: false } }).expect(202);
      expect(res.body.data.job.type).toBe('transfer.remote');
      const runId = res.body.data.run.id;
      await finished(res.body.data.job.id);

      const account = (await app.http.get('/api/accounts/robert').expect(200)).body.data;
      expect(account).toMatchObject({ domain: 'bob.com', package_name: 'gold' });
      const types = Object.fromEntries(account.domains.map((d) => [d.domain, d]));
      expect(types['shop.bob.com']).toMatchObject({ type: 'sub' });
      expect(types['bobshop.net']).toMatchObject({ type: 'addon', docroot: `${account.home_dir}/public_html/bobshop` });

      const rsync = app.agent.callsTo('transfer.remote.rsync');
      expect(rsync[0].args).toMatchObject({ remotePath: '/home/bob', localPath: account.home_dir, directory: true, excludes: expect.arrayContaining(['tmp/']) });
      expect(rsync[0].args.connection.privateKey).toBe(KEY);
      expect(rsync[1].args).toMatchObject({ remotePath: '/tmp/whm-transfer-bob_shop-abcd.sql', directory: false });
      expect(app.agent.callsTo('transfer.remote.remove_file')[0].args.path).toBe('/tmp/whm-transfer-bob_shop-abcd.sql');
      // Copies and dumps may run for hours: the split-mode socket client must not give up after its 1 h default.
      expect(optionsOf('transfer.remote.rsync').map((o) => o.timeoutMs)).toEqual([86_400_000, 86_400_000]);
      expect(optionsOf('transfer.remote.dump_database').map((o) => o.timeoutMs)).toEqual([7_200_000]);
      expect(app.agent.callsTo('fs.chown')[0].args).toMatchObject({ path: account.home_dir, owner: 'robert', recursive: true });

      const run = (await get(`/runs/${runId}`).expect(200)).body.data;
      expect(run).toMatchObject({ kind: 'transfer', status: 'done', source: 'root@src.example.com' });
      expect(run.job.logs.length).toBeGreaterThan(2);
      const item = run.items[0];
      expect(item).toMatchObject({ source_username: 'bob', username: 'robert', domain: 'bob.com' });
      expect(['done', 'pending']).toContain(item.status);
      expect(item.steps.account.status).toBe('applied');
      expect(item.steps.home).toMatchObject({ status: 'applied' });
      expect(item.steps.home.detail).toMatch(/12 file\(s\)/);
      expect(item.steps.databases[0]).toMatchObject({ name: 'robert_shop', source: 'bob_shop' });
      // No MySQL on this host: the dump is fetched, the import and the users wait.
      expect(item.steps.databases[0].status).toBe('pending');
      expect(item.steps.grants.status).toBe('pending');
      expect(app.agent.callsTo('transfer.mysql.import')).toHaveLength(0);
      // The password hash read from the source's shadow is applied to the new user.
      expect(app.agent.callsTo('transfer.remote.password_hash')[0].args).toMatchObject({ username: 'bob' });
      expect(app.agent.callsTo('transfer.user.set_password_hash')[0].args).toEqual({ username: 'robert', hash: SHADOW });
      expect(item.steps.password).toMatchObject({ status: 'applied', detail: expect.stringMatching(/hash copied/) });
      expect(JSON.stringify(run)).not.toContain(SHADOW);
      expect(item.steps.domains.added.map((d) => d.domain).sort()).toEqual(['bobshop.net', 'shop.bob.com']);
      const zones = Object.fromEntries(item.steps.dns.map((z) => [z.domain, z]));
      expect(Object.keys(zones).sort()).toEqual(['bob.com', 'bobshop.net']);
      // The source zone is stored for the new account; without BIND here it is published later.
      expect(['applied', 'pending']).toContain(zones['bob.com'].status);
      expect(zones['bob.com'].detail).toMatch(/imported/);
      const zoneRow = app.ctx.db.prepare('SELECT z.account_id, a.username FROM dns_zones z JOIN accounts a ON a.id = z.account_id WHERE z.domain = ?').get('bob.com');
      expect(zoneRow.username).toBe('robert');
      expect(item.steps.web.status).toBe('pending');
      expect(run.totals.total).toBe(1);
      const audit = app.ctx.db.prepare("SELECT action FROM audit_log WHERE action IN ('transfer.start', 'transfer.result')").all().map((r) => r.action);
      expect(audit).toContain('transfer.start');
      expect(audit).toContain('transfer.result');
    });

    it('sets the password from the form, or reports that none could be set', async () => {
      expect((await post('/transfer', { sessionId, accounts: [{ source: 'carol', password: 'short' }] })).status).toBe(422);
      const res = await post('/transfer', { sessionId, accounts: [{ source: 'carol', password: 'Carol-Passw0rd!1' }], options: { skipHome: true, skipDatabases: true, skipDns: true } }).expect(202);
      expect(res.body.data.run.params.accounts[0].password).toBe('[set]');
      await finished(res.body.data.job.id);
      expect(app.agent.callsTo('user.set_password')[0].args).toEqual({ username: 'carol', password: 'Carol-Passw0rd!1' });
      expect(app.agent.callsTo('transfer.remote.password_hash')).toHaveLength(0);
      const run = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
      expect(run.items[0].steps.password).toMatchObject({ status: 'applied', detail: expect.stringMatching(/from the form/) });
      expect(run.params.accounts[0].password).toBe('[set]');
      expect(app.ctx.db.prepare('SELECT params_json FROM transfer_runs WHERE id = ?').get(run.id).params_json).not.toContain('Carol-Passw0rd');
      expect(app.ctx.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'transfer.start'").all().map((r) => r.args_redacted).join('')).not.toContain('Carol-Passw0rd');

      // "nodomain" has no hash on the source and no form password: pending, with the reason.
      const none = await post('/transfer', { sessionId, accounts: [{ source: 'nodomain', domain: 'nodomain.example' }], options: { skipHome: true, skipDatabases: true, skipDns: true } }).expect(202);
      await finished(none.body.data.job.id);
      const item = (await get(`/runs/${none.body.data.run.id}`).expect(200)).body.data.items[0];
      expect(item.status).toBe('pending');
      expect(item.steps.password).toMatchObject({ status: 'pending', detail: expect.stringMatching(/no password set/) });
      expect(app.agent.callsTo('transfer.user.set_password_hash')).toHaveLength(0);
    });

    it('imports databases into the account-prefixed name and rebuilds users from parsed grants when MySQL is installed', async () => {
      await refreshCaps({ mysql: true, mysqld: true });
      try {
        const res = await post('/transfer', { sessionId, accounts: [{ source: 'bob', username: 'bobdb', domain: 'bobdb.example' }], options: { skipHome: true, skipDns: true } }).expect(202);
        await finished(res.body.data.job.id);
        const item = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data.items[0];
        expect(item.steps.databases[0]).toMatchObject({ name: 'bobdb_shop', source: 'bob_shop', status: 'applied' });
        expect(app.agent.callsTo('db.database.create')[0].args.name).toBe('bobdb_shop');
        const imp = app.agent.callsTo('transfer.mysql.import')[0].args;
        expect(imp).toMatchObject({ database: 'bobdb_shop', definerPrefix: 'bob', path: expect.stringMatching(/run-\d+\/bobdb_shop\.sql$/) });
        // Grants are never sourced as SQL: the user is recreated from its parsed hash and account-scoped grants.
        const created = app.agent.callsTo('transfer.mysql.create_user');
        expect(created).toHaveLength(1);
        expect(created[0].args).toMatchObject({ user: 'bobdb_app', host: 'localhost', ownerPrefix: 'bobdb', auth: { plugin: 'mysql_native_password', hash: NATIVE_HASH }, grants: [{ database: 'bobdb_shop', privileges: ['ALL PRIVILEGES'] }] });
        expect(app.agent.callsTo('fs.write_file').some((c) => /grants\.sql$/.test(c.args.path))).toBe(false);
        expect(item.steps.grants.status).toBe('pending');
        expect(item.steps.grants.detail).toMatch(/1 user\(s\) recreated with their password \(bobdb_app@localhost\)/);
        expect(item.steps.grants.detail).toMatch(/refused: global privileges \(SUPER ON \*\.\*\)/);
        expect(app.ctx.db.prepare('SELECT a.username FROM db_users u JOIN accounts a ON a.id = u.account_id WHERE u.name = ?').get('bobdb_app')?.username).toBe('bobdb');
        expect(app.ctx.db.prepare('SELECT a.username FROM databases d JOIN accounts a ON a.id = d.account_id WHERE d.name = ?').get('bobdb_shop')?.username).toBe('bobdb');
      } finally {
        await refreshCaps({ mysql: false, mysqld: false });
      }
    });

    it('merges into an existing account only with overwrite', async () => {
      const blocked = await post('/transfer', { sessionId, accounts: [{ source: 'bob', username: 'robert' }] });
      expect(blocked.status).toBe(422);
      const res = await post('/transfer', { sessionId, accounts: [{ source: 'bob', username: 'robert' }], options: { overwrite: true, skipDatabases: true, skipDns: true } }).expect(202);
      await finished(res.body.data.job.id);
      const run = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
      expect(run.items[0].steps.account.detail).toMatch(/existing/);
      expect(run.items[0].steps.databases[0].status).toBe('skipped');
      expect(run.items[0].steps.dns[0].status).toBe('skipped');
      expect(app.agent.callsTo('transfer.remote.databases')).toHaveLength(0);
    });

    it('deletes a session', async () => {
      await del(`/sessions/${sessionId}`).expect(200);
      expect((await get(`/sessions/${sessionId}`)).status).toBe(404);
    });
  });

  describe('Transfer or Restore a cPanel Account', () => {
    it('lists and inspects archives (root only, tar required)', async () => {
      expect((await rget('/archives')).status).toBe(403);
      const list = await get('/archives').expect(200);
      expect(list.body.data.archives[0]).toMatchObject({ name: 'cpmove-dave.tar.gz', dir: '/var/lib/whm/transfers/uploads' });
      expect(list.body.data.dirs).toContain('/backup');
      expect((await post('/archives/inspect', { path: 'relative.tar.gz' })).status).toBe(422);
      expect((await post('/archives/inspect', { path: '/backup/../etc/x.tar.gz' })).status).toBe(422);
      const info = await post('/archives/inspect', { path: '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz' }).expect(200);
      expect(info.body.data).toMatchObject({ username: 'dave', localExists: false, config: { domain: 'dave.net' } });
      await refreshCaps({ tar: false });
      expect((await post('/archives/inspect', { path: '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz' })).status).toBe(501);
      await refreshCaps({ tar: true });
      app.agent.fail('transfer.cpmove.inspect', 'invalid_archive', 'not a tar archive');
      const bad = await post('/archives/inspect', { path: '/backup/junk.tar.gz' });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('invalid_archive');
      app.agent.set('transfer.cpmove.inspect', HANDLERS['transfer.cpmove.inspect']);
    });

    it('reads an archive once while its size and mtime are unchanged', async () => {
      const file = '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz';
      app.agent.calls.length = 0;
      await post('/archives/inspect', { path: file }).expect(200);
      await post('/archives/inspect', { path: file }).expect(200);
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(0);
      expect(app.agent.callsTo('fs.stat').length).toBeGreaterThanOrEqual(2);
      app.agent.set('fs.stat', ({ path }) => ({ path, exists: true, isDirectory: false, size: 4096, mtime: '2026-10-26T01:00:00.000Z' }));
      await post('/archives/inspect', { path: file }).expect(200);
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(1);
      await post('/archives/inspect', { path: file }).expect(200);
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(1);
      app.agent.set('fs.stat', HANDLERS['fs.stat']);
      // A different size/mtime again means a fresh listing; one entry per path is kept.
      await post('/archives/inspect', { path: file }).expect(200);
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(2);
      await post('/archives/inspect', { path: file }).expect(200);
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(2);
    });

    it('uploads an archive in chunks', async () => {
      expect((await post('/uploads', { filename: 'notes.txt', size: 10 })).status).toBe(422);
      expect((await post('/uploads', { filename: '../x.tar.gz', size: 10 })).status).toBe(422);
      expect((await rpost('/uploads', { filename: 'cpmove-dave.tar.gz', size: 10 })).status).toBe(403);
      const chunk = Buffer.alloc(5, 'a').toString('base64');
      const begin = await post('/uploads', { filename: 'cpmove-dave.tar.gz', size: 10 }).expect(201);
      const { id } = begin.body.data;
      expect(begin.body.data.path).toBe('/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz');
      expect((await put(`/uploads/${id}/chunks`, { data: 'not base64!' })).status).toBe(422);
      expect((await put('/uploads/zzz/chunks', { data: chunk })).status).toBe(422);
      expect((await put(`/uploads/${'0'.repeat(24)}/chunks`, { data: chunk })).status).toBe(404);
      expect((await post(`/uploads/${id}/finish`)).status).toBe(422);
      expect((await rget(`/uploads/${id}`)).status).toBe(403);
      expect((await get(`/uploads/${'0'.repeat(24)}`)).status).toBe(404);
      expect((await get(`/uploads/${id}`).expect(200)).body.data).toMatchObject({ id, received: 0, size: 10, chunks: 0, chunkBytes: begin.body.data.chunkBytes });
      expect((await put(`/uploads/${id}/chunks`, { data: chunk }).expect(200)).body.data.received).toBe(5);
      // The uploader resumes from the byte count the server reports after a lost response.
      expect((await get(`/uploads/${id}`).expect(200)).body.data).toMatchObject({ received: 5, chunks: 1 });
      expect((await put(`/uploads/${id}/chunks`, { data: chunk }).expect(200)).body.data.received).toBe(10);
      expect((await put(`/uploads/${id}/chunks`, { data: chunk })).status).toBe(422);
      const appends = app.agent.callsTo('transfer.upload.append');
      expect(appends[0].args).toMatchObject({ truncate: true, path: '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz' });
      expect(appends[1].args.truncate).toBe(false);
      const fin = await post(`/uploads/${id}/finish`).expect(200);
      expect(fin.body.data.archive.username).toBe('dave');
      expect((await post(`/uploads/${id}/finish`)).status).toBe(404);
      const other = (await post('/uploads', { filename: 'cpmove-x.tar.gz', size: 1 }).expect(201)).body.data.id;
      await del(`/uploads/${other}`).expect(200);
      expect(app.agent.callsTo('fs.remove').pop().args.path).toBe('/var/lib/whm/transfers/uploads/cpmove-x.tar.gz');
    });

    it('validates the restore request', async () => {
      const file = '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz';
      expect((await rpost('/restore', { path: file })).status).toBe(403);
      expect((await post('/restore', { path: 'x.tar.gz' })).status).toBe(422);
      expect((await post('/restore', { path: file, username: 'Bad User' })).status).toBe(422);
      expect((await post('/restore', { path: file, package: 'nope' })).status).toBe(404);
      expect((await post('/restore', { path: file, username: 'alice' })).status).toBe(409);
      expect((await post('/restore', { path: file, username: 'dave2', domain: 'alice.com' })).status).toBe(409);
    });

    it('restores the archive as a job', async () => {
      const file = '/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz';
      const res = await post('/restore', { path: file, package: 'gold' }).expect(202);
      expect(res.body.data.job.type).toBe('restore.cpmove');
      expect(res.body.data.run.kind).toBe('restore');
      await finished(res.body.data.job.id);
      const account = (await app.http.get('/api/accounts/dave').expect(200)).body.data;
      expect(account).toMatchObject({ domain: 'dave.net', contact_email: 'dave@dave.net', package_name: 'gold' });
      const doms = Object.fromEntries(account.domains.map((d) => [d.domain, d]));
      expect(doms['davestore.com']).toMatchObject({ type: 'addon', docroot: `${account.home_dir}/public_html/davestore` });
      expect(doms['davealias.org']).toMatchObject({ type: 'parked' });
      expect(doms['davestore.dave.net']).toBeUndefined();
      const extracts = app.agent.callsTo('transfer.cpmove.extract');
      expect(extracts[0].args).toMatchObject({ path: file, destination: account.home_dir, members: ['cpmove-dave/homedir/*'], stripComponents: 2, owner: 'dave' });
      expect(extracts[1].args).toMatchObject({ members: ['cpmove-dave/mysql/dave_blog.sql'], destination: '/var/lib/whm/transfers/run-' + res.body.data.run.id });
      expect(optionsOf('transfer.cpmove.extract').every((o) => o.timeoutMs === 86_400_000)).toBe(true);
      // The UI's inspect result is reused: the archive is not listed again for the restore.
      expect(app.agent.callsTo('transfer.cpmove.inspect')).toHaveLength(0);
      const run = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
      const item = run.items[0];
      expect(item.steps.home.status).toBe('applied');
      expect(item.steps.databases[0]).toMatchObject({ name: 'dave_blog', status: 'pending' });
      expect(app.agent.callsTo('transfer.user.set_password_hash')[0].args).toEqual({ username: 'dave', hash: SHADOW });
      expect(item.steps.password).toMatchObject({ status: 'applied', detail: expect.stringMatching(/hash copied/) });
      expect(item.steps.dns.map((z) => z.domain).sort()).toEqual(['dave.net', 'davealias.org', 'davestore.com']);
      expect(item.steps.dns.find((z) => z.domain === 'dave.net').detail).toMatch(/imported/);
      expect(item.steps.dns.find((z) => z.domain === 'davealias.org').detail).toMatch(/standard zone/);
      expect(app.ctx.db.prepare("SELECT action FROM audit_log WHERE action = 'transfer.restore.result'").all()).toHaveLength(1);
      const again = await post('/restore', { path: file, username: 'dave' });
      expect(again.status).toBe(409);
      const overwrite = await post('/restore', { path: file, username: 'dave', password: 'Dave-Passw0rd!1', options: { overwrite: true, skipHome: true, skipDatabases: true, skipDns: true } }).expect(202);
      expect(overwrite.body.data.run.params.password).toBe('[set]');
      await finished(overwrite.body.data.job.id);
      const run2 = (await get(`/runs/${overwrite.body.data.run.id}`).expect(200)).body.data;
      expect(run2.items[0].steps.home.status).toBe('skipped');
      expect(run2.items[0].steps.account.detail).toMatch(/existing/);
      expect(run2.items[0].steps.password).toMatchObject({ status: 'applied', detail: expect.stringMatching(/from the form/) });
      expect(app.agent.callsTo('user.set_password').pop().args).toEqual({ username: 'dave', password: 'Dave-Passw0rd!1' });
      expect(app.ctx.db.prepare('SELECT params_json FROM transfer_runs WHERE id = ?').get(run2.id).params_json).not.toContain('Dave-Passw0rd');
    });

    it('never imports an archived dump into a system database and rebuilds only account-scoped users', async () => {
      await refreshCaps({ mysql: true, mysqld: true });
      try {
        const file = '/backup/cpmove-dave-evil.tar.gz';
        expect((await post('/archives/inspect', { path: file }).expect(200)).body.data.databases).toEqual(['dave_blog', 'mysql', 'sys']);
        const res = await post('/restore', { path: file, username: 'dave4', domain: 'dave4.net', options: { skipHome: true, skipDns: true } }).expect(202);
        await finished(res.body.data.job.id);
        const item = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data.items[0];
        const byName = Object.fromEntries(item.steps.databases.map((d) => [d.source, d]));
        expect(byName.dave_blog).toMatchObject({ name: 'dave4_blog', status: 'applied' });
        expect(byName.mysql).toMatchObject({ name: 'dave4_mysql', status: 'applied' });
        expect(byName.sys).toMatchObject({ name: 'dave4_sys', status: 'applied' });
        const imported = app.agent.callsTo('transfer.mysql.import').map((c) => c.args.database);
        expect(imported.sort()).toEqual(['dave4_blog', 'dave4_mysql', 'dave4_sys']);
        expect(app.agent.callsTo('transfer.mysql.import').every((c) => c.args.definerPrefix === 'dave')).toBe(true);
        expect(optionsOf('transfer.mysql.import').every((o) => o.timeoutMs === 7_200_000)).toBe(true);
        expect(app.agent.callsTo('db.database.create').map((c) => c.args.name).sort()).toEqual(['dave4_blog', 'dave4_mysql', 'dave4_sys']);
        // mysql.sql: dave_app keeps its hash, dave_ro (unix_socket) gets a random password, root/evil/mysql.*/FILE are refused.
        const created = app.agent.callsTo('transfer.mysql.create_user');
        expect(created.map((c) => c.args.user)).toEqual(['dave4_app']);
        expect(created[0].args).toMatchObject({ ownerPrefix: 'dave4', auth: { plugin: 'mysql_native_password', hash: NATIVE_HASH }, grants: [{ database: 'dave4_blog', privileges: ['ALL PRIVILEGES'] }] });
        expect(app.agent.callsTo('db.user.create').map((c) => c.args.user)).toEqual(['dave4_ro']);
        expect(app.agent.callsTo('db.grant')[0].args).toMatchObject({ user: 'dave4_ro', database: 'dave4_blog' });
        expect(app.agent.callsTo('transfer.mysql.create_user').some((c) => c.args.user === 'root' || c.args.user === 'dave4_evil')).toBe(false);
        expect(app.agent.callsTo('db.user.create').some((c) => c.args.user === 'root' || c.args.user === 'dave4_evil')).toBe(false);
        expect(item.steps.grants.status).toBe('pending');
        expect(item.steps.grants.detail).toMatch(/dave4_ro/);
        expect(item.steps.grants.detail).toMatch(/WITH GRANT OPTION is not replayed/);
        expect(item.steps.grants.detail).toMatch(/"mysql" does not belong/);
        expect(item.steps.grants.detail).toMatch(/'root' does not belong/);
        expect(item.steps.grants.detail).toMatch(/FILE/);
        // A dump the agent refuses (e.g. CREATE USER inside) fails only that database.
        app.agent.set('transfer.mysql.import', ({ database }) => { if (database === 'dave5_blog') throw Object.assign(new Error('dave_blog.sql line 12: user or role management statements are not allowed in an account dump'), { agentError: true, code: 'refused', details: {} }); return { database, imported: true }; });
        const res2 = await post('/restore', { path: '/backup/cpmove-dave.tar.gz', username: 'dave5', domain: 'dave5.net', options: { skipHome: true, skipDns: true } }).expect(202);
        await finished(res2.body.data.job.id);
        const item2 = (await get(`/runs/${res2.body.data.run.id}`).expect(200)).body.data.items[0];
        expect(item2.steps.databases[0]).toMatchObject({ name: 'dave5_blog', status: 'failed', detail: expect.stringMatching(/user or role management/) });
        expect(item2.status).toBe('failed');
        app.agent.set('transfer.mysql.import', HANDLERS['transfer.mysql.import']);
      } finally {
        await refreshCaps({ mysql: false, mysqld: false });
      }
    });

    it('is exposed for other categories as restoreArchive', async () => {
      const req = { user: { id: 1, username: 'root', role: 'root' }, audit: () => {} };
      const r = await app.ctx.transfers.restoreArchive('/var/lib/whm/transfers/uploads/cpmove-dave.tar.gz', { username: 'dave3', domain: 'dave3.net', options: { skipHome: true, skipDatabases: true, skipDns: true } }, req.user, req);
      await finished(r.job.id);
      expect((await app.http.get('/api/accounts/dave3').expect(200)).body.data.domain).toBe('dave3.net');
    });
  });

  describe('Convert Addon Domain to Account', () => {
    beforeAll(() => {
      const alice = app.ctx.db.prepare('SELECT id, home_dir FROM accounts WHERE username = ?').get('alice');
      const rbob = app.ctx.db.prepare('SELECT id, home_dir FROM accounts WHERE username = ?').get('rbob');
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'aliceshop.com', 'addon', ?)").run(alice.id, `${alice.home_dir}/public_html/aliceshop`);
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'aliceshop.alice.com', 'sub', ?)").run(alice.id, `${alice.home_dir}/public_html/aliceshop`);
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'rbobshop.com', 'addon', ?)").run(rbob.id, `${rbob.home_dir}/public_html/rbobshop.com`);
    });

    it('lists addon domains per owner', async () => {
      const all = (await get('/addon-domains').expect(200)).body.data;
      expect(all.map((d) => d.domain)).toEqual(expect.arrayContaining(['aliceshop.com', 'bobshop.net', 'davestore.com', 'rbobshop.com']));
      expect(all.find((d) => d.domain === 'aliceshop.com')).toMatchObject({ account: 'alice', mainDomain: 'alice.com', docroot: '/home/alice/public_html/aliceshop' });
      expect((await rget('/addon-domains').expect(200)).body.data.map((d) => d.domain)).toEqual(['rbobshop.com']);
    });

    it('validates and enforces ownership', async () => {
      expect((await post('/convert-addon/preview', { domain: 'aliceshop.com', username: '-r' })).status).toBe(422);
      expect((await post('/convert-addon/preview', { domain: 'alice.com', username: 'shop' })).status).toBe(404);
      expect((await rpost('/convert-addon/preview', { domain: 'aliceshop.com', username: 'shop' })).status).toBe(403);
      expect((await post('/convert-addon/preview', { domain: 'aliceshop.com', username: 'shop', password: 'short' })).status).toBe(422);
      const taken = await post('/convert-addon/preview', { domain: 'aliceshop.com', username: 'alice' }).expect(200);
      expect(taken.body.data.ok).toBe(false);
      expect(taken.body.data.issues.join(' ')).toMatch(/already exists|must differ/);
      expect((await post('/convert-addon', { domain: 'aliceshop.com', username: 'alice' })).status).toBe(422);
      expect((await post('/convert-addon', { domain: 'aliceshop.com', username: 'shop', options: { moveDatabases: ['nope_db'] } })).status).toBe(422);
      const preview = await post('/convert-addon/preview', { domain: 'aliceshop.com', username: 'shop' }).expect(200);
      expect(preview.body.data.addon).toMatchObject({ domain: 'aliceshop.com', account: 'alice', linkedSubdomains: ['aliceshop.alice.com'] });
      expect(preview.body.data.target).toMatchObject({ username: 'shop', domain: 'aliceshop.com', home: '/home/shop' });
      expect(preview.body.data.ok).toBe(true);
    });

    it('needs rsync to copy files', async () => {
      await refreshCaps({ rsync: false });
      expect((await post('/convert-addon', { domain: 'aliceshop.com', username: 'shop' })).status).toBe(501);
      await refreshCaps({ rsync: true });
    });

    it('converts the addon domain into a new account as a job', async () => {
      const res = await post('/convert-addon', { domain: 'aliceshop.com', username: 'shop', password: 'Shop-Passw0rd!1', options: { copyFiles: true, removeSource: true, moveMail: true } }).expect(202);
      expect(res.body.data.job.type).toBe('transfer.convert_addon');
      expect(res.body.data.run.params.password).toBe('[set]');
      await finished(res.body.data.job.id);
      const shop = (await app.http.get('/api/accounts/shop').expect(200)).body.data;
      expect(shop.domain).toBe('aliceshop.com');
      const alice = (await app.http.get('/api/accounts/alice').expect(200)).body.data;
      expect(alice.domains.map((d) => d.domain)).toEqual(['alice.com']);
      const copy = app.agent.callsTo('fs.copy_tree');
      expect(copy[0].args).toMatchObject({ from: `${alice.home_dir}/public_html/aliceshop`, to: `${shop.home_dir}/public_html` });
      expect(copy.some((c) => c.args.from === `${alice.home_dir}/mail/aliceshop.com`)).toBe(true);
      expect(app.agent.callsTo('fs.remove').some((c) => c.args.path === `${alice.home_dir}/public_html/aliceshop` && c.args.recursive)).toBe(true);
      expect(app.agent.callsTo('user.set_password')[0].args).toMatchObject({ username: 'shop' });
      const run = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
      const item = run.items[0];
      expect(['done', 'pending']).toContain(item.status);
      expect(item.steps.files.status).toBe('applied');
      expect(item.steps.domains.removed.sort()).toEqual(['aliceshop.alice.com', 'aliceshop.com']);
      // No BIND on this host: the zone row is created for the new account and published later.
      expect(['applied', 'pending']).toContain(item.steps.dns.status);
      expect(app.ctx.db.prepare('SELECT a.username FROM dns_zones z JOIN accounts a ON a.id = z.account_id WHERE z.domain = ?').get('aliceshop.com').username).toBe('shop');
      expect(item.steps.cleanup.status).toBe('applied');
      expect(app.ctx.db.prepare("SELECT action FROM audit_log WHERE action = 'account.addon.convert'").all()).toHaveLength(1);
    });

    it('lets a reseller convert addon domains of their own accounts', async () => {
      const res = await rpost('/convert-addon', { domain: 'rbobshop.com', username: 'rbobshop', options: { copyFiles: false } }).expect(202);
      await finished(res.body.data.job.id);
      const created = app.ctx.db.prepare('SELECT a.username, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?').get('rbobshop');
      expect(created.owner).toBe('resell1');
      const run = (await rget(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
      expect(run.items[0].steps.files.status).toBe('skipped');
    });

    it('puts the domain rows back when the account cannot be created', async () => {
      const alice = app.ctx.db.prepare('SELECT id, home_dir FROM accounts WHERE username = ?').get('alice');
      app.ctx.db.prepare("INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, 'alicefail.com', 'addon', ?)").run(alice.id, `${alice.home_dir}/public_html/alicefail.com`);
      app.agent.set('user.create', () => { throw Object.assign(new Error('useradd exploded'), { agentError: true, code: 'command_failed' }); });
      app.ctx.config.env = 'production';
      try {
        const res = await post('/convert-addon', { domain: 'alicefail.com', username: 'alicefail', options: { copyFiles: false } }).expect(202);
        const job = await waitForJob(app.ctx, res.body.data.job.id);
        expect(job.status).toBe('done');
        const run = (await get(`/runs/${res.body.data.run.id}`).expect(200)).body.data;
        expect(run.items[0].status).toBe('failed');
        expect(run.items[0].detail).toMatch(/useradd exploded/);
      } finally {
        app.ctx.config.env = 'development';
        app.agent.reset('user.create');
      }
      expect(app.ctx.db.prepare('SELECT type FROM account_domains WHERE domain = ?').get('alicefail.com')).toMatchObject({ type: 'addon' });
      expect(app.ctx.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get('alicefail')).toBeUndefined();
    });
  });

  describe('Review Transfers and Restores', () => {
    it('lists runs and jobs with history and logs, scoped by owner', async () => {
      const runs = (await get('/runs').expect(200)).body.data;
      expect(runs.length).toBeGreaterThanOrEqual(5);
      expect(runs.every((r) => r.totals && r.status)).toBe(true);
      expect((await get('/runs?kind=restore').expect(200)).body.data.every((r) => r.kind === 'restore')).toBe(true);
      expect((await get('/runs?kind=nope')).status).toBe(422);
      const mine = (await rget('/runs').expect(200)).body.data;
      expect(mine).toHaveLength(1);
      expect(mine[0].requested_by).toBe('resell1');
      expect((await rget(`/runs/${runs.find((r) => r.requested_by === 'root').id}`)).status).toBe(403);
      expect((await get('/runs/9999')).status).toBe(404);

      const jobsRes = (await get('/jobs').expect(200)).body.data;
      expect(jobsRes.every((j) => j.type.startsWith('transfer.') || j.type.startsWith('restore.'))).toBe(true);
      expect(jobsRes.some((j) => j.kind === 'restore') && jobsRes.some((j) => j.kind === 'transfer') && jobsRes.some((j) => j.kind === 'convert_addon')).toBe(true);
      expect((await get('/jobs?status=done').expect(200)).body.data.every((j) => j.status === 'done')).toBe(true);
      const one = (await get(`/jobs/${jobsRes[0].id}`).expect(200)).body.data;
      expect(Array.isArray(one.logs)).toBe(true);
      expect(one.run).toMatchObject({ id: expect.any(Number) });
      expect((await rget('/jobs').expect(200)).body.data).toHaveLength(1);
      expect((await rget(`/jobs/${jobsRes.find((j) => j.created_by_name === 'root').id}`)).status).toBe(403);
      const other = app.ctx.jobs.enqueue('transfer.cleanup', {});
      await waitForJob(app.ctx, other.id);
      expect((await get(`/jobs/${other.id}`).expect(200)).body.data.type).toBe('transfer.cleanup');
      const foreign = app.ctx.db.prepare("INSERT INTO jobs (type, params_json) VALUES ('multi_account.modify', '{}')").run();
      expect((await get(`/jobs/${foreign.lastInsertRowid}`)).status).toBe(404);
    });

    it('prunes old runs and expired sessions on the schedule', async () => {
      app.ctx.db.prepare("UPDATE transfer_runs SET finished_at = datetime('now', '-200 days') WHERE id = (SELECT MIN(id) FROM transfer_runs)").run();
      const before = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM transfer_runs').get().n;
      const result = app.ctx.transfers.cleanup({ log: () => {} });
      expect(result.removedRuns).toBe(1);
      expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM transfer_runs').get().n).toBe(before - 1);
      expect(app.ctx.scheduler.list().some((s) => s.name === 'transfers-cleanup')).toBe(true);
    });
  });
});
