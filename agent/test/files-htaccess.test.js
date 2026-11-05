import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// as-user.js is replaced by an in-process emulation of the few programs the
// family runs (cat, dd, chmod, mv, rm, mkdir) inside a scratch home, so the
// merge, the probe and the rollback are exercised end to end without a real
// account; the real asUserArgv is still checked for the argv shape.
const scratch = vi.hoisted(() => ({ home: null, calls: [], info: { username: 'alice', uid: 1234, gid: 1234, home: null } }));

vi.mock('../src/ops/as-user.js', async (importOriginal) => {
  const real = await importOriginal();
  const { OpError } = await import('../src/ops/registry.js');
  const posix = (p) => p.split(path.sep).join('/');
  const local = (p) => (process.platform === 'win32' ? p.split('/').join(path.sep) : p);
  const under = (p) => { const r = path.resolve(p); const h = path.resolve(scratch.home); if (r !== h && !r.startsWith(h + path.sep)) throw new OpError('path_not_allowed', `${p} is not inside the home directory`); return r; };
  const accountPath = (username, p, ctx, mode = 'read') => {
    if (username !== 'alice') throw new OpError('not_found', `Linux user "${username}" does not exist`);
    const home = path.resolve(scratch.home);
    const target = under(p);
    ctx.assertAllowedPath(target, mode);
    return { info: { ...scratch.info, home: posix(home) }, home: posix(home), target: posix(target), real: posix(target), realHome: posix(home) };
  };
  const assertManaged = (username) => accountPath(username, scratch.home, { assertAllowedPath: () => {} }).info;
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const asUser = async (info, bin, argv, opts = {}) => {
    scratch.calls.push([bin, ...argv]);
    const last = argv.at(-1);
    switch (bin) {
      case 'cat': { try { return ok(fs.readFileSync(local(last), 'utf8')); } catch { return { code: 1, stdout: '', stderr: `cat: ${last}: No such file or directory` }; } }
      case 'dd': { fs.writeFileSync(local(argv[0].slice(3)), opts.input); return ok(); }
      case 'chmod': return ok();
      case 'mv': { fs.renameSync(local(argv[3]), local(argv[4])); return ok(); }
      case 'rm': { fs.rmSync(local(last), { force: true }); return ok(); }
      case 'mkdir': { fs.mkdirSync(local(last), { recursive: true }); return ok(); }
      default: throw new Error(`unexpected program ${bin}`);
    }
  };
  return { ...real, accountPath, assertManaged, asUser };
});

// The mocked module and the family are imported by their relative paths before
// the catalog loads every family through file URLs, so both resolve to the
// same (mocked) module instance.
const { asUserArgv } = await import('../src/ops/as-user.js');
const ht = await import('../src/ops/htaccess.js');
const { runOp, createContext, OpError, catalog } = await import('../src/lib.js');

