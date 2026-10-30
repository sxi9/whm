import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { q, parseBatch, parseGrant, parseMysqlcheck, parseCnf, renderCnf, renderClientCnf, renderRootMyCnf, classifyMysqlError, detectEngine, detectLayout, phpMyAdminVersion, cloneUserStatements, pickPgUnit, PRIVILEGES, validateServerConfig, classifyProbeOutput, clientWarnings } from '../src/ops/db.js';

// exec is spied with the real implementation behind it so tests can prove an op
// refused before any program ran. This dev box has no mysql client: every op
// that would talk to a server must stop at capability_missing or invalid_args.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const noMysql = !detectEngine().installed;
const noPsql = !detectEngine().postgres.installed;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

const MYSQL_OPS = ['db.detect', 'db.version', 'db.ping', 'db.databases.list', 'db.database.create', 'db.database.drop', 'db.users.list', 'db.user.create', 'db.user.drop', 'db.user.set_password', 'db.user.add_host', 'db.grants.list', 'db.grant', 'db.revoke', 'db.processlist', 'db.kill', 'db.check', 'db.root_password.set', 'db.variables.get', 'db.config.read', 'db.config.write', 'db.restart', 'db.unit', 'db.dump', 'db.packages', 'db.upgrade_tables', 'db.phpmyadmin.detect'];
const PG_OPS = ['pg.version', 'pg.ping', 'pg.databases.list', 'pg.database.create', 'pg.database.drop', 'pg.users.list', 'pg.user.create', 'pg.user.drop', 'pg.user.set_password', 'pg.grants.list', 'pg.grant', 'pg.revoke', 'pg.processlist', 'pg.kill', 'pg.check', 'pg.root_password.set', 'pg.variables.get', 'pg.unit', 'pg.restart'];

