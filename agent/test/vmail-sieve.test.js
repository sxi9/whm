import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { sievePaths, parseSievecOutput, SIEVE_SCRIPT, SIEVE_BINARY, SIEVE_ACTIVE, SIEVE_GLOBAL_DIR, SIEVE_MAX_BYTES } from '../src/ops/vmail.js';
import { SYSTEM_USERS } from '../src/ops/as-user.js';
import { renderDovecotVirtualAuth, renderDovecotSieve, SIEVE_PATHS } from '../../server/src/services/service-configuration.js';

// exec/hasBinary/resolveBinary are spied: the op sequence is asserted against a
// scripted exec, so no command ever runs and no file under a home is written.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary), resolveBinary: vi.fn(mod.resolveBinary) };
});
const { exec, hasBinary, resolveBinary } = await import('../src/exec.js');

const ctx = createContext();
const OPS = ['vmail.sieve.write', 'vmail.sieve.test', 'vmail.sieve.remove'];
const SCRIPT = 'require ["fileinto", "mailbox"];\nif header :contains "subject" "[test]" {\n  fileinto :create "Junk";\n  stop;\n}\n';

// A real managed account (home under /home) the schemas may name; every op
// below either refuses before exec or runs against the scripted exec.
const MANAGED = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && /^\/home\//.test(home || '') && !SYSTEM_USERS.has(name) && fs.existsSync(home));
const USER = MANAGED?.[0] ?? null;
const HOME = MANAGED?.[5] ?? null;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

async function invalid(name, args) {
  exec.mockClear();
  const err = await opError(runOp(name, args, ctx));
  expect(err.code, `${name} ${JSON.stringify(args)}`).toBe('invalid_args');
  expect(exec).not.toHaveBeenCalled();
}