const HOME = '/home/alice';
const USERFILE = `${HOME}/.keel/htpasswd/0123456789abcdef`;
let ctx;
let server;
let port;
const rd = (rel) => fs.readFileSync(path.join(scratch.home, ...rel.split('/')), 'utf8');
const wr = (rel, content) => { const f = path.join(scratch.home, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
const exists = (rel) => fs.existsSync(path.join(scratch.home, ...rel.split('/')));
const docroot = () => `${scratch.home.split(path.sep).join('/')}/public_html`;
async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

beforeAll(async () => {
  scratch.home = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-ht-'));
  scratch.info.home = scratch.home;
  fs.mkdirSync(path.join(scratch.home, 'public_html', 'private'), { recursive: true });
  fs.mkdirSync(path.join(scratch.home, 'mail'), { recursive: true });
  ctx = createContext({ allowedRoots: [scratch.home] });
  server = http.createServer((req, res) => { res.statusCode = req.url.startsWith('/broken/') ? 500 : req.url.startsWith('/private/') ? 401 : 200; res.end('x'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => { server?.close(); if (scratch.home) fs.rmSync(scratch.home, { recursive: true, force: true }); });
beforeEach(() => { scratch.calls.length = 0; });

describe('catalog', () => {
  it('registers the family without destructive flags', () => {
    for (const n of ['files.htaccess.get', 'files.htaccess.set', 'files.htaccess.probe', 'files.htpasswd.get', 'files.htpasswd.set', 'files.errorpages.list', 'files.errorpages.write']) {
      expect(catalog.has(n), n).toBe(true);
      expect(catalog.get(n).destructive).toBe(false);
    }
  });
});

describe('renderBlock grammar', () => {
  const spec = { denyIps: ['203.0.113.9', '10.0.0.0/8', '2001:db8::/32'], errorDocuments: { 404: '/errors/404.html', 500: '/errors/500.html' }, indexes: 'off', auth: { realm: "Members' area (v2)", userFile: USERFILE } };

  it('renders only the directives of the family, in a RequireAll when addresses are denied', () => {
    const lines = ht.validateBlock(ht.renderBlock(spec, { home: HOME }));
    expect(lines[0]).toBe(ht.BEGIN);
    expect(lines.at(-1)).toBe(ht.END);
    expect(lines).toContain('Options -Indexes');
    expect(lines).toContain('ErrorDocument 404 /errors/404.html');
    expect(lines).toContain('ErrorDocument 500 /errors/500.html');
    expect(lines).toContain('AuthType Basic');
    expect(lines).toContain('AuthName "Members\' area (v2)"');
    expect(lines).toContain(`AuthUserFile "${USERFILE}"`);
    expect(lines.slice(lines.indexOf('<RequireAll>'), lines.indexOf('</RequireAll>') + 1)).toEqual(['<RequireAll>', '  Require valid-user', '  Require not ip 203.0.113.9 10.0.0.0/8 2001:db8::/32', '</RequireAll>']);
    expect(lines.filter((l) => /^Require valid-user$/.test(l))).toHaveLength(0);
  });

  it('keeps access open under a deny list without auth, needs nothing for an empty spec and splits long lists', () => {
    const open = ht.renderBlock({ denyIps: ['203.0.113.9'] }, { home: HOME });
    expect(open).toEqual([ht.BEGIN, expect.stringMatching(/^# Managed/), '<RequireAll>', '  Require all granted', '  Require not ip 203.0.113.9', '</RequireAll>', ht.END]);
    const only = ht.renderBlock({ auth: { realm: 'x', userFile: USERFILE } }, { home: HOME });
    expect(only).toContain('Require valid-user');
    expect(only).not.toContain('<RequireAll>');
    expect(ht.renderBlock({}, { home: HOME })).toHaveLength(3);
    expect(ht.renderBlock({ indexes: 'on' }, { home: HOME })).toContain('Options +Indexes');
    const many = ht.renderBlock({ denyIps: Array.from({ length: 40 }, (_, i) => `10.0.${i}.0/24`) }, { home: HOME });
    expect(many.filter((l) => l.startsWith('  Require not ip ')).length).toBe(3);
    ht.validateBlock(many);
  });

  it('refuses injection in every field at the schema', () => {
    const bad = [
      { denyIps: ['203.0.113.9 all granted'] }, { denyIps: ['1.2.3.4/33'] }, { denyIps: ['2001:db8::/129'] }, { denyIps: ['fe80::1%eth0'] }, { denyIps: ['example.com'] }, { denyIps: ['1.2.3.4\nRequire all denied'] },
      { errorDocuments: { 404: '/errors/../../x.html' } }, { errorDocuments: { 404: 'http://evil/x.html' } }, { errorDocuments: { 404: '/errors/x.html "y"' } }, { errorDocuments: { 418: '/errors/418.html' } }, { errorDocuments: { 404: '/errors/x.php' } },
      { indexes: 'yes' }, { indexes: '-Indexes +ExecCGI' },
      { auth: { realm: 'a"b', userFile: USERFILE } }, { auth: { realm: 'a\nb', userFile: USERFILE } }, { auth: { realm: 'a\\b', userFile: USERFILE } }, { auth: { realm: '', userFile: USERFILE } }, { auth: { realm: 'x'.repeat(65), userFile: USERFILE } },
      { auth: { realm: 'ok', userFile: `${HOME}/.keel/htpasswd/../../.ssh/authorized_keys` } }, { auth: { realm: 'ok', userFile: 'relative/file' } }, { auth: { realm: 'ok' } },
      { extra: true },
    ];
    for (const b of bad) expect(ht.blockSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(() => ht.renderBlock({ auth: { realm: 'ok', userFile: '/etc/passwd' } }, { home: HOME })).toThrow(/AuthUserFile/);
    expect(() => ht.renderBlock({ auth: { realm: 'ok', userFile: `${HOME}/.keel/htpasswd/notanid` } }, { home: HOME })).toThrow(/AuthUserFile/);
    expect(() => ht.renderBlock({ auth: { realm: 'ok', userFile: `/home/bob/.keel/htpasswd/0123456789abcdef` } }, { home: HOME })).toThrow(/AuthUserFile/);
  });

  it('validateBlock refuses anything outside the grammar', () => {
    const base = ht.renderBlock({ indexes: 'off' }, { home: HOME });
    for (const line of ['php_value auto_prepend_file /tmp/x', 'Require all denied', 'Options +ExecCGI', 'ErrorDocument 404 http://evil/', 'AuthName "a" "b"', 'AuthUserFile "/etc/passwd"', '  Require not ip evil', 'RewriteRule . /x', '']) {
      expect(() => ht.validateBlock([base[0], line, base.at(-1)]), line).toThrow(/grammar/);
    }
    expect(() => ht.validateBlock(base.slice(1))).toThrow(/markers/);
  });
});

describe('merge and parse', () => {
  const block = ht.renderBlock({ denyIps: ['203.0.113.9'], indexes: 'off' }, { home: HOME });

  it('appends after a blank line, replaces in place, keeps everything else byte for byte and removes cleanly', () => {
    const user = 'RewriteEngine On\r\nRewriteRule ^old$ /new [R=301]\r\n';
    const once = ht.mergeBlock(user, block);
    expect(once.startsWith(user)).toBe(true);
    expect(once).toBe(`${user}\n${block.join('\n')}\n`);
    const tail = '\n# my own line after\n';
    const edited = once + tail;
    const next = ht.renderBlock({ indexes: 'on' }, { home: HOME });
    const twice = ht.mergeBlock(edited, next);
    expect(twice).toBe(`${user}\n${next.join('\n')}\n${tail}`);
    expect(ht.parseFile(twice)).toEqual({ managed: true, spec: { denyIps: [], errorDocuments: {}, indexes: 'on', auth: null }, foreign: 0 });
    expect(ht.mergeBlock(twice, null)).toBe(`${user}${tail}`);
    expect(ht.mergeBlock(ht.mergeBlock('', block), null)).toBe('');
    expect(ht.mergeBlock('', null)).toBe('');
    expect(ht.parseFile(user)).toEqual({ managed: false, spec: null, foreign: 0 });
  });

  it('round-trips a full spec and counts hand-edited lines inside the markers', () => {
    const spec = { denyIps: ['203.0.113.9', '10.0.0.0/8'], errorDocuments: { 403: '/errors/403.html' }, indexes: 'off', auth: { realm: 'Staff', userFile: USERFILE } };
    const text = ht.mergeBlock('', ht.renderBlock(spec, { home: HOME }));
    expect(ht.parseFile(text).spec).toEqual(spec);
    const tampered = text.replace('Options -Indexes', 'Options -Indexes\nphp_value auto_prepend_file /tmp/x');
    expect(ht.parseFile(tampered)).toMatchObject({ managed: true, foreign: 1 });
    expect(() => ht.parseFile(`${ht.BEGIN}\nOptions -Indexes\n`)).toThrow(/without/);
  });

  it('parses and renders htpasswd and error pages safely', () => {
    const hash = '$2y$10$' + 'a'.repeat(53);
    expect(ht.parseHtpasswd(`alice:${hash}\nbob:$apr1$x\n\nnocolon\n`)).toEqual({ entries: [{ user: 'alice', hash }], ignored: 2 });
    const page = ht.renderErrorPage({ code: '404', title: '<script>alert(1)</script> --> "q"', message: 'Line one\n\n<b>two</b> -- three' });
    expect(page).not.toContain('<script>');
    expect(page).toContain('&lt;script&gt;');
    expect(page.match(/-->/g)).toHaveLength(1);
    expect(page).toContain('<p>Line one</p>');
    expect(page).toContain('<p>&lt;b&gt;two&lt;/b&gt; -- three</p>');
    expect(ht.parseErrorPage(page)).toEqual({ code: '404', title: '<script>alert(1)</script> --> "q"', message: 'Line one\n\n<b>two</b> -- three' });
    expect(ht.parseErrorPage('<html>hand made</html>')).toBe(null);
  });
});

describe('ops against a scratch home', () => {
  it('as-user argv for the reads and writes is the setpriv form', () => {
    const info = { username: 'alice', uid: 1234, gid: 1234, home: HOME };
    const [exe, args] = asUserArgv(info, '/bin/cat', ['--', `${HOME}/public_html/.htaccess`], { tool: 'setpriv' });
    expect(exe).toBe('setpriv');
    expect(args).toEqual(['--reuid', '1234', '--regid', '1234', '--clear-groups', '--no-new-privs', '--', '/bin/cat', '--', `${HOME}/public_html/.htaccess`]);
  });

  it('refuses bad arguments and paths before any program runs', async () => {
    const cases = [
      ['files.htaccess.set', { username: 'alice', path: `${docroot()}/x`, block: { denyIps: ['nope'] } }],
      ['files.htaccess.set', { username: 'al ice', path: docroot(), block: {} }],
      ['files.htaccess.set', { username: 'alice', path: `${docroot()}/../mail`, block: {} }],
      ['files.htaccess.get', { username: 'alice', path: 'public_html' }],
      ['files.htaccess.probe', { username: 'alice', url: 'http://x.test/\nHost: evil' }],
      ['files.htaccess.probe', { username: 'alice', url: 'ftp://x.test/' }],
      ['files.htpasswd.set', { username: 'alice', id: '../x', entries: [] }],
      ['files.htpasswd.set', { username: 'alice', id: '0123456789abcdef', entries: [{ user: 'a:b', hash: '$2y$10$' + 'a'.repeat(53) }] }],
      ['files.htpasswd.set', { username: 'alice', id: '0123456789abcdef', entries: [{ user: 'a', hash: 'plain' }] }],
      ['files.htpasswd.set', { username: 'alice', id: '0123456789abcdef', entries: [], group: 'www-data; id' }],
      ['files.errorpages.write', { username: 'alice', docroot: docroot(), code: '418' }],
      ['files.errorpages.write', { username: 'alice', docroot: docroot(), code: '404', title: 'a\nb' }],
    ];
    for (const [op, args] of cases) {
      const err = await opError(runOp(op, args, ctx));
      expect(err.code, `${op} ${JSON.stringify(args)}`).toBe('invalid_args');
    }
    expect(scratch.calls).toEqual([]);
    for (const p of [`${scratch.home.split(path.sep).join('/')}/mail`, scratch.home.split(path.sep).join('/')]) {
      const err = await opError(runOp('files.htaccess.get', { username: 'alice', path: p }, ctx));
      expect(err.code).toBe('path_not_allowed');
    }
    expect((await opError(runOp('files.htaccess.get', { username: 'alice', path: `${docroot()}/missing` }, ctx))).code).toBe('not_found');
    expect(scratch.calls).toEqual([]);
  });

  it('get answers the parsed block and set merges it as the account, keeping the rest of the file', async () => {
    const dir = docroot();
    wr('public_html/.htaccess', 'RewriteEngine On\n');
    const before = await runOp('files.htaccess.get', { username: 'alice', path: dir }, ctx);
    expect(before).toMatchObject({ exists: true, managed: false, spec: null, rel: 'public_html' });
    scratch.calls.length = 0;
    const r = await runOp('files.htaccess.set', { username: 'alice', path: dir, block: { denyIps: ['203.0.113.9'], indexes: 'off' } }, ctx);
    expect(r).toMatchObject({ changed: true, created: false, removed: false, probe: null });
    const text = rd('public_html/.htaccess');
    expect(text.startsWith('RewriteEngine On\n')).toBe(true);
    expect(text).toContain('  Require not ip 203.0.113.9');
    expect(scratch.calls.map((c) => c[0])).toEqual(['cat', 'dd', 'chmod', 'mv']);
    const after = await runOp('files.htaccess.get', { username: 'alice', path: dir }, ctx);
    expect(after).toMatchObject({ managed: true, spec: { denyIps: ['203.0.113.9'], indexes: 'off', errorDocuments: {}, auth: null }, foreign: 0 });
    const same = await runOp('files.htaccess.set', { username: 'alice', path: dir, block: { denyIps: ['203.0.113.9'], indexes: 'off' } }, ctx);
    expect(same.changed).toBe(false);
    const gone = await runOp('files.htaccess.set', { username: 'alice', path: dir, block: null }, ctx);
    expect(gone).toMatchObject({ changed: true, removed: false });
    expect(rd('public_html/.htaccess')).toBe('RewriteEngine On\n');
    await runOp('files.htaccess.set', { username: 'alice', path: `${dir}/private`, block: { indexes: 'on' } }, ctx);
    expect(exists('public_html/private/.htaccess')).toBe(true);
    const removed = await runOp('files.htaccess.set', { username: 'alice', path: `${dir}/private`, block: null }, ctx);
    expect(removed).toMatchObject({ changed: true, removed: true });
    expect(exists('public_html/private/.htaccess')).toBe(false);
  });

  it('refuses a symlinked or oversized .htaccess', async () => {
    const dir = docroot();
    const link = path.join(scratch.home, 'public_html', 'private', '.htaccess');
    try { fs.symlinkSync(path.join(scratch.home, 'mail'), link); } catch { return; }
    try {
      expect((await opError(runOp('files.htaccess.set', { username: 'alice', path: `${dir}/private`, block: { indexes: 'off' } }, ctx))).code).toBe('refused');
      expect((await opError(runOp('files.htaccess.get', { username: 'alice', path: `${dir}/private` }, ctx))).code).toBe('refused');
      expect(scratch.calls).toEqual([]);
    } finally { fs.unlinkSync(link); }
  });

  it('rolls the file back when the probe answers 500 and keeps it on any other answer', async () => {
    const dir = docroot();
    fs.mkdirSync(path.join(scratch.home, 'public_html', 'broken'), { recursive: true });
    const err = await opError(runOp('files.htaccess.set', { username: 'alice', path: `${dir}/broken`, block: { indexes: 'off' }, probe: { url: `http://alice.test:${port}/broken/`, ip: '127.0.0.1' } }, ctx));
    expect(err.code).toBe('config_invalid');
    expect(err.details.probe.status).toBe(500);
    expect(exists('public_html/broken/.htaccess')).toBe(false);
    wr('public_html/broken/.htaccess', '# mine\n');
    const again = await opError(runOp('files.htaccess.set', { username: 'alice', path: `${dir}/broken`, block: { indexes: 'off' }, probe: { url: `http://alice.test:${port}/broken/`, ip: '127.0.0.1' } }, ctx));
    expect(again.code).toBe('config_invalid');
    expect(rd('public_html/broken/.htaccess')).toBe('# mine\n');
    const ok = await runOp('files.htaccess.set', { username: 'alice', path: `${dir}/private`, block: { auth: { realm: 'Staff', userFile: `${scratch.home.split(path.sep).join('/')}/.keel/htpasswd/0123456789abcdef` } }, probe: { url: `http://alice.test:${port}/private/`, ip: '127.0.0.1' } }, ctx);
    expect(ok.probe.status).toBe(401);
    expect(rd('public_html/private/.htaccess')).toContain('Require valid-user');
    const probe = await runOp('files.htaccess.probe', { username: 'alice', url: `http://alice.test:${port}/`, ip: '127.0.0.1' }, ctx);
    expect(probe.status).toBe(200);
    const down = await runOp('files.htaccess.probe', { username: 'alice', url: 'http://alice.test:1/', ip: '127.0.0.1' }, ctx);
    expect(down.status).toBe(null);
    expect(down.error).toBeTruthy();
  });

  it('writes and reads htpasswd files under .keel and error pages under errors/', async () => {
    const hash = '$2y$10$' + 'b'.repeat(53);
    const w = await runOp('files.htpasswd.set', { username: 'alice', id: '0123456789abcdef', entries: [{ user: 'alice', hash }] }, ctx);
    expect(w).toMatchObject({ users: ['alice'], mode: '0644', group: null });
    expect(rd('.keel/htpasswd/0123456789abcdef')).toBe(`alice:${hash}\n`);
    expect(scratch.calls.filter((c) => c[0] === 'mkdir').map((c) => c.slice(0, 3))).toEqual([['mkdir', '-p', '-m'], ['mkdir', '-p', '-m']]);
    const g = await runOp('files.htpasswd.get', { username: 'alice', id: '0123456789abcdef' }, ctx);
    expect(g).toMatchObject({ exists: true, entries: [{ user: 'alice', hash }], ignored: 0 });
    expect((await runOp('files.htpasswd.get', { username: 'alice', id: 'fedcba9876543210' }, ctx)).exists).toBe(false);
    expect((await opError(runOp('files.htpasswd.set', { username: 'alice', id: '0123456789abcdef', entries: [{ user: 'a', hash }, { user: 'a', hash }] }, ctx))).code).toBe('invalid_args');

    const page = await runOp('files.errorpages.write', { username: 'alice', docroot: docroot(), code: '404', title: 'Lost?', message: 'Try again' }, ctx);
    expect(page).toMatchObject({ rel: 'public_html/errors/404.html', url: '/errors/404.html' });
    expect(rd('public_html/errors/404.html')).toContain('<h1>Lost?</h1>');
    const list = await runOp('files.errorpages.list', { username: 'alice', docroot: docroot() }, ctx);
    expect(list.pages.find((p) => p.code === '404')).toMatchObject({ exists: true, managed: true, title: 'Lost?', message: 'Try again' });
    expect(list.pages.find((p) => p.code === '500')).toMatchObject({ exists: false, managed: false });
    wr('public_html/errors/403.html', '<p>hand made</p>');
    expect((await runOp('files.errorpages.list', { username: 'alice', docroot: docroot() }, ctx)).pages.find((p) => p.code === '403')).toMatchObject({ exists: true, managed: false });
  });
});