describe('db op catalog', () => {
  it('registers the whole family with destructive flags on drops, kills, revokes and restarts', () => {
    for (const name of [...MYSQL_OPS, ...PG_OPS]) expect(catalog.has(name), name).toBe(true);
    for (const name of ['db.database.drop', 'db.user.drop', 'db.revoke', 'db.kill', 'db.restart', 'pg.database.drop', 'pg.user.drop', 'pg.revoke', 'pg.kill', 'pg.restart']) expect(catalog.get(name).destructive, name).toBe(true);
    for (const name of ['db.database.create', 'db.user.create', 'db.grant', 'db.check', 'db.config.write', 'db.dump']) expect(catalog.get(name).destructive, name).toBe(false);
  });

  it('rejects unknown ops in the family', async () => {
    expect((await opError(runOp('db.sql', { sql: 'DROP DATABASE mysql' }, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('db.query', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('pg.exec', {}, ctx))).code).toBe('unknown_op');
  });
});

describe('db schemas reject injection, traversal and unknown keys before anything runs', () => {
  const badNames = ['-r', 'a;b', '../x', 'a b', 'Shop', 'a`b', "a'b", 'x/../y', '', 'a\n', '$(id)', 'a'.repeat(65)];

  it('database names', async () => {
    exec.mockClear();
    for (const op of ['db.database.create', 'db.database.drop']) {
      for (const name of badNames) {
        const err = await opError(runOp(op, { name }, ctx));
        expect(err.code, `${op} ${JSON.stringify(name)}`).toBe('invalid_args');
        expect(err.details.fields.name).toBeDefined();
      }
    }
    for (const name of badNames) expect((await opError(runOp('db.grant', { user: 'u', database: name, privileges: ['SELECT'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('user names, hosts and passwords', async () => {
    exec.mockClear();
    for (const user of ['-u', 'a;b', 'a b', "a'b", 'a`b', '', 'u'.repeat(81), 'a/b']) {
      expect((await opError(runOp('db.user.create', { user, password: 'Secret-123' }, ctx))).code, user).toBe('invalid_args');
      expect((await opError(runOp('db.user.drop', { user }, ctx))).code, user).toBe('invalid_args');
      expect((await opError(runOp('db.grants.list', { user }, ctx))).code, user).toBe('invalid_args');
    }
    for (const host of ['a b', "x'y", 'h;rm', '', 'h'.repeat(256), '--host']) {
      expect((await opError(runOp('db.user.create', { user: 'app', password: 'Secret-123', hosts: [host] }, ctx))).code, host).toBe('invalid_args');
      expect((await opError(runOp('db.user.add_host', { user: 'app', toHost: host }, ctx))).code, host).toBe('invalid_args');
    }
    for (const password of ['', 'a\nb', 'x\0y', 'p'.repeat(257)]) {
      expect((await opError(runOp('db.user.set_password', { user: 'app', password }, ctx))).code).toBe('invalid_args');
      expect((await opError(runOp('db.root_password.set', { password }, ctx))).code).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('privileges, process ids, variable names and option keys', async () => {
    exec.mockClear();
    for (const privileges of [['SUPER'], ['FILE'], ['SELECT; DROP'], [], 'ALL', ['all privileges']]) {
      expect((await opError(runOp('db.grant', { user: 'app', database: 'shop', privileges }, ctx))).code, JSON.stringify(privileges)).toBe('invalid_args');
    }
    for (const id of [0, -1, 1.5, '7', '7; KILL 8']) expect((await opError(runOp('db.kill', { id }, ctx))).code, String(id)).toBe('invalid_args');
    for (const names of [['x y'], ["a'b"], ['a;b'], new Array(201).fill('x')]) expect((await opError(runOp('db.variables.get', { names }, ctx))).code).toBe('invalid_args');
    for (const settings of [{ 'Max-Connections': '1' }, { 'max connections': '1' }, { 'max-connections': '1; rm -rf /' }, { 'max-connections': 'a\nb' }, { 'max-connections': '"x"' }, { 'max-connections': 'x'.repeat(256) }, { '!include': '/etc/passwd' }]) {
      expect((await opError(runOp('db.config.write', { settings }, ctx))).code, JSON.stringify(settings)).toBe('invalid_args');
    }
    expect((await opError(runOp('db.check', { action: 'drop' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('db.check', { databases: ['a;b'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('db.dump', { path: 'relative/x.sql' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('db.dump', { path: '/backup/../etc/x.sql' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('db.packages', { candidates: ['pkg; id'] }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('credentials object is strict and typed', async () => {
    exec.mockClear();
    for (const credentials of [{ user: 'a b' }, { host: 'h;x' }, { port: 70000 }, { port: '3306' }, { socket: 'relative.sock' }, { password: 'x\ny' }, { user: 'root', extra: 1 }, 'root:pw', { bindAddress: 'db.example.net' }, { bindAddress: '10.0.0.1;x' }, { bindAddress: '' }, { bindAddress: '999.1.1.1' }]) {
      expect((await opError(runOp('db.version', { credentials }, ctx))).code, JSON.stringify(credentials)).toBe('invalid_args');
    }
    expect((await opError(runOp('db.version', { bogus: 1 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('pg identifiers follow PostgreSQL rules', async () => {
    exec.mockClear();
    for (const name of ['1abc', 'Shop', 'a-b', 'a;b', '', 'a'.repeat(64), 'a"b', '../x']) {
      expect((await opError(runOp('pg.database.create', { name }, ctx))).code, name).toBe('invalid_args');
      expect((await opError(runOp('pg.user.create', { user: name, password: 'Secret-123' }, ctx))).code, name).toBe('invalid_args');
    }
    expect((await opError(runOp('pg.grant', { user: 'app', database: 'shop', privileges: ['SELECT'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pg.kill', { id: 0 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('db ops on a host without MySQL', () => {
  it('db.detect reports the installation state without throwing', async () => {
    const d = await runOp('db.detect', {}, ctx);
    expect(typeof d.installed).toBe('boolean');
    expect(d.binaries).toHaveProperty('client');
    expect(d.layout).toEqual(detectLayout());
    expect([null, 'mysql', 'mariadb']).toContain(d.engine);
  });

  it('server-backed ops stop with capability_missing before running any program', async () => {
    if (!noMysql) return;
    exec.mockClear();
    for (const [op, args] of [
      ['db.version', {}], ['db.ping', {}], ['db.databases.list', {}], ['db.database.create', { name: 'shop' }], ['db.database.drop', { name: 'shop' }],
      ['db.users.list', {}], ['db.user.create', { user: 'app', password: 'Secret-123' }], ['db.user.drop', { user: 'app' }], ['db.user.set_password', { user: 'app', password: 'Secret-123' }],
      ['db.user.add_host', { user: 'app', toHost: '10.0.0.1' }], ['db.grants.list', { user: 'app' }], ['db.grant', { user: 'app', database: 'shop', privileges: ['SELECT'] }], ['db.revoke', { user: 'app', database: 'shop' }],
      ['db.processlist', {}], ['db.kill', { id: 7 }], ['db.check', {}], ['db.root_password.set', { password: 'Secret-123' }], ['db.variables.get', {}], ['db.dump', { path: '/backup/x.sql' }],
    ]) {
      expect((await opError(runOp(op, args, ctx))).code, op).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('system databases and root are refused before any connection attempt', async () => {
    expect((await opError(runOp('db.database.drop', { name: 'mysql' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('db.database.create', { name: 'information_schema' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('db.user.drop', { user: 'root' }, ctx))).code).toBe('refused');
  });

  it('config ops need a MySQL config directory', async () => {
    if (detectLayout().managedInclude) return;
    exec.mockClear();
    expect((await opError(runOp('db.config.read', {}, ctx))).code).toBe('capability_missing');
    expect((await opError(runOp('db.config.write', { settings: { 'max-connections': '100' } }, ctx))).code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('db.unit and db.phpmyadmin.detect are safe on any host', async () => {
    const unit = await runOp('db.unit', {}, ctx);
    expect(unit).toHaveProperty('unit');
    const pma = await runOp('db.phpmyadmin.detect', {}, ctx);
    expect(typeof pma.installed).toBe('boolean');
    expect(Array.isArray(pma.webConfigs)).toBe(true);
    expect(Array.isArray(pma.candidates)).toBe(true);
  });

  it('db.packages answers with a structure even without a known package manager', async () => {
    const result = await runOp('db.packages', {}, ctx);
    expect(Array.isArray(result.installed)).toBe(true);
    expect(Array.isArray(result.available)).toBe(true);
  }, 20_000);

  it('pg ops stop with capability_missing without psql', async () => {
    if (!noPsql) return;
    exec.mockClear();
    for (const [op, args] of [['pg.version', {}], ['pg.databases.list', {}], ['pg.database.create', { name: 'shop' }], ['pg.user.create', { user: 'app', password: 'Secret-123' }], ['pg.processlist', {}], ['pg.variables.get', {}], ['pg.root_password.set', { password: 'Secret-123' }]]) {
      expect((await opError(runOp(op, args, ctx))).code, op).toBe('capability_missing');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('pg.root_password.set and pg.variables.get are strict about their keys', async () => {
    exec.mockClear();
    expect((await opError(runOp('pg.root_password.set', { password: 'Secret-123', updateMyCnf: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pg.variables.get', { names: ['a;b'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('pg.restart', { unit: 'postgresql' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('pg.unit answers without a unit on a host without PostgreSQL', async () => {
    const unit = await runOp('pg.unit', {}, ctx);
    expect(unit).toHaveProperty('unit');
    if (unit.unit) expect(unit.unit).toMatch(/^postgresql/);
  });

  it('pg refuses to drop the postgres database or superuser before connecting', async () => {
    expect((await opError(runOp('pg.database.drop', { name: 'postgres' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('pg.user.drop', { user: 'postgres' }, ctx))).code).toBe('refused');
  });
});

describe('SQL quoting and parsers', () => {
  it('quotes identifiers with backticks and escapes string literals', () => {
    expect(q.id('shop')).toBe('`shop`');
    expect(q.id('a`b')).toBe('`a``b`');
    expect(q.str("p'w\\d")).toBe("'p\\'w\\\\d'");
    expect(q.str('a\nb\0c')).toBe("'a\\nb\\0c'");
    expect(q.account('app', '10.0.0.%')).toBe("'app'@'10.0.0.%'");
    expect(q.pgId('a"b')).toBe('"a""b"');
    expect(q.pgStr("it's")).toBe("'it''s'");
  });

  it('parses mysql --batch output with headers, NULLs and escapes', () => {
    const rows = parseBatch('name\tsize\nshop\t123\nblog\tNULL\nweird\ta\\tb\\\\c\n');
    expect(rows).toEqual([{ name: 'shop', size: '123' }, { name: 'blog', size: null }, { name: 'weird', size: 'a\tb\\c' }]);
    expect(parseBatch('a\tb\n', { headers: false })).toEqual([['a', 'b']]);
    expect(parseBatch('')).toEqual([]);
  });

  it('parses SHOW GRANTS lines', () => {
    expect(parseGrant("GRANT SELECT, INSERT ON `alice_shop`.* TO `alice_app`@`localhost`")).toMatchObject({ privileges: ['SELECT', 'INSERT'], database: 'alice_shop', table: '*' });
    expect(parseGrant("GRANT ALL PRIVILEGES ON `a``b`.* TO 'u'@'%'")).toMatchObject({ privileges: ['ALL PRIVILEGES'], database: 'a`b', table: '*' });
    expect(parseGrant("GRANT USAGE ON *.* TO 'u'@'%' IDENTIFIED BY PASSWORD '*hash'")).toMatchObject({ privileges: ['USAGE'], database: '*', table: '*' });
    expect(parseGrant('GRANT Select (id) ON `d`.`t` TO `u`@`h`')).toMatchObject({ privileges: ['SELECT (ID)'], raw: ['Select (id)'], database: 'd', table: 't' });
    expect(parseGrant('GRANT PROXY ON x TO y')).toBeNull();
  });

  it('clones a MariaDB 10.6 user to a new host from the stored hash and backtick-quoted grants', () => {
    const hash = '*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19';
    const grantLines = [
      'GRANT USAGE ON *.* TO `alice_app`@`localhost` IDENTIFIED BY PASSWORD \'*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19\'',
      'GRANT ALL PRIVILEGES ON `alice_shop`.* TO `alice_app`@`localhost`',
      'GRANT SELECT, INSERT ON `alice_blog`.* TO `alice_app`@`localhost` WITH GRANT OPTION',
    ];
    const out = cloneUserStatements({ user: 'alice_app', toHost: '198.51.100.%', engine: 'mariadb', plugin: 'mysql_native_password', hashHex: Buffer.from(hash).toString('hex'), grantLines });
    expect(out.create).toBe(`CREATE USER 'alice_app'@'198.51.100.%' IDENTIFIED BY PASSWORD '${hash}'`);
    expect(out.grants).toEqual([
      "GRANT ALL PRIVILEGES ON `alice_shop`.* TO 'alice_app'@'198.51.100.%'",
      "GRANT SELECT, INSERT ON `alice_blog`.* TO 'alice_app'@'198.51.100.%' WITH GRANT OPTION",
    ]);
    for (const s of out.statements) { expect(s).not.toMatch(/localhost/); expect(s).toContain("'alice_app'@'198.51.100.%'"); }
    expect(cloneUserStatements({ user: 'u', toHost: '10.0.0.1', engine: 'mariadb', plugin: '', hashHex: Buffer.from(hash).toString('hex'), grantLines: [] }).create).toBe(`CREATE USER 'u'@'10.0.0.1' IDENTIFIED BY PASSWORD '${hash}'`);
    expect(cloneUserStatements({ user: 'u', toHost: '10.0.0.1', engine: 'mariadb', plugin: 'ed25519', hashHex: Buffer.from('vubFBzIrapbfHct1/J72dnUryz5VS7lA6XHH8sIx4TI').toString('hex'), grantLines: [] }).create).toBe("CREATE USER 'u'@'10.0.0.1' IDENTIFIED VIA `ed25519` USING 'vubFBzIrapbfHct1/J72dnUryz5VS7lA6XHH8sIx4TI'");
  });

  it('clones a MySQL 8 caching_sha2_password user with a binary salt as a hex literal', () => {
    // Real caching_sha2_password rows start with "$A$005$" followed by 20 salt
    // bytes, several of which are not valid UTF-8 text.
    const hashHex = Buffer.concat([Buffer.from('$A$005$'), Buffer.from([0x1f, 0x8b, 0xff, 0x00, 0x0a, 0x27, 0x5c, 0x80, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c]), Buffer.from('h3b2xH1R4Kq9z5Xy6W7v8U9t0S1r2Q3p4O5n6M7l8K9j0I1')]).toString('hex');
    const grantLines = [
      'GRANT USAGE ON *.* TO `bob_app`@`localhost`',
      'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER ON `bob_shop`.* TO `bob_app`@`localhost`',
      'GRANT SELECT (id, email) ON `bob_shop`.`customers` TO `bob_app`@`localhost`',
      'GRANT `app_reader`@`%` TO `bob_app`@`localhost`',
    ];
    const out = cloneUserStatements({ user: 'bob_app', toHost: '203.0.113.7', engine: 'mysql', plugin: 'caching_sha2_password', hashHex, grantLines });
    expect(out.create).toBe(`CREATE USER 'bob_app'@'203.0.113.7' IDENTIFIED WITH \`caching_sha2_password\` AS 0x${hashHex.toUpperCase()}`);
    expect(out.grants).toEqual([
      "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER ON `bob_shop`.* TO 'bob_app'@'203.0.113.7'",
      "GRANT SELECT (id, email) ON `bob_shop`.`customers` TO 'bob_app'@'203.0.113.7'",
    ]);
    for (const s of out.statements) expect(s).not.toMatch(/localhost|app_reader/);
    // MySQL 5.7 native hashes are printable and stay quoted strings.
    const native = cloneUserStatements({ user: 'u', toHost: '%', engine: 'mysql', plugin: 'mysql_native_password', hashHex: Buffer.from('*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29').toString('hex'), grantLines: ["GRANT ALL PRIVILEGES ON `x`.* TO 'u'@'localhost'"] });
    expect(native.statements).toEqual(["CREATE USER 'u'@'%' IDENTIFIED WITH `mysql_native_password` AS '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'", "GRANT ALL PRIVILEGES ON `x`.* TO 'u'@'%'"]);
    expect(cloneUserStatements({ user: 'u', toHost: '%', engine: 'mysql', plugin: '', hashHex: '', grantLines: [] }).create).toBe("CREATE USER 'u'@'%'");
    expect(() => cloneUserStatements({ user: 'u', toHost: '%', engine: 'mysql', plugin: 'x; DROP', hashHex: '', grantLines: [] })).toThrow(OpError);
  });

  it('picks the PostgreSQL systemd unit from a list-units listing', () => {
    expect(pickPgUnit('postgresql.service loaded active exited PostgreSQL RDBMS\npostgresql@16-main.service loaded active running PostgreSQL Cluster 16-main\n')).toBe('postgresql');
    expect(pickPgUnit('postgresql-15.service loaded active running PostgreSQL 15 database server\n')).toBe('postgresql-15');
    expect(pickPgUnit('postgresql@14-main.service loaded active running x\n')).toBe('postgresql@14-main');
    expect(pickPgUnit('')).toBeNull();
    expect(pickPgUnit('postgresql-common.service loaded inactive dead x\n')).toBeNull();
  });

  it('parses mysqlcheck output', () => {
    const out = parseMysqlcheck('alice_shop.orders                                  OK\nalice_shop.items\nwarning  : Table is marked as crashed\nerror    : Corrupt\nblog.posts\nstatus   : OK\nnote     : Table does not support optimize, doing recreate + analyze instead\n');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ table: 'alice_shop.orders', status: 'ok' });
    expect(out[1]).toMatchObject({ table: 'alice_shop.items', status: 'error' });
    expect(out[1].messages).toHaveLength(2);
    expect(out[2].status).not.toBe('error');
  });

  it('renders and parses the managed cnf include', () => {
    const text = renderCnf({ 'max-connections': '300', 'skip-name-resolve': '', 'innodb-buffer-pool-size': '1G', dropped: null });
    expect(text.startsWith('# Managed by WHM panel')).toBe(true);
    expect(text).toContain('[mysqld]\ninnodb-buffer-pool-size=1G\nmax-connections=300\nskip-name-resolve\n');
    expect(text).not.toContain('dropped');
    expect(parseCnf(text).mysqld).toEqual({ 'innodb-buffer-pool-size': '1G', 'max-connections': '300', 'skip-name-resolve': '' });
    expect(parseCnf('[mysqld]\nmax_connections = "200"\n!includedir /etc/x\n[client]\nport=3306\n')).toEqual({ mysqld: { 'max-connections': '200' }, client: { port: '3306' } });
  });

  it('renders option files with escaped passwords', () => {
    const cnf = renderClientCnf({ host: 'db.example.net', port: 3307, user: 'admin', password: 'p"a\\s#w' });
    expect(cnf).toContain('[client]\nhost="db.example.net"\nport=3307\nuser="admin"\npassword="p\\"a\\\\s#w"\n');
    expect(cnf).not.toContain('bind-address');
    expect(renderRootMyCnf('x"y')).toContain('user=root\npassword="x\\"y"');
  });

  it('writes the remote source address as a loose client option so MariaDB clients only warn', () => {
    const cnf = renderClientCnf({ host: 'db.example.net', user: 'admin', password: 'pw', bindAddress: '203.0.113.10' });
    expect(cnf).toContain('\nloose-bind-address="203.0.113.10"\n');
    expect(cnf.indexOf('[client]')).toBeLessThan(cnf.indexOf('loose-bind-address'));
    expect(renderClientCnf({ host: '2001:db8::5', user: 'admin', bindAddress: '2001:db8::10' })).toContain('loose-bind-address="2001:db8::10"');
    expect(clientWarnings("mysql: unknown variable 'loose-bind-address=203.0.113.10'\nWARNING: something\n")).toEqual(["mysql: unknown variable 'loose-bind-address=203.0.113.10'", 'WARNING: something']);
    expect(clientWarnings("ERROR 1045 (28000): Access denied\n")).toEqual([]);
    expect(clientWarnings('')).toEqual([]);
  });

  it('classifies --validate-config output: rejections, clean runs and probes that could not run', () => {
    expect(classifyProbeOutput(1, "2026-10-26T10:00:00.000000Z 0 [ERROR] [MY-000067] [Server] unknown variable 'bogus_option=1'.\n2026-10-26T10:00:00.000000Z 0 [ERROR] [MY-010119] [Server] Aborting\n")).toEqual({ validated: true, ok: false, output: "2026-10-26T10:00:00.000000Z 0 [ERROR] [MY-000067] [Server] unknown variable 'bogus_option=1'." });
    expect(classifyProbeOutput(1, "[ERROR] [MY-010140] [Server] Error while setting value '10x' to 'max_connections'.\n")).toMatchObject({ validated: true, ok: false });
    expect(classifyProbeOutput(0, '')).toEqual({ validated: true, ok: true, output: '' });
    expect(classifyProbeOutput(0, '2026-10-26T10:00:00.000000Z 0 [System] [MY-013169] [Server] /usr/sbin/mysqld (mysqld 8.0.39) initializing of server in progress\n')).toMatchObject({ validated: true, ok: true });
    // The root guard is a probe failure, never a configuration rejection.
    const rootGuard = classifyProbeOutput(1, "2026-10-26T10:00:00.000000Z 0 [ERROR] [MY-010123] [Server] Fatal error: Please read \"Security\" section of the manual to find out how to run mysqld as root!\n2026-10-26T10:00:00.000000Z 0 [ERROR] [MY-010119] [Server] Aborting\n");
    expect(rootGuard).toMatchObject({ validated: false, ok: true });
    expect(rootGuard.output).toMatch(/not validated/);
    expect(classifyProbeOutput(1, "mysqld: Fatal error: Can't change to run as user 'mysql' ;  Please check that the user exists!\n")).toMatchObject({ validated: false, ok: true });
    // Anything else that exits non-zero is still treated as a rejection.
    expect(classifyProbeOutput(1, '[ERROR] [MY-010119] [Server] Aborting\n')).toMatchObject({ validated: true, ok: false, output: '[ERROR] [MY-010119] [Server] Aborting' });
  });

  it('validateServerConfig probes as the mysql user and falls back to MariaDB --help --verbose', async () => {
    const original = exec.getMockImplementation();
    const script = (answers) => exec.mockImplementation(async (bin, argv) => { const a = answers(bin, argv); return { code: 0, stdout: '', stderr: '', bin, argv, ...a }; });
    try {
      exec.mockClear();
      // MySQL 8 as root, valid file: --user=mysql is passed and the run is clean.
      script((bin, argv) => (argv.includes('--validate-config') ? { code: 0 } : { code: 1, stderr: 'unexpected' }));
      expect(await validateServerConfig('mysqld')).toEqual({ validated: true, ok: true, output: '' });
      expect(exec.mock.calls[0][0]).toBe('mysqld');
      expect(exec.mock.calls[0][1]).toEqual(['--validate-config', '--user=mysql']);
      expect(exec).toHaveBeenCalledTimes(1);

      // MySQL 8 rejects an unknown variable.
      exec.mockClear();
      script(() => ({ code: 1, stderr: "[ERROR] [MY-000067] [Server] unknown variable 'bogus-option=1'.\n[ERROR] [MY-010119] [Server] Aborting\n" }));
      const bad = await validateServerConfig('mysqld');
      expect(bad).toMatchObject({ validated: true, ok: false });
      expect(bad.output).toMatch(/unknown variable 'bogus-option=1'/);

      // A probe stopped by the root guard does not count as a rejection.
      exec.mockClear();
      script(() => ({ code: 1, stderr: '[ERROR] [MY-010123] [Server] Fatal error: Please read "Security" section of the manual to find out how to run mysqld as root!\n' }));
      expect(await validateServerConfig('mysqld')).toMatchObject({ validated: false, ok: true });

      // MariaDB: no --validate-config; --help --verbose parses the files.
      exec.mockClear();
      script((bin, argv) => (argv.includes('--validate-config') ? { code: 2, stderr: "mariadbd: unknown option '--validate-config'\n" } : { code: 0, stdout: 'Usage: mariadbd [OPTIONS]\n\nVariables (--variable-name=value)\nmax-connections 151\n' }));
      expect(await validateServerConfig('mariadbd')).toEqual({ validated: true, ok: true, output: '' });
      expect(exec.mock.calls[1][1]).toEqual(['--help', '--verbose', '--user=mysql']);

      exec.mockClear();
      script((bin, argv) => (argv.includes('--validate-config') ? { code: 2, stderr: "mariadbd: unknown option '--validate-config'\n" } : { code: 1, stderr: "2026-10-26 10:00:00 0 [ERROR] /usr/sbin/mariadbd: unknown variable 'bogus-option=1'\n" }));
      const mariaBad = await validateServerConfig('mariadbd');
      expect(mariaBad).toMatchObject({ validated: true, ok: false });
      expect(mariaBad.output).toMatch(/unknown variable 'bogus-option=1'/);

      exec.mockClear();
      expect(await validateServerConfig(null)).toMatchObject({ validated: false, ok: true });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockImplementation(original);
    }
  });

  it('classifies mysql client errors', () => {
    expect(classifyMysqlError("ERROR 2002 (HY000): Can't connect to local MySQL server through socket")).toMatchObject({ code: 'db_unreachable', errno: 2002 });
    expect(classifyMysqlError("ERROR 1045 (28000): Access denied for user 'root'@'localhost'")).toMatchObject({ code: 'db_auth_failed' });
    expect(classifyMysqlError("ERROR 1007 (HY000) at line 1: Can't create database 'x'; database exists")).toMatchObject({ code: 'exists', message: "Can't create database 'x'; database exists" });
    expect(classifyMysqlError("ERROR 1008 (HY000): Can't drop database 'x'; database doesn't exist").code).toBe('not_found');
    expect(classifyMysqlError('').code).toBe('db_error');
  });

  it('reads phpMyAdmin versions from the usual files', () => {
    expect(phpMyAdminVersion('/nonexistent-dir')).toBeNull();
  });

  it('exports the grantable privilege list used by the panel', () => {
    expect(PRIVILEGES).toContain('ALL PRIVILEGES');
    expect(PRIVILEGES).not.toContain('SUPER');
    expect(PRIVILEGES).not.toContain('FILE');
  });
});

describe('db.grants.list', () => {
  it('returns parsed grants only, never the SHOW GRANTS text that carries the MariaDB password hash', async () => {
    const actual = await vi.importActual('../src/exec.js');
    hasBinary.mockImplementation((name) => name === 'mysql' || actual.hasBinary(name));
    exec.mockClear();
    const lines = ["GRANT USAGE ON *.* TO `app`@`localhost` IDENTIFIED BY PASSWORD '*94BDCEBE19083CE2A1F959FD02F964C7AF4CFC29'", 'GRANT ALL PRIVILEGES ON `shop`.* TO `app`@`localhost`', 'GRANT SELECT, INSERT ON `blog`.* TO `app`@`localhost`'];
    exec.mockImplementation(async (bin, argv, opts) => ({ code: 0, stdout: `${lines.join('\n')}\n`, stderr: '', bin, argv, opts }));
    try {
      const result = await runOp('db.grants.list', { user: 'app' }, ctx);
      expect(result).toEqual({ user: 'app', host: 'localhost', grants: [{ privileges: ['ALL PRIVILEGES'], database: 'shop', table: '*' }, { privileges: ['SELECT', 'INSERT'], database: 'blog', table: '*' }] });
      expect(JSON.stringify(result)).not.toMatch(/94BDCEBE|IDENTIFIED|"raw"/);
      expect(exec).toHaveBeenCalledTimes(1);
      const [bin, argv, opts] = exec.mock.calls[0];
      expect(bin).toBe('mysql');
      expect(argv).toContain('--skip-column-names');
      expect(opts.input).toMatch(/^SHOW GRANTS FOR .*app.*localhost/);
    } finally { hasBinary.mockImplementation(actual.hasBinary); exec.mockImplementation(actual.exec); }
  });
});