// Scripted exec: answers per program name (the program is argv[N] after
// setpriv/runuser's "--"), records every call.
function scriptExec(answers) {
  const calls = [];
  hasBinary.mockImplementation(() => true);
  resolveBinary.mockImplementation((bin) => (bin.startsWith('/') ? bin : `/usr/bin/${bin}`));
  exec.mockImplementation(async (bin, argv, opts = {}) => {
    const i = argv.indexOf('--');
    const program = i >= 0 && (bin === 'setpriv' || bin === 'runuser') ? argv[i + 1].replace(/^.*\//, '') : bin;
    const rest = i >= 0 && (bin === 'setpriv' || bin === 'runuser') ? argv.slice(i + 2) : argv;
    calls.push({ bin, program, argv: rest, opts });
    const a = answers[program];
    return typeof a === 'function' ? a(rest, opts) : (a || { code: 0, stdout: '', stderr: '' });
  });
  return calls;
}

afterEach(() => { exec.mockReset(); hasBinary.mockReset(); resolveBinary.mockReset(); });

describe('vmail.sieve op catalog', () => {
  it('registers the three ops; only remove is destructive', () => {
    for (const name of OPS) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('vmail.sieve.remove').destructive).toBe(true);
    expect(catalog.get('vmail.sieve.write').destructive).toBe(false);
    expect(catalog.get('vmail.sieve.test').destructive).toBe(false);
  });

  it('schemas are strict and tie the mailbox to the scope', async () => {
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'account', script: SCRIPT, extra: 1 });
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'mailbox', script: SCRIPT });
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'account', mailbox: 'info@alice.com', script: SCRIPT });
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'global', script: SCRIPT });
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'account', script: 'a\0b' });
    await invalid('vmail.sieve.write', { username: 'alice', scope: 'account', script: 'x'.repeat(SIEVE_MAX_BYTES + 1) });
    await invalid('vmail.sieve.test', { username: 'alice', scope: 'mailbox', mailbox: 'info@alice.com' });
    await invalid('vmail.sieve.remove', { username: 'alice', scope: 'mailbox' });
    await invalid('vmail.sieve.remove', { username: 'alice', scope: 'account', script: '' });
    for (const bad of ['-root', 'Admin', 'a;b', '../x', '', 'alice user', '$(id)']) await invalid('vmail.sieve.write', { username: bad, scope: 'account', script: SCRIPT });
    for (const bad of ['Info@alice.com', 'a b@c.com', 'a@c.com\n', '${lookup}@c.com', '../x@c.com', 'info@../etc']) await invalid('vmail.sieve.write', { username: 'alice', scope: 'mailbox', mailbox: bad, script: SCRIPT });
  });

  it('refuses system accounts and unknown users before anything runs', async () => {
    exec.mockClear();
    hasBinary.mockImplementation(() => true);
    for (const name of OPS) {
      const base = name === 'vmail.sieve.remove' ? {} : { script: SCRIPT };
      expect((await opError(runOp(name, { username: 'root', scope: 'account', ...base }, ctx))).code, name).toBe('refused');
      expect((await opError(runOp(name, { username: 'nouser0badc0de', scope: 'account', ...base }, ctx))).code, name).toBe('not_found');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports capability_missing without sievec before running anything', async () => {
    exec.mockClear();
    hasBinary.mockImplementation((bin) => bin !== 'sievec');
    for (const name of ['vmail.sieve.write', 'vmail.sieve.test']) {
      const err = await opError(runOp(name, { username: USER || 'alice', scope: 'account', script: SCRIPT }, ctx));
      expect(['capability_missing', 'not_found']).toContain(err.code);
    }
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('sievePaths', () => {
  it('pins every file under the account home where the Dovecot fragment looks', () => {
    const m = sievePaths('/home/alice', 'mailbox', 'info@alice.com');
    expect(m).toEqual({
      dir: '/home/alice/mail/alice.com/info/sieve', script: `/home/alice/mail/alice.com/info/sieve/${SIEVE_SCRIPT}`, binary: `/home/alice/mail/alice.com/info/sieve/${SIEVE_BINARY}`,
      maildir: '/home/alice/mail/alice.com/info', active: '/home/alice/mail/alice.com/.info.sieve', activeBinary: '/home/alice/mail/alice.com/.info.svbin', activeTarget: `info/sieve/${SIEVE_SCRIPT}`,
    });
    const g = sievePaths('/home/alice', 'account');
    expect(g.script).toBe(`/home/alice/${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}`);
    expect(g.active).toBeNull();
    expect(() => sievePaths('/home/alice', 'mailbox')).toThrow(OpError);
    expect(() => sievePaths('/home/alice', 'mailbox', 'a/../b@c.com')).toThrow(OpError);
    // service-configuration points Dovecot at the same places (2.3 and 2.4 syntax).
    expect(SIEVE_PATHS.globalScript).toBe(`${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}`);
    // The active link lives beside the maildir (a dot entry inside it would be taken for a folder).
    expect(SIEVE_ACTIVE).toBe('.<local>.sieve');
    expect(SIEVE_PATHS.active('%n')).toBe('.%n.sieve');
    expect(m.active.startsWith(`${m.maildir}/`)).toBe(false);
    const v24 = renderDovecotVirtualAuth({ version: '2.4.2', sieve: true });
    expect(v24).toContain('protocol lmtp {\n  auth_username_format = %{user | lower}\n  mail_plugins {\n    sieve = yes\n  }\n}');
    expect(v24).toContain('sieve_script personal {\n  type = personal\n  path = ~/mail/%{user | domain}/%{user | username}/sieve\n  active_path = ~/mail/%{user | domain}/.%{user | username}.sieve\n}');
    expect(v24).toContain(`sieve_script keel_account {\n  type = before\n  path = ~/${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}\n}`);
    const v23 = renderDovecotVirtualAuth({ version: '2.3.21', sieve: true });
    expect(renderDovecotVirtualAuth({ version: '2.4.2' })).not.toMatch(/sieve/i);
    expect(v23).toContain('protocol lmtp {\n  mail_plugins = $mail_plugins sieve\n}');
    expect(v23).toContain('  sieve = file:~/mail/%d/%n/sieve;active=~/mail/%d/.%n.sieve');
    expect(v23).toContain(`  sieve_before = ~/${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}`);
    expect(renderDovecotSieve(true).join('\n')).not.toMatch(/plugin \{|%d|%n/);
  });
});

describe('parseSievecOutput', () => {
  it('keeps the compiler lines and drops doveconf noise', () => {
    const out = parseSievecOutput('doveconf: Warning: service auth { client_limit=1000 } is lower\nkeel: line 2: error: expected end of compound block.\nkeel: error: parse failed.\nkeel: line 1: warning: unused require.\nsievec: Fatal: failed to compile sieve script\n');
    expect(out.errors).toEqual([{ line: 2, message: 'expected end of compound block.' }, { line: null, message: 'parse failed.' }]);
    expect(out.warnings).toEqual([{ line: 1, message: 'unused require.' }]);
    expect(parseSievecOutput('')).toEqual({ errors: [], warnings: [] });
  });
});

describe('vmail.sieve.write as the account (scripted exec)', () => {
  it('stages, compiles with sievec, then moves and activates; every command runs under the account uid', async () => {
    if (!USER) return;
    const calls = scriptExec({});
    const r = await runOp('vmail.sieve.write', { username: USER, scope: 'account', script: SCRIPT }, ctx);
    const programs = calls.map((c) => c.program);
    expect(programs).toEqual(['mkdir', 'dd', 'chmod', 'sievec', 'chmod', 'mv', 'mv', 'rm']);
    expect(calls.every((c) => c.bin === 'setpriv' || c.bin === 'runuser')).toBe(true);
    const dir = `${HOME}/${SIEVE_GLOBAL_DIR}`;
    expect(calls[0].argv).toEqual(['-p', '-m', '0700', '--', dir]);
    const stage = calls[1].argv[0].slice('of='.length);
    expect(stage.startsWith(`${dir}/${SIEVE_SCRIPT}.whm-`)).toBe(true);
    expect(calls[1].opts.input.toString()).toBe(SCRIPT);
    expect(calls[2].argv).toEqual(['--', '0600', stage]);
    expect(calls[3].argv).toEqual([stage, `${stage}.svbin`]);
    expect(calls[5].argv).toEqual(['-f', '-T', '--', stage, `${dir}/${SIEVE_SCRIPT}`]);
    expect(calls[6].argv).toEqual(['-f', '-T', '--', `${stage}.svbin`, `${dir}/${SIEVE_BINARY}`]);
    expect(programs).not.toContain('ln');
    expect(r).toMatchObject({ scope: 'account', mailbox: null, path: `${dir}/${SIEVE_SCRIPT}`, active: null, activated: false, bytes: SCRIPT.length });
    // setpriv drops to the account and ends its options with "--".
    const first = exec.mock.calls[0];
    if (first[0] === 'setpriv') expect(first[1].slice(0, 7)).toEqual(['--reuid', MANAGED[2], '--regid', MANAGED[3], '--clear-groups', '--no-new-privs', '--']);
  });

  it('keeps the live script and never activates when sievec fails; the staged pair is removed', async () => {
    if (!USER) return;
    const calls = scriptExec({ sievec: { code: 89, stdout: '', stderr: 'keel: line 3: error: unknown command.\nkeel: error: parse failed.\nsievec: Fatal: failed to compile sieve script\n' } });
    const err = await opError(runOp('vmail.sieve.write', { username: USER, scope: 'account', script: SCRIPT }, ctx));
    expect(err.code).toBe('invalid_sieve');
    expect(err.message).toContain('line 3: unknown command.');
    expect(err.details.errors).toEqual([{ line: 3, message: 'unknown command.' }, { line: null, message: 'parse failed.' }]);
    const programs = calls.map((c) => c.program);
    expect(programs).toEqual(['mkdir', 'dd', 'chmod', 'sievec', 'rm']);
    expect(programs).not.toContain('mv');
    expect(programs).not.toContain('ln');
    const stage = calls[1].argv[0].slice('of='.length);
    expect(calls[4].argv).toEqual(['-f', '--', stage, `${stage}.svbin`]);
  });

  it('refuses a mailbox without a maildir before any command runs', async () => {
    if (!USER) return;
    const calls = scriptExec({});
    const err = await opError(runOp('vmail.sieve.write', { username: USER, scope: 'mailbox', mailbox: 'probe-nonexistent@example.invalid', script: SCRIPT }, ctx));
    expect(err.code).toBe('not_found');
    expect(calls).toEqual([]);
  });

  it('vmail.sieve.test compiles with -d and answers ok:false with the errors instead of failing', async () => {
    if (!USER) return;
    const calls = scriptExec({ sievec: { code: 89, stdout: '', stderr: 'keel: line 1: error: bad.\n' } });
    const r = await runOp('vmail.sieve.test', { username: USER, scope: 'account', script: 'if {' }, ctx);
    expect(r).toEqual({ ok: false, errors: [{ line: 1, message: 'bad.' }], warnings: [] });
    const programs = calls.map((c) => c.program);
    expect(programs).toEqual(['mkdir', 'dd', 'chmod', 'sievec', 'rm']);
    expect(calls[3].argv[0]).toBe('-d');
    expect(calls[3].argv[1]).toMatch(new RegExp(`^${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}\\.whm-`));
  });

  it('vmail.sieve.remove deletes the pair as the account and only unlinks an active symlink it owns', async () => {
    if (!USER) return;
    const calls = scriptExec({});
    const r = await runOp('vmail.sieve.remove', { username: USER, scope: 'account' }, ctx);
    expect(calls.map((c) => c.program)).toEqual(['rm']);
    expect(calls[0].argv).toEqual(['-f', '--', `${HOME}/${SIEVE_GLOBAL_DIR}/${SIEVE_SCRIPT}`, `${HOME}/${SIEVE_GLOBAL_DIR}/${SIEVE_BINARY}`]);
    expect(r).toMatchObject({ scope: 'account', removed: false, deactivated: false });
  });
});
