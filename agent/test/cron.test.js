import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { validateCrontab, parseCrontab, isValidSchedule, splitJob, MAX_LINES } from '../src/ops/cron.js';
import { SYSTEM_USERS } from '../src/ops/as-user.js';

// crontab(1) is never run for real: the write/remove tests replace exec and
// only inspect the argv and stdin the op would have handed it.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');
const original = await vi.importActual('../src/exec.js');
const restore = () => { exec.mockReset(); exec.mockImplementation(original.exec); hasBinary.mockReset(); hasBinary.mockImplementation(original.hasBinary); };

const ctx = createContext();
const MANAGED = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find(([name, , uid, , , home]) => Number(uid) >= 1000 && Number(uid) < 65534 && /^\/home\//.test(home || '') && !SYSTEM_USERS.has(name));
const USER = MANAGED?.[0] ?? null;

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('cron op catalog', () => {
  it('registers the family with write and remove marked destructive', () => {
    for (const name of ['cron.user.read', 'cron.user.write', 'cron.user.remove']) expect(catalog.has(name), name).toBe(true);
    expect(catalog.get('cron.user.read').destructive).toBe(false);
    expect(catalog.get('cron.user.write').destructive).toBe(true);
    expect(catalog.get('cron.user.remove').destructive).toBe(true);
  });
});

describe('schedule validation', () => {
  it('accepts 5-field expressions with ranges, lists, steps and names, and the @ aliases', () => {
    for (const s of ['* * * * *', '0 0 * * *', '*/5 * * * *', '0 2 1,15 * *', '30 4 * * mon-fri', '0 0 1 jan *', '0 0 * * 7', '5 0 * 8 *', '@reboot', '@daily', '@hourly', '@midnight', '@annually']) {
      expect(isValidSchedule(s), s).toBe(true);
    }
  });
  it('refuses 6-field, out-of-range, malformed and unknown-alias schedules', () => {
    for (const s of ['* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', '* * * * $(id)', '@every', '@', '', '* * * *', 'a b c d e']) {
      expect(isValidSchedule(s), s).toBe(false);
    }
  });
});

describe('crontab line validator', () => {
  const ok = (text) => expect(validateCrontab(text), text).toBeNull();
  const bad = (text, re) => expect(validateCrontab(text), text).toMatch(re);

  it('accepts blanks, comments, environment lines, @reboot and ordinary jobs', () => {
    ok('');
    ok('# nothing\n\n');
    ok('MAILTO=alice@example.com\nPATH=/usr/bin:/bin\n0 3 * * * /home/alice/bin/backup.sh >/dev/null 2>&1\n');
    ok('@reboot /home/alice/app/start.sh\n@daily echo hi\n');
    ok('SHELL=/bin/bash\n*/15 * * * * php -q /home/alice/cron.php\n');
    ok('SHELL="/bin/sh"\n* * * * * echo "${HOME}"\n');
  });

  it('refuses carriage returns, NUL, lines starting with "-", 6-field schedules and bad env keys', () => {
    bad('0 * * * * echo hi\r\n', /carriage/);
    bad('0 * * * * echo\0hi\n', /NUL/);
    bad('-u root /bin/sh\n', /start with "-"/);
    bad('* * * * * * /bin/true\n', /more than 5 fields/);
    bad('0 0 1 * * 1 /bin/true\n', /more than 5 fields/);
    bad('mailto=x@y\n', /environment keys|not a schedule/);
    bad('MAIL-TO=x@y\n', /not a schedule/);
    bad('PATH=' + 'x'.repeat(1025) + '\n', /1024/);
    bad('just some words\n', /not a schedule/);
    bad('60 * * * * echo\n', /not a valid schedule/);
  });

  it('refuses shells outside the allowlist and accepts the allowed ones', () => {
    bad('SHELL=/bin/zsh\n', /SHELL/);
    bad('SHELL=/usr/bin/python3\n', /SHELL/);
    ok('SHELL=/bin/sh\n');
    ok('SHELL=/usr/local/bin/jailshell\n');
  });

  it('caps the table at 500 lines and 64 KiB and the command at 2000 characters', () => {
    ok(Array.from({ length: MAX_LINES }, () => '* * * * * true').join('\n') + '\n');
    bad(Array.from({ length: MAX_LINES + 1 }, () => '* * * * * true').join('\n') + '\n', /500 lines/);
    bad(`* * * * * ${'x'.repeat(2001)}\n`, /2000/);
    bad('# ' + 'y'.repeat(70000) + '\n', /bytes/);
  });
});

describe('crontab parsing', () => {
  it('splits environment lines from jobs, hashes lines into stable ids and keeps duplicates apart', () => {
    const raw = 'MAILTO=a@b.c\n# comment\n\n0 3 * * * /bin/backup\n@reboot /bin/start\n0 3 * * * /bin/backup\n';
    const parsed = parseCrontab(raw);
    expect(parsed.env).toEqual([{ key: 'MAILTO', value: 'a@b.c' }]);
    expect(parsed.jobs.map((j) => [j.schedule, j.command, j.lineNumber])).toEqual([['0 3 * * *', '/bin/backup', 4], ['@reboot', '/bin/start', 5], ['0 3 * * *', '/bin/backup', 6]]);
    expect(parsed.jobs[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.jobs[2].id).toBe(`${parsed.jobs[0].id}-2`);
    expect(parseCrontab(raw).jobs[0].id).toBe(parsed.jobs[0].id);
    expect(splitJob('  1  2 3 4 5   cmd with  spaces ')).toEqual({ schedule: '1 2 3 4 5', command: 'cmd with  spaces' });
    expect(splitJob('@weird cmd')).toBeNull();
  });
});

describe('cron ops refuse bad input before crontab runs', () => {
  it('rejects injection-shaped usernames, unknown keys and oversized content', async () => {
    exec.mockClear();
    for (const username of ['-u', 'root;id', 'Alice', '../x', '', 'a b']) {
      for (const op of ['cron.user.read', 'cron.user.remove']) expect((await opError(runOp(op, { username }, ctx))).code, `${op} ${username}`).toBe('invalid_args');
      expect((await opError(runOp('cron.user.write', { username, content: '' }, ctx))).code).toBe('invalid_args');
    }
    expect((await opError(runOp('cron.user.write', { username: 'alice', content: 'x'.repeat(65537) }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('cron.user.write', { username: 'alice', content: '', file: '/x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('cron.user.read', { username: 'alice', all: true }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses system users and reports a missing crontab binary as a capability gap', async () => {
    exec.mockClear();
    hasBinary.mockReturnValueOnce(false);
    expect((await opError(runOp('cron.user.read', { username: 'alice' }, ctx))).code).toBe('capability_missing');
    hasBinary.mockReturnValue(true);
    for (const op of ['cron.user.read', 'cron.user.remove']) expect((await opError(runOp(op, { username: 'root' }, ctx))).code, op).toBe('refused');
    expect((await opError(runOp('cron.user.write', { username: 'daemon', content: '' }, ctx))).code).toBe('refused');
    const ghost = `nouser${crypto.randomBytes(3).toString('hex')}`;
    expect((await opError(runOp('cron.user.write', { username: ghost, content: '' }, ctx))).code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
    restore();
  });

  it.skipIf(!USER)('validates the content before anything runs', async () => {
    exec.mockReset();
    exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    hasBinary.mockReturnValue(true);
    for (const content of ['-r\n', '* * * * * * true\n', 'SHELL=/bin/zsh\n', 'x\r\n']) {
      expect((await opError(runOp('cron.user.write', { username: USER, content }, ctx))).code, JSON.stringify(content)).toBe('invalid_crontab');
    }
    expect(exec).not.toHaveBeenCalled();
    restore();
  });

  it.skipIf(!USER)('passes the username after -u and the table on stdin, never as an argument', async () => {
    hasBinary.mockReturnValue(true);
    exec.mockReset();
    exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const content = 'MAILTO=a@b.c\n0 3 * * * /bin/backup';
    const r = await runOp('cron.user.write', { username: USER, content }, ctx);
    expect(exec).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = exec.mock.calls[0];
    expect(bin).toBe('crontab');
    expect(argv).toEqual(['-u', USER, '-']);
    expect(opts.input).toBe(`${content}\n`);
    expect(r).toMatchObject({ username: USER, jobs: 1, env: 1, lines: 2 });

    exec.mockReset();
    exec.mockResolvedValue({ code: 1, stdout: '', stderr: `crontab: no crontab for ${USER}` });
    expect(await runOp('cron.user.read', { username: USER }, ctx)).toEqual({ username: USER, exists: false, raw: '', env: [], jobs: [] });
    expect(exec.mock.calls[0].slice(0, 2)).toEqual(['crontab', ['-u', USER, '-l']]);

    exec.mockReset();
    exec.mockResolvedValue({ code: 1, stdout: '', stderr: `You (${USER}) are not allowed to use this program (crontab)` });
    expect((await opError(runOp('cron.user.write', { username: USER, content: '' }, ctx))).code).toBe('refused');
    expect((await opError(runOp('cron.user.remove', { username: USER }, ctx))).code).toBe('refused');
    expect(exec.mock.calls.at(-1).slice(0, 2)).toEqual(['crontab', ['-u', USER, '-r']]);

    exec.mockReset();
    exec.mockResolvedValue({ code: 0, stdout: 'PATH=/bin\n@reboot /bin/x\n', stderr: '' });
    const read = await runOp('cron.user.read', { username: USER }, ctx);
    expect(read).toMatchObject({ exists: true, env: [{ key: 'PATH', value: '/bin' }] });
    expect(read.jobs[0]).toMatchObject({ schedule: '@reboot', command: '/bin/x' });
    restore();
  });
});
