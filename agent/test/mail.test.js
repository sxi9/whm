import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exec, hasBinary } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import {
  parseEximQueue, ageToSeconds, sizeToBytes, parseMainlogLine, aggregateMainlog, summarizeMail, parseAddressTest,
  parseSpamdOptions, renderSpamdOptions, parseSpamdDefaults, renderSpamdDefaults, eximLayout, spamdLayout, greylistBackend,
  parseUpdateExim4Conf, versionAtLeast, renderManagedBlock, mergeManagedBlock, readManagedBlock, renderDkimTransportFragment, assertNoSymlinks,
} from '../src/ops/mail.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});

const ctx = createContext();
const ID = '1RfGRa-0001Zx-2u';

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('mail op schemas reject injection and traversal before anything runs', () => {
  it('unknown ops are refused', async () => {
    expect((await opError(runOp('mail.nope', {}, ctx))).code).toBe('unknown_op');
  });

  it('queue ids must be Exim message ids', async () => {
    exec.mockClear();
    for (const bad of ['-rf', 'a;b', '../x', '1RfGRa-0001Zx', '1RfGRa 0001Zx-2u', `${ID} ${ID}`, '']) {
      for (const op of ['mail.queue.remove', 'mail.queue.deliver', 'mail.queue.freeze', 'mail.queue.thaw']) {
        expect((await opError(runOp(op, { ids: [bad] }, ctx))).code, `${op} ${bad}`).toBe('invalid_args');
      }
      expect((await opError(runOp('mail.queue.message', { id: bad }, ctx))).code).toBe('invalid_args');
    }
    expect((await opError(runOp('mail.queue.remove', { ids: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.queue.remove', { ids: [ID], force: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.queue.flush', { force: 'yes' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.queue.list', { limit: 0 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('addresses, log windows and notification fields', async () => {
    exec.mockClear();
    for (const address of ['-bt', 'a@b', 'user@example.com; id', 'user@example.com -oMr x', 'a b@example.com', '"quoted"@example.com', '-C@example.com', '-oMr@example.com', '--@example.com']) {
      expect((await opError(runOp('mail.test_delivery', { address }, ctx))).code, address).toBe('invalid_args');
    }
    expect((await opError(runOp('mail.sendmail', { from: 'root@example.com', to: ['-bp'], subject: 'x', text: 'y' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.sendmail', { from: '-f', to: ['a@example.com'], subject: 'x', text: 'y' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.sendmail', { from: 'a@example.com', to: ['b@example.com'], subject: 'line1\nBcc: x', text: 'y' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.sendmail', { from: 'a@example.com', to: ['b@example.com'], subject: 'x', text: 'y', headers: { 'X Bad': 'v' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.log.report', { sinceHours: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.log.stats', { maxBytes: 10 }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('managed include names stay inside the whm directory', async () => {
    exec.mockClear();
    for (const name of ['../exim.conf', 'acl/../../x.conf', 'UPPER.conf', 'noext', 'x.sh', 'a b.conf', '-x.conf', '.hidden.conf']) {
      expect((await opError(runOp('mail.config.include.write', { name, content: '' }, ctx))).code, name).toBe('invalid_args');
      expect((await opError(runOp('mail.config.include.read', { name }, ctx))).code, name).toBe('invalid_args');
      expect((await opError(runOp('mail.config.include.remove', { name }, ctx))).code, name).toBe('invalid_args');
    }
    expect((await opError(runOp('mail.config.include.write', { name: 'ok.conf', content: 'x', mode: '0644' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.config.include.write', { name: 'ok.conf', content: 'x', sqliteDbfile: 'relative/greylist.db' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.config.include.write', { name: 'ok.conf', content: 'x', sqliteDbfile: '/var/lib/whm/../../etc/passwd' }, ctx))).code).toBe('invalid_args');
    // sqlite_dbfile is rendered into Exim's main section: pinned under /var/lib/whm and
    // free of anything that could start another option or line.
    for (const bad of ['/etc/passwd', '/var/lib/whm/greylist/greylist.db\nsystem_filter = /tmp/x', '/var/lib/whm/greylist/a b.db', '/var/lib/whm/greylist/$x.db', '/var/lib/whm/greylist/`id`.db', '/var/lib/whm/greylist/"x".db', '/var/lib/whm/./greylist.db', '/var/lib/whm', '/var/lib/whmx/greylist.db']) {
      expect((await opError(runOp('mail.config.include.write', { name: 'ok.conf', content: 'x', sqliteDbfile: bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('DKIM, spamd, greylist and mailbox arguments', async () => {
    exec.mockClear();
    expect((await opError(runOp('mail.dkim.install', { domain: 'example.com', selector: 'a b', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.dkim.install', { domain: '../etc', selector: 'default', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.dkim.install', { domain: 'example.com', selector: 'default', privateKeyPem: 'not a key' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.dkim.remove', { domain: 'example' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.spamd.config.write', { settings: { maxChildren: 'five' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.spamd.config.write', { settings: { username: 'root; id' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.spamd.config.write', { settings: { allowedIps: ['127.0.0.1 --allow-tell'] } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.spamd.config.write', { settings: { helperHomeDir: '/var/lib/../../etc' } }, ctx))).code).toBe('invalid_args');
    // helperHomeDir lands inside OPTIONS="..." of a systemd EnvironmentFile.
    for (const bad of ['/var/lib/spamassassin" LD_PRELOAD="/tmp/x.so', '/var/lib/spamassassin\nLD_PRELOAD=/tmp/x.so', '/var/lib/$HOME', '/var/lib/`id`', '/var/lib/spam assassin', '/var/lib/./spamassassin', '/var/lib/spamassassin/..', 'relative/dir', '/var/lib/spam;assassin']) {
      expect((await opError(runOp('mail.spamd.config.write', { settings: { helperHomeDir: bad } }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    }
    expect((await opError(runOp('mail.spamd.config.write', { settings: { extra: ['--rm'] } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.greylist.triplets', { q: "x' OR 1=1; --" }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.greylist.purge', { olderThanDays: -1 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.fix_perms', { username: '-R', homeDir: '/home/x' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.fix_perms', { username: 'alice', homeDir: '/home/alice/../../etc' }, ctx))).code).toBe('invalid_args');
    for (const dirs of [['../..'], ['..'], ['.'], ['mail', '..'], ['mail/..'], ['']]) {
      expect((await opError(runOp('mail.mailbox.fix_perms', { username: 'alice', homeDir: '/home/alice', dirs }, ctx))).code, JSON.stringify(dirs)).toBe('invalid_args');
    }
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', homeDir: '/home/alice', source: { format: 'pst', path: '/home/alice/a' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice; id', homeDir: '/home/alice', source: { format: 'mbox', path: '/home/alice/a' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', source: { format: 'mbox', path: '/home/alice/a' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', homeDir: 'home/alice', source: { format: 'mbox', path: '/home/alice/a' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('mail.mailbox.inspect', { homeDir: 'relative' }, ctx))).code).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('paths outside the allowed roots are refused even with valid shapes', async () => {
    exec.mockClear();
    expect((await opError(runOp('mail.mailbox.fix_perms', { username: 'root', homeDir: '/etc' }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('mail.mailbox.inspect', { homeDir: '/usr/lib' }, ctx))).code).toBe('path_not_allowed');
    // Path checks run before the doveadm capability check, so they hold with or without Dovecot.
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', homeDir: '/home/alice', source: { format: 'mbox', path: '/etc/passwd' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', homeDir: '/home/alice', source: { format: 'mbox', path: '/home/bob/mail' }, target: { format: 'maildir', path: '/home/alice/b' } }, ctx))).code).toBe('path_not_allowed');
    expect((await opError(runOp('mail.mailbox.convert', { user: 'alice', homeDir: '/home/alice', source: { format: 'mbox', path: '/home/alice/a' }, target: { format: 'maildir', path: '/home/alicex/b' } }, ctx))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('mailbox ops never follow symlinks planted by the hosting user', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-mail-'));
  const home = path.join(root, 'home', 'alice');
  const victim = path.join(root, 'victim');
  fs.mkdirSync(path.join(home, 'etc'), { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.symlinkSync(victim, path.join(home, 'mail'));
  const tmpCtx = createContext({ allowedRoots: [root] });
  afterEach(() => { exec.mockRestore(); hasBinary.mockRestore(); });

  it('assertNoSymlinks flags any symlinked component below the base', () => {
    expect(() => assertNoSymlinks(home, path.join(home, 'etc', 'new', 'deeper'))).not.toThrow();
    expect(() => assertNoSymlinks(home, home)).not.toThrow();
    expect(() => assertNoSymlinks(home, path.join(home, 'mail'))).toThrow(OpError);
    expect(() => assertNoSymlinks(home, path.join(home, 'mail', 'Maildir', 'cur'))).toThrow(/symbolic link/);
    expect(() => assertNoSymlinks(home, path.join(root, 'victim'))).toThrow(/outside/);
  });

  it('fix_perms skips a symlinked ~/mail without running chown/chmod and repairs the real ~/etc without following links', async () => {
    exec.mockImplementation(async () => ({ code: 0, stdout: 'xx', stderr: '' }));
    const r = await runOp('mail.mailbox.fix_perms', { username: 'root', homeDir: home }, tmpCtx);
    const byPath = Object.fromEntries(r.results.map((x) => [path.basename(x.path), x]));
    expect(byPath.mail).toMatchObject({ exists: true, skipped: 'symlink' });
    expect(byPath.etc).toMatchObject({ exists: true, entries: 2 });
    const argvs = exec.mock.calls.map(([bin, argv]) => [bin, ...argv]);
    expect(argvs.some((a) => a.includes(path.join(home, 'mail')) || a.includes(victim))).toBe(false);
    expect(argvs.every((a) => a[0] === 'find' && a[1] === '-P' && a[2] === path.join(home, 'etc'))).toBe(true);
    expect(argvs.find((a) => a.includes('chown'))).toEqual(['find', '-P', path.join(home, 'etc'), '-exec', 'chown', '-h', '0:0', '{}', '+']);
    expect(argvs.find((a) => a.includes('0700'))).toEqual(['find', '-P', path.join(home, 'etc'), '-type', 'd', '-exec', 'chmod', '0700', '{}', '+']);
    expect(argvs.find((a) => a.includes('0600'))).toEqual(['find', '-P', path.join(home, 'etc'), '-type', 'f', '-exec', 'chmod', '0600', '{}', '+']);
    expect(argvs.some((a) => a.includes('-R'))).toBe(false);
  });

  it('convert refuses a symlinked source or target parent before touching anything', async () => {
    const convert = (source, target) => runOp('mail.mailbox.convert', { user: 'alice', homeDir: home, source: { format: 'mbox', path: source }, target: { format: 'maildir', path: target } }, tmpCtx);
    expect((await opError(convert(path.join(home, 'mail', 'inbox'), path.join(home, 'etc', 'out')))).code).toBe('path_not_allowed');
    expect((await opError(convert(path.join(home, 'etc', 'inbox'), path.join(home, 'mail', 'Maildir')))).code).toBe('path_not_allowed');
    expect((await opError(convert(path.join(root, 'victim', 'inbox'), path.join(home, 'etc', 'out')))).code).toBe('path_not_allowed');
    expect(exec).not.toHaveBeenCalled();
    expect(fs.readdirSync(victim)).toEqual([]);
    if (!hasBinary('doveadm')) expect((await opError(convert(path.join(home, 'etc', 'inbox'), path.join(home, 'etc', 'out')))).code).toBe('capability_missing');
  });

  it('convert runs doveadm with the source as mail_location and the target as the positional location', async () => {
    fs.writeFileSync(path.join(home, 'etc', 'inbox'), 'From alice\n\nhi\n');
    hasBinary.mockImplementation((bin) => bin === 'doveadm');
    exec.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    const args = { user: 'alice', homeDir: home, source: { format: 'mbox', path: path.join(home, 'etc', 'inbox') }, target: { format: 'maildir', path: path.join(home, 'etc', 'Maildir') } };
    const expected = ['-o', `mail_location=mbox:${path.join(home, 'etc', 'inbox')}`, 'sync', '-1', '-u', 'alice', `maildir:${path.join(home, 'etc', 'Maildir')}`];
    const dry = await runOp('mail.mailbox.convert', { ...args, dryRun: true }, tmpCtx);
    expect(dry).toMatchObject({ dryRun: true, command: ['doveadm', ...expected] });
    expect(exec).not.toHaveBeenCalled();
    const real = await runOp('mail.mailbox.convert', args, tmpCtx);
    expect(exec.mock.calls[0][0]).toBe('doveadm');
    expect(exec.mock.calls[0][1]).toEqual(expected);
    expect(real).toMatchObject({ dryRun: false, source: `mbox:${path.join(home, 'etc', 'inbox')}`, target: `maildir:${path.join(home, 'etc', 'Maildir')}` });
    expect(fs.readdirSync(victim)).toEqual([]);
  });
});

describe('mail ops refuse to act when the subsystem is missing (no side effects)', () => {
  it('Exim-backed ops report capability_missing without Exim', async () => {
    if (eximLayout().installed) return;
    exec.mockClear();
    for (const [op, args] of [
      ['mail.queue.list', {}], ['mail.queue.remove', { ids: [ID] }], ['mail.queue.flush', {}], ['mail.log.report', {}], ['mail.log.stats', {}],
      ['mail.test_delivery', { address: 'a@example.com' }], ['mail.sendmail', { from: 'a@example.com', to: ['b@example.com'], subject: 's', text: 't' }],
      ['mail.config.include.write', { name: 'acl_rcpt.conf', content: '' }], ['mail.config.include.list', {}], ['mail.reload', {}],
      ['mail.dkim.install', { domain: 'example.com', selector: 'default', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----' }],
      ['mail.greylist.init', {}], ['mail.greylist.triplets', {}],
    ]) expect((await opError(runOp(op, args, ctx))).code, op).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });

  it('spamd writer needs SpamAssassin; detection and reads work anywhere', async () => {
    exec.mockClear();
    if (!spamdLayout().installed) {
      expect((await opError(runOp('mail.spamd.config.write', { settings: { maxChildren: 5 } }, ctx))).code).toBe('capability_missing');
      expect(exec).not.toHaveBeenCalled();
    }
    const detect = await runOp('mail.detect', {}, ctx);
    expect(typeof detect.installed).toBe('boolean');
    expect(detect.dovecot).toMatchObject({ installed: expect.any(Boolean) });
    const spamd = await runOp('mail.spamd.config.read', {}, ctx);
    expect(spamd).toMatchObject({ installed: expect.any(Boolean), path: expect.stringMatching(/spam/) });
    const be = await runOp('mail.greylist.backend', {}, ctx);
    expect([null, 'sqlite', 'greylistd']).toContain(be.backend);
    expect(be).toEqual(await greylistBackend());
  });
});

describe('pure parsers and renderers', () => {
  it('parses exim -bp output with frozen markers and delivered recipients', () => {
    const q = parseEximQueue(` 25m  1.2K ${ID} <sender@example.com> *** frozen ***\n          recipient@example.com\n        D other@example.org\n\n  3h   15K 1RfGRb-0001Zy-3v <>\n          postmaster@example.net\n\n`);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ id: ID, ageSeconds: 1500, sizeBytes: 1229, sender: 'sender@example.com', frozen: true });
    expect(q[0].recipients).toEqual([{ address: 'recipient@example.com', delivered: false }, { address: 'other@example.org', delivered: true }]);
    expect(q[1]).toMatchObject({ sender: '<>', frozen: false, ageSeconds: 10800, sizeBytes: 15360 });
    expect(parseEximQueue('')).toEqual([]);
    expect(ageToSeconds('2d')).toBe(172800);
    expect(ageToSeconds('bogus')).toBeNull();
    expect(sizeToBytes('2.5M')).toBe(2621440);
  });

  it('parses mainlog lines, groups per message and summarises', () => {
    const arrival = parseMainlogLine(`2026-10-25 10:00:00 ${ID} <= alice@example.com H=(client) [203.0.113.5] P=esmtpsa A=dovecot_login:alice@example.com S=2048 T="Hello \\"world\\"" from <alice@example.com> for bob@example.org`);
    expect(arrival).toMatchObject({ id: ID, event: '<=', address: 'alice@example.com', fields: { P: 'esmtpsa', A: 'dovecot_login:alice@example.com', S: '2048', T: 'Hello "world"' } });
    expect(arrival.fields.H).toBe('(client) [203.0.113.5]');
    const failure = parseMainlogLine(`2026-10-25 10:00:01 ${ID} ** carol@nowhere.invalid R=dnslookup T=remote_smtp: all relevant MX records point to non-existent hosts`);
    expect(failure).toMatchObject({ event: '**', address: 'carol@nowhere.invalid', fields: { R: 'dnslookup', T: 'remote_smtp' } });
    expect(parseMainlogLine('2026-10-25 10:05:00 H=(spam.example) [192.0.2.7] F=<x@y.z> rejected RCPT <u@example.com>: relay not permitted').event).toBe('rejected');
    expect(parseMainlogLine('garbage')).toBeNull();
    const { messages, rejects } = aggregateMainlog([
      arrival.raw,
      `2026-10-25 10:00:01 ${ID} => bob@example.org R=dnslookup T=remote_smtp H=mx.example.org [198.51.100.9] C="250 OK id=xyz"`,
      failure.raw,
      `2026-10-25 10:00:02 ${ID} == dave@slow.example R=dnslookup T=remote_smtp defer (-44): SMTP error from remote mail server after RCPT TO: 450 try later`,
      `2026-10-25 10:00:03 ${ID} Completed`,
      '2026-10-25 10:05:00 H=(spam.example) [192.0.2.7] F=<x@y.z> rejected RCPT <u@example.com>: relay not permitted',
      '2026-10-25 10:06:00 1RfGRc-0001Zz-4w <= www-data@host U=www-data P=local S=100',
      '2026-10-25 10:06:01 1RfGRc-0001Zz-4w => root@host R=localuser T=local_delivery',
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: ID, sender: 'alice@example.com', authUser: 'alice@example.com', size: 2048, subject: 'Hello "world"', completedAt: '2026-10-25 10:00:03' });
    expect(messages[0].recipients.map((r) => [r.address, r.status])).toEqual([['bob@example.org', 'delivered'], ['carol@nowhere.invalid', 'failed'], ['dave@slow.example', 'deferred']]);
    expect(messages[0].recipients[0]).toMatchObject({ host: 'mx.example.org [198.51.100.9]', detail: '250 OK id=xyz' });
    expect(messages[1]).toMatchObject({ authUser: 'local:www-data', protocol: 'local' });
    expect(rejects).toEqual([{ ts: '2026-10-25 10:05:00', host: '(spam.example) [192.0.2.7]', sender: '<x@y.z>', text: expect.stringContaining('relay not permitted') }]);
    const summary = summarizeMail(messages, rejects);
    expect(summary.totals).toEqual({ messages: 2, received: 2, delivered: 2, failed: 1, deferred: 1, rejected: 1, bytes: 2148, authenticated: 2 });
    expect(summary.relayers).toEqual([expect.objectContaining({ user: 'alice@example.com', mechanism: 'dovecot_login', messages: 1, recipients: 3, delivered: 1, failed: 1, deferred: 1, senders: ['alice@example.com'] }), expect.objectContaining({ user: 'local:www-data' })]);
    expect(summary.senders[0]).toMatchObject({ sender: 'alice@example.com', authenticated: true, hosts: ['(client) [203.0.113.5]'] });
    expect(summary.byHour).toEqual([{ hour: '2026-10-25 10', received: 2, delivered: 2, failed: 1, deferred: 1 }]);
    expect(summary.topDomains[0]).toEqual({ domain: 'example.org', delivered: 1, failed: 0, deferred: 0 });
    expect(aggregateMainlog([arrival.raw], { sinceMs: Date.parse('2030-01-01') }).messages).toEqual([]);
  });

  it('reads Debian split-config mode, compares Exim versions and merges the managed main block', () => {
    expect(parseUpdateExim4Conf("# comment\ndc_eximconfig_configtype='internet'\ndc_use_split_config='false'\ndc_other_hostnames=\"a;b\"\n")).toEqual({ dc_eximconfig_configtype: 'internet', dc_use_split_config: 'false', dc_other_hostnames: 'a;b' });
    expect(parseUpdateExim4Conf(null)).toEqual({});
    expect(versionAtLeast('4.97', [4, 94])).toBe(true);
    expect(versionAtLeast('4.94.2', [4, 94])).toBe(true);
    expect(versionAtLeast('4.92', [4, 94])).toBe(false);
    expect(versionAtLeast('5.0', [4, 94])).toBe(true);
    expect(versionAtLeast(null, [4, 94])).toBe(false);
    const layout = { includeMode: 'debian-macro', aclFile: '/etc/exim4/whm/acl_rcpt.conf', localDomainsFile: '/etc/exim4/whm/local_domains.lst', relayDomainsFile: '/etc/exim4/whm/relay_domains.lst', otherHostnames: ['host.example.com'], debianRelayDomains: ['backup.example.net'], dkimDir: '/etc/exim4/whm/dkim', confDir: '/etc/exim4' };
    const block = renderManagedBlock(layout, { sqliteDbfile: '/var/lib/whm/greylist/greylist.db' });
    expect(block).toContain('CHECK_RCPT_LOCAL_ACL_FILE = /etc/exim4/whm/acl_rcpt.conf\nsqlite_dbfile = /var/lib/whm/greylist/greylist.db');
    expect(block).not.toMatch(/MAIN_LOCAL_DOMAINS|DKIM_/);
    expect(renderManagedBlock(layout)).not.toContain('sqlite_dbfile');
    expect(readManagedBlock(`X = 1\n${block}\nY = 2\n`)).toEqual({ present: true, sqliteDbfile: '/var/lib/whm/greylist/greylist.db' });
    expect(readManagedBlock('X = 1\n')).toEqual({ present: false, sqliteDbfile: null });
    // Email Routing lists override Debian's dc_other_hostnames / dc_relay_domains, so those are merged in.
    const full = renderManagedBlock(layout, { domainLists: true, dkim: true });
    expect(full).toContain('.ifndef MAIN_LOCAL_DOMAINS\nMAIN_LOCAL_DOMAINS = @:localhost:host.example.com:/etc/exim4/whm/local_domains.lst\n.endif');
    expect(full).toContain('MAIN_RELAY_TO_DOMAINS = backup.example.net:/etc/exim4/whm/relay_domains.lst');
    // DKIM: the stock Debian remote_smtp transport signs when these macros exist; the key path is de-tainted through dsearch.
    expect(full).toContain('.ifndef DKIM_PRIVATE_KEY\nDKIM_DOMAIN = ${lc:${domain:$h_from:}}');
    expect(full).toContain('DKIM_SELECTOR = ${lookup{${lc:${domain:$h_from:}}}lsearch{/etc/exim4/whm/dkim/selectors.lst}{$value}{default}}');
    expect(full).toContain('DKIM_PRIVATE_KEY = ${lookup{${lc:${domain:$h_from:}}.key}dsearch{/etc/exim4/whm/dkim}{/etc/exim4/whm/dkim/$value}{0}}\nDKIM_CANON = relaxed\n.endif');
    const rhel = { includeMode: 'manual', aclFile: '/etc/exim/whm/acl_rcpt.conf', localDomainsFile: '/etc/exim/whm/local_domains.lst', relayDomainsFile: '/etc/exim/whm/relay_domains.lst', dkimDir: '/etc/exim/whm/dkim', confDir: '/etc/exim' };
    const main = renderManagedBlock(rhel, { sqliteDbfile: '/var/lib/whm/greylist/greylist.db', domainLists: true, dkim: true });
    expect(main).not.toMatch(/CHECK_RCPT_LOCAL_ACL_FILE|DKIM_/);
    expect(main).toContain('domainlist local_domains = @ : localhost : /etc/exim/whm/local_domains.lst\ndomainlist relay_to_domains = /etc/exim/whm/relay_domains.lst');
    expect(renderDkimTransportFragment(rhel)).toContain('dkim_private_key = ${lookup{${lc:${domain:$h_from:}}.key}dsearch{/etc/exim/whm/dkim}{/etc/exim/whm/dkim/$value}{0}}');
    const merged = mergeManagedBlock('MAIN_TLS_ENABLE = yes\n', block);
    expect(merged.startsWith('MAIN_TLS_ENABLE = yes\n\n# BEGIN WHM panel')).toBe(true);
    expect(merged.endsWith('# END WHM panel (Email filters)\n')).toBe(true);
    const replaced = mergeManagedBlock(`${merged}LOCAL_AFTER = 1\n`, renderManagedBlock(layout));
    expect(replaced).toBe(`MAIN_TLS_ENABLE = yes\n\n${renderManagedBlock(layout)}\nLOCAL_AFTER = 1\n`);
    expect(replaced.match(/BEGIN WHM panel/g)).toHaveLength(1);
    expect(mergeManagedBlock(null, block)).toBe(`${block}\n`);
  });

  it('parses exim -bt output', () => {
    expect(parseAddressTest('bob@example.org\n  router = dnslookup, transport = remote_smtp\n  host mx.example.org [198.51.100.9] MX=10\n')).toEqual([{ address: 'bob@example.org', target: null, router: 'dnslookup', transport: 'remote_smtp' }]);
    expect(parseAddressTest('nobody@example.org is undeliverable: Unrouteable address')[0].error).toMatch(/Unrouteable/);
  });

  it('round-trips spamd options and the defaults file', () => {
    const parsed = parseSpamdOptions('--create-prefs --max-children 5 --helper-home-dir /var/lib/spamassassin -i 127.0.0.1:783 --allowed-ips=127.0.0.1,::1 -u debian-spamd --nice=10 --unknown-flag');
    expect(parsed).toMatchObject({ createPrefs: true, maxChildren: 5, helperHomeDir: '/var/lib/spamassassin', listenIp: '127.0.0.1', port: 783, allowedIps: ['127.0.0.1', '::1'], username: 'debian-spamd', nice: 10, extra: ['--unknown-flag'] });
    const rendered = renderSpamdOptions(parsed);
    expect(rendered).toBe('--max-children=5 --listen=127.0.0.1:783 --allowed-ips=127.0.0.1,::1 --username=debian-spamd --nice=10 --create-prefs --helper-home-dir=/var/lib/spamassassin --unknown-flag');
    expect(parseSpamdOptions(rendered)).toEqual(parsed);
    const defaults = parseSpamdDefaults('# comment\nENABLED=1\nOPTIONS="--create-prefs --max-children 5"\nCRON=0\nNICE="--nicelevel 15"\n');
    expect(defaults).toEqual({ enabled: true, cron: false, options: '--create-prefs --max-children 5', other: ['NICE="--nicelevel 15"'] });
    const text = renderSpamdDefaults({ flavor: 'debian', enabled: false, cron: true, options: '--max-children=3', other: defaults.other });
    expect(text).toContain('ENABLED=0\nOPTIONS="--max-children=3"\nCRON=1\nNICE="--nicelevel 15"\n');
    expect(parseSpamdDefaults(text)).toEqual({ enabled: false, cron: true, options: '--max-children=3', other: ['NICE="--nicelevel 15"'] });
    expect(renderSpamdDefaults({ flavor: 'rhel', options: '-d -c -m5', other: [] })).toContain('SPAMDOPTIONS="-d -c -m5"');
    expect(parseSpamdDefaults('SPAMDOPTIONS="-d -c -m5"').options).toBe('-d -c -m5');
  });
});
