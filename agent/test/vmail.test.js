import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import {
  renderPasswdLine, parsePasswdLine, upsertPasswdText, removeFromPasswdText, dropForeignPasswdLines, renderAliases, renderDomainForwards,
  renderSpamUsers, renderAutoresponderConf, autoreplyOnceFiles, parseDoveadmQuota, LOCAL_PART, EMAIL_TARGET, HOME_FIELD, MANAGED,
  AUTORESPONDER_KEYS, DOVECOT_PASSWD_DIR, AUTOREPLY_DB_DIR,
} from '../src/ops/vmail.js';
import { SHADOW_HASH } from '../src/ops/transfer.js';
import { renderEximVirtualRouters, renderEximVirtualTransports, renderEximSpamAcl, VMAIL_NAMES } from '../../server/src/services/service-configuration.js';

// exec/hasBinary are spied so a test can prove that a refused op never ran a
// program. No file under /etc/dovecot or /etc/exim4 is ever written: every op
// with a side effect is only ever reached with arguments its schema refuses.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec, hasBinary } = await import('../src/exec.js');

const ctx = createContext();
const HASH = '$6$zbsfcWrdKw0VR0wa$A0rw1A7d4PBa2YN/z1nATzFjoYngcI/Kpt3Ih5IWolea1/ANnjhx8YxtNUdCS5bDEjG80Yb.rvLa4CkZj2/pR1';

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

async function invalid(name, args) {
  exec.mockClear();
  const err = await opError(runOp(name, args, ctx));
  expect(err.code, `${name} ${JSON.stringify(args)}`).toBe('invalid_args');
  expect(exec).not.toHaveBeenCalled();
  return err;
}

describe('vmail op catalog', () => {
  it('registers the family with the destructive flags of the design', () => {
    const ops = ['vmail.hash', 'vmail.passwd.set', 'vmail.passwd.remove', 'vmail.passwd.purge', 'vmail.passwd.list', 'vmail.quota.get', 'vmail.aliases.write', 'vmail.aliases.remove', 'vmail.domainfwd.write', 'vmail.autoresponder.write', 'vmail.autoresponder.remove', 'vmail.spam_users.write', 'vmail.render.check'];
    for (const name of ops) expect(catalog.has(name), name).toBe(true);
    for (const name of ['vmail.passwd.remove', 'vmail.passwd.purge', 'vmail.aliases.remove', 'vmail.autoresponder.remove']) expect(catalog.get(name).destructive, name).toBe(true);
    for (const name of ops.filter((n) => !n.endsWith('.remove') && !n.endsWith('.purge'))) expect(catalog.get(name).destructive, name).toBe(false);
    expect(catalog.get('vmail.render.check').timeoutMs).toBe(120_000);
  });

  it('every schema is strict (option smuggling is refused)', async () => {
    await invalid('vmail.hash', { password: 'x', extra: 1 });
    await invalid('vmail.passwd.set', { domain: 'alice.com', localPart: 'info', hash: HASH, username: 'alice', quotaBytes: null, uid: 0 });
    await invalid('vmail.passwd.set', { domain: 'alice.com', localPart: 'info', hash: HASH, username: 'alice', quotaBytes: null, home: '/root' });
    await invalid('vmail.aliases.write', { domain: 'alice.com', entries: [], reload: true });
    await invalid('vmail.render.check', { verbose: true });
    await invalid('vmail.quota.get', { user: 'a@alice.com', force: true });
  });
});

describe('vmail.hash', () => {
  it('rejects passwords with newlines, NUL, empty or over 256 chars', async () => {
    for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(257), 42]) await invalid('vmail.hash', { password: bad });
  });

  it('hands the password to openssl on stdin only and returns a $6$ hash', async () => {
    if (!hasBinary('openssl')) return;
    exec.mockClear();
    const r = await runOp('vmail.hash', { password: '-S3cret pass "with" $tuff' }, ctx);
    expect(r.hash).toMatch(SHADOW_HASH);
    expect(r.hash.startsWith('$6$')).toBe(true);
    expect(r.scheme).toBe('SHA512-CRYPT');
    const call = exec.mock.calls.find((c) => c[0] === 'openssl');
    expect(call[1]).toEqual(['passwd', '-6', '-stdin']);
    expect(call[1].join(' ')).not.toContain('S3cret');
    expect(call[2].input).toBe('-S3cret pass "with" $tuff\n');
  });

  it('reports capability_missing when neither openssl nor mkpasswd exists', async () => {
    hasBinary.mockImplementation(() => false);
    try {
      exec.mockClear();
      const err = await opError(runOp('vmail.hash', { password: 'x' }, ctx));
      expect(err.code).toBe('capability_missing');
      expect(exec).not.toHaveBeenCalled();
    } finally { hasBinary.mockRestore(); hasBinary.mockImplementation((await vi.importActual('../src/exec.js')).hasBinary); }
  });
});

describe('vmail.passwd.* schemas', () => {
  const good = { domain: 'alice.com', localPart: 'info', hash: HASH, username: 'alice', quotaBytes: 1048576 };

  it('rejects local parts that would break the passwd line or the maildir path', async () => {
    for (const bad of ['', 'Info', '.hidden', '-x', 'a:b', 'a b', 'a/b', 'a\nb', '../x', 'a${b}', 'x'.repeat(65), '*']) await invalid('vmail.passwd.set', { ...good, localPart: bad });
    for (const bad of ['Info', 'a:b', '*']) await invalid('vmail.passwd.remove', { domain: 'alice.com', localPart: bad });
    for (const bad of ['alice', 'alice.com/..', 'ALICE.COM', '']) await invalid('vmail.passwd.purge', { domain: bad });
    await invalid('vmail.passwd.purge', { domain: 'alice.com', localPart: 'x' });
  });

  it('purge never executes a program and refuses outside Dovecot', async () => {
    exec.mockClear();
    const err = await opError(runOp('vmail.passwd.purge', { domain: 'alice.com' }, ctx));
    expect(['capability_missing', 'path_not_allowed']).toContain(err.code);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects hashes that are not crypt(3) or carry a field separator', async () => {
    for (const bad of ['plain', '$6$', '$6$abc$x:y', `${HASH}\nroot::0:0`, '$2b$10$' + 'x'.repeat(53) + ':', 'x'.repeat(600), '']) await invalid('vmail.passwd.set', { ...good, hash: bad });
  });

  it('rejects system or malformed usernames and foreign domains', async () => {
    for (const bad of ['root', '-root', 'Admin', 'a;b', '', 'alice bob']) {
      if (bad === 'root') {
        exec.mockClear();
        const err = await opError(runOp('vmail.passwd.set', { ...good, username: bad }, ctx));
        expect(['refused', 'capability_missing', 'path_not_allowed']).toContain(err.code);
        expect(exec).not.toHaveBeenCalled();
      } else await invalid('vmail.passwd.set', { ...good, username: bad });
    }
    for (const bad of ['alice', 'alice.com:x', 'ALICE.COM', '-alice.com', 'a b.com', 'alice.com\n']) await invalid('vmail.passwd.set', { ...good, domain: bad });
    for (const bad of [-1, 1.5, 'x']) await invalid('vmail.passwd.set', { ...good, quotaBytes: bad });
  });

  it('never executes a program for a passwd write (file ops only) and refuses outside Dovecot', async () => {
    exec.mockClear();
    const err = await opError(runOp('vmail.passwd.set', good, ctx));
    expect(['capability_missing', 'refused', 'not_found', 'path_not_allowed']).toContain(err.code);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('passwd line rendering', () => {
  const base = { localPart: 'info', hash: HASH, uid: 1001, gid: 1001, home: '/home/alice', domain: 'alice.com' };

  it('renders the Dovecot passwd-file line with maildir, quota and nologin fields', () => {
    const line = renderPasswdLine({ ...base, quotaBytes: 2048, disabled: true });
    expect(line).toBe(`info:{SHA512-CRYPT}${HASH}:1001:1001::/home/alice::userdb_mail=maildir:~/mail/alice.com/info userdb_quota_rule=*:bytes=2048 nologin=y`);
    expect(renderPasswdLine({ ...base, quotaBytes: null })).not.toContain('quota_rule');
    expect(renderPasswdLine({ ...base, quotaBytes: 0 })).not.toContain('quota_rule');
    expect(parsePasswdLine(line)).toEqual({ localPart: 'info', uid: 1001, gid: 1001, home: '/home/alice', quotaBytes: 2048, disabled: true });
  });

  it('refuses every field that could become a second field, line or expansion', () => {
    for (const home of ['/home/al ice', '/home/alice:x', '/home/alice\n', 'home/alice', '/home/../etc', '/home/a$b', '/home/alice/${HOME}']) expect(() => renderPasswdLine({ ...base, home }), home).toThrow(OpError);
    for (const h of ['x', `${HASH}:0`, `${HASH}\n`]) expect(() => renderPasswdLine({ ...base, hash: h })).toThrow(OpError);
    for (const local of ['In fo', 'a:b', 'a\nb']) expect(() => renderPasswdLine({ ...base, localPart: local })).toThrow(OpError);
    expect(() => renderPasswdLine({ ...base, uid: -1 })).toThrow(OpError);
    expect(() => renderPasswdLine({ ...base, uid: '1001' })).toThrow(OpError);
    expect(HOME_FIELD.test('/home/alice')).toBe(true);
    expect(HOME_FIELD.test('/home/alice/')).toBe(false);
  });

  it('upserts and removes by local part without touching other lines', () => {
    const a = renderPasswdLine({ ...base, localPart: 'a' });
    const b = renderPasswdLine({ ...base, localPart: 'b' });
    const text = upsertPasswdText(upsertPasswdText(null, 'a', a), 'b', b);
    expect(text.split('\n').filter(Boolean)).toEqual([MANAGED, a, b]);
    const a2 = renderPasswdLine({ ...base, localPart: 'a', disabled: true });
    const replaced = upsertPasswdText(text, 'a', a2);
    expect(replaced.split('\n').filter(Boolean)).toEqual([MANAGED, a2, b]);
    const r = removeFromPasswdText(replaced, 'a');
    expect(r).toMatchObject({ removed: true, empty: false });
    expect(r.text.split('\n').filter(Boolean)).toEqual([MANAGED, b]);
    expect(removeFromPasswdText(r.text, 'b')).toMatchObject({ removed: true, empty: true, text: '' });
    expect(removeFromPasswdText(r.text, 'zz')).toMatchObject({ removed: false, empty: false });
  });

  it('drops every line that carries another account\'s uid before a new line is added (stale previous owner)', () => {
    const mine = renderPasswdLine({ ...base, localPart: 'info' });
    const foreign = renderPasswdLine({ ...base, localPart: 'ceo', uid: 1002, gid: 1002, home: '/home/mallory' });
    const foreignGid = renderPasswdLine({ ...base, localPart: 'cfo', uid: 1003 });
    const text = `${MANAGED}\n${foreign}\n${mine}\n${foreignGid}\n`;
    const r = dropForeignPasswdLines(text, 1001);
    expect(r.purged).toEqual([{ localPart: 'ceo', uid: 1002 }, { localPart: 'cfo', uid: 1003 }]);
    expect(r.text.split('\n').filter(Boolean)).toEqual([MANAGED, mine]);
    const next = upsertPasswdText(r.text, 'sales', renderPasswdLine({ ...base, localPart: 'sales' }));
    expect(next.split('\n').filter(Boolean).map((l) => (l.startsWith('#') ? l : l.split(':')[0]))).toEqual([MANAGED, 'info', 'sales']);
    expect(next.split('\n').filter((l) => l && !l.startsWith('#')).every((l) => parsePasswdLine(l).uid === 1001)).toBe(true);
    expect(dropForeignPasswdLines(null, 1001)).toEqual({ text: '', purged: [] });
    expect(dropForeignPasswdLines(`${MANAGED}\ngarbage-line\n`, 1001).purged).toEqual([{ localPart: 'garbage-line', uid: null }]);
    expect(dropForeignPasswdLines(text, 1002).text.split('\n').filter(Boolean)).toEqual([MANAGED, foreign]);
  });
});

describe('vmail.aliases.write', () => {
  const good = (targets, localPart = 'info') => ({ domain: 'alice.com', entries: [{ localPart, targets }] });

  it('refuses pipes, files, includes, expansions and option-shaped targets', async () => {
    for (const bad of ['|/usr/bin/vacation', '/home/alice/mail/x', ':include:/etc/passwd', '${run{/bin/sh}}', 'a@b.com, |cmd', 'a@b.com\nroot: x', ':defer:', ':fail', '-a@b.com', 'a b@c.com', 'a@b', '', 'a@b.com;x', 'user@local', 'a@-b.com']) {
      await invalid('vmail.aliases.write', good([bad]));
    }
    await invalid('vmail.aliases.write', good([]));
    await invalid('vmail.aliases.write', good(Array.from({ length: 51 }, (_, i) => `u${i}@b.com`)));
    for (const key of ['Info', 'a b', 'a:b', '**', '../x', '']) await invalid('vmail.aliases.write', good(['a@b.com'], key));
    await invalid('vmail.aliases.write', { domain: 'alice.com', entries: [{ localPart: 'a', targets: ['a@b.com'], pipe: '|x' }] });
    await invalid('vmail.aliases.write', { domain: 'alice.com/..', entries: [] });
  });

  it('accepts addresses, catch-all, :fail: and :blackhole:', () => {
    for (const ok of ['a@b.com', 'first.last+tag@sub.example.org', ':fail:', ':blackhole:', 'Upper.Case@Example.COM']) expect(ok === ':fail:' || ok === ':blackhole:' || EMAIL_TARGET.test(ok), ok).toBe(true);
    const text = renderAliases('alice.com', [{ localPart: 'info', targets: ['A@b.com', 'c@d.org'] }, { localPart: '*', targets: [':fail:'] }, { localPart: 'void', targets: [':blackhole:'] }]);
    expect(text.split('\n').filter((l) => !l.startsWith('#')).filter(Boolean)).toEqual(['info: a@b.com, c@d.org', '*: :fail: no such address here', 'void: :blackhole:']);
  });

  it('render refuses duplicates, mixed special targets and anything the schema would not', () => {
    expect(() => renderAliases('alice.com', [{ localPart: 'a', targets: ['x@y.com'] }, { localPart: 'a', targets: ['z@y.com'] }])).toThrow(/twice/);
    expect(() => renderAliases('alice.com', [{ localPart: 'a', targets: [':fail:', 'x@y.com'] }])).toThrow(/combined/);
    expect(() => renderAliases('alice.com', [{ localPart: 'a', targets: ['|/bin/sh'] }])).toThrow(OpError);
    expect(() => renderAliases('alice.com', [{ localPart: 'a b', targets: ['x@y.com'] }])).toThrow(OpError);
  });
});

describe('vmail.domainfwd.write / vmail.spam_users.write', () => {
  it('validates every list entry and the rendered line shape', async () => {
    await invalid('vmail.domainfwd.write', { entries: [{ domain: 'alice.com', target: 'bob.com: x' }] });
    await invalid('vmail.domainfwd.write', { entries: [{ domain: 'alice.com', target: 'bob.com', extra: 1 }] });
    await invalid('vmail.domainfwd.write', { entries: [{ domain: 'alice.com' }] });
    expect(renderDomainForwards([{ domain: 'alice.com', target: 'bob.com' }])).toContain('\nalice.com: bob.com\n');
    expect(() => renderDomainForwards([{ domain: 'alice.com', target: 'alice.com' }])).toThrow(/itself/);
    expect(() => renderDomainForwards([{ domain: 'alice.com', target: 'bob.com' }, { domain: 'alice.com', target: 'c.com' }])).toThrow(/twice/);

    const entry = { domain: 'alice.com', username: 'alice', enabled: true, threshold: 50, autoDelete: false };
    for (const bad of [{ ...entry, threshold: 5 }, { ...entry, threshold: 201 }, { ...entry, threshold: 5.5 }, { ...entry, username: 'root x' }, { ...entry, username: '-alice' }, { ...entry, enabled: 'yes' }, { ...entry, domain: 'alice.com\nx' }, { ...entry, cmd: 'x' }]) {
      await invalid('vmail.spam_users.write', { entries: [bad] });
    }
    expect(renderSpamUsers([entry, { ...entry, domain: 'shop.alice.com', enabled: false, autoDelete: true, threshold: 80 }]).split('\n').filter((l) => l && !l.startsWith('#')))
      .toEqual(['alice.com: user=alice enabled=1 threshold=50 autodelete=0', 'shop.alice.com: user=alice enabled=0 threshold=80 autodelete=1']);
    expect(() => renderSpamUsers([entry, entry])).toThrow(/twice/);
  });
});

describe('vmail.autoresponder.*', () => {
  const good = { domain: 'alice.com', localPart: 'info', fromName: 'Alice', subject: 'Out of office', body: 'Back next week.\n', charset: 'utf-8', intervalHours: 24 };

  it('subject and fromName are single lines; charset, interval and dates are bounded', async () => {
    for (const bad of ['Out\nof office', 'Out\rof office', 'x'.repeat(256), '', 'a\0b']) await invalid('vmail.autoresponder.write', { ...good, subject: bad });
    for (const bad of ['Alice\nBcc: x', 'x'.repeat(129)]) await invalid('vmail.autoresponder.write', { ...good, fromName: bad });
    for (const bad of ['utf 8', 'utf-8\n', '', 'x'.repeat(33), 'utf-8; q=1']) await invalid('vmail.autoresponder.write', { ...good, charset: bad });
    for (const bad of [-1, 721, 1.5, '24']) await invalid('vmail.autoresponder.write', { ...good, intervalHours: bad });
    for (const bad of ['tomorrow', '2026-13-01T00:00:00Z', 1700000000]) await invalid('vmail.autoresponder.write', { ...good, startAt: bad });
    await invalid('vmail.autoresponder.write', { ...good, body: 'x'.repeat(64 * 1024 + 1) });
    await invalid('vmail.autoresponder.write', { ...good, localPart: 'Info' });
    await invalid('vmail.autoresponder.write', { ...good, once: '/tmp/x' });
    await invalid('vmail.autoresponder.remove', { domain: 'alice.com', localPart: '../info' });
  });

  it('renders the lsearch headers the whm_autoreply fragment reads (hours, epochs, enabled 0|1; empty keys left out)', async () => {
    const text = renderAutoresponderConf({ fromName: 'Alice', subject: 'Away', charset: 'utf-8', intervalHours: 2, startAt: '2026-01-01T00:00:00Z', stopAt: null });
    expect(text.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['from: Alice', 'subject: Away', 'charset: utf-8', 'interval: 2', 'start: 1767225600', 'enabled: 1']);
    const bare = renderAutoresponderConf({ fromName: '', subject: 'Away', charset: 'utf-8', intervalHours: 0, enabled: false, stopAt: '2026-02-01T00:00:00Z' });
    expect(bare.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['subject: Away', 'charset: utf-8', 'interval: 0', 'stop: 1769904000', 'enabled: 0']);
    for (const line of [...text.split('\n'), ...bare.split('\n')].filter((l) => l && !l.startsWith('#'))) expect(AUTORESPONDER_KEYS).toContain(line.split(':')[0]);
    expect(() => renderAutoresponderConf({ fromName: 'A\nB', subject: 'x', charset: 'utf-8', intervalHours: 1 })).toThrow(OpError);
    expect(() => renderAutoresponderConf({ fromName: 'A', subject: 'x', charset: 'utf-8', intervalHours: 1, startAt: 'nope' })).toThrow(OpError);
    expect(autoreplyOnceFiles('alice.com', 'info')[0]).toBe(`${AUTOREPLY_DB_DIR}/info@alice.com.db`);
    await invalid('vmail.autoresponder.write', { ...good, enabled: 'yes' });
  });
});

// The files vmail.* write are read by the Exim fragments service-configuration
// renders (seam S4). The renderer is the source of truth for names and keys;
// this keeps the two from drifting apart silently.
describe('parity with service-configuration\'s virtual-mail fragments', () => {
  const layout = { whmDir: '/etc/exim4/whm', vmail: { passwdDir: DOVECOT_PASSWD_DIR, aliasesDir: '/etc/exim4/whm/aliases', domainForward: '/etc/exim4/whm/domainfwd.lst', autorespondersDir: '/etc/exim4/whm/autoresponders', spamUsers: '/etc/exim4/whm/spam_users.lst', autoreplyOnceDir: AUTOREPLY_DB_DIR, dovecotBaseDir: '/var/run/dovecot' } };
  const routers = renderEximVirtualRouters(layout);
  const transports = renderEximVirtualTransports(layout);
  const acl = renderEximSpamAcl(layout).join('\n');

  it('autoresponder: body is <dir>/<domain>/<local>, headers <local>.conf with the keys the fragment looks up, once-db flat <local>@<domain>.db', () => {
    const dir = layout.vmail.autorespondersDir;
    expect(transports).toContain(`file = ${dir}/$domain_data/$local_part_data\n`);
    expect(routers).toContain(`local_parts = \${if exists{${dir}/$domain_data}{dsearch;${dir}/$domain_data}{}}`);
    expect(transports).not.toContain('.txt');
    const conf = `${dir}/$domain_data/$local_part_data.conf`;
    const looked = new Set([...`${routers}\n${transports}`.matchAll(/\$\{lookup\{(\w+)\}lsearch\{([^}]+)\}/g)].filter((m) => m[2] === conf).map((m) => m[1]));
    expect([...looked].sort()).toEqual(['charset', 'enabled', 'from', 'interval', 'start', 'stop', 'subject']);
    for (const key of looked) expect(AUTORESPONDER_KEYS, key).toContain(key);
    expect(routers).toMatch(/lookup\{enabled\}lsearch\{[^}]+\}\{\$value\}\{1\}\}\}\{0\}/);
    expect(transports).toMatch(/once_repeat = \$\{lookup\{interval\}lsearch\{[^}]+\}\{\$\{if eq\{\$value\}\{0\}\{1s\}\{\$\{value\}h\}\}\}/);
    const once = transports.match(/once = (\S+)/)[1];
    expect(once).toBe(`${AUTOREPLY_DB_DIR}/$local_part_data@$domain_data.db`);
    expect(autoreplyOnceFiles('alice.com', 'info')[0]).toBe(once.replace('$local_part_data', 'info').replace('$domain_data', 'alice.com'));
    const rendered = renderAutoresponderConf({ fromName: 'A', subject: 's', charset: 'utf-8', intervalHours: 3, startAt: '2026-01-01T00:00:00Z', stopAt: '2026-02-01T00:00:00Z' });
    expect(rendered.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(':')[0]).sort()).toEqual([...looked].sort());
  });

  it('spam_users.lst: the DATA ACL extracts user/enabled/threshold/autodelete and compares the flags to 1', () => {
    expect(acl).toContain(`lsearch{${layout.vmail.spamUsers}}`);
    const extracted = new Set([...acl.matchAll(/extract\{(\w+)\}\{\$acl_m_whm_spam\}/g)].map((m) => m[1]));
    expect([...extracted].sort()).toEqual(['autodelete', 'enabled', 'threshold', 'user']);
    expect(acl).toContain('${if eq{${extract{enabled}{$acl_m_whm_spam}}}{1}}');
    expect(acl).toContain('${if eq{${extract{autodelete}{$acl_m_whm_spam}}}{1}}');
    const line = renderSpamUsers([{ domain: 'alice.com', username: 'alice', enabled: true, threshold: 45, autoDelete: true }]).split('\n').find((l) => l.startsWith('alice.com: '));
    const pairs = Object.fromEntries(line.slice('alice.com: '.length).split(' ').map((kv) => kv.split('=')));
    expect(Object.keys(pairs).sort()).toEqual([...extracted].sort());
    expect(pairs).toEqual({ user: 'alice', enabled: '1', threshold: '45', autodelete: '1' });
  });

  it('passwd, aliases and domainfwd files are where the routers look', () => {
    expect(routers).toContain(`dsearch;${DOVECOT_PASSWD_DIR}}`);
    expect(routers).toContain(`lsearch;${DOVECOT_PASSWD_DIR}/$domain_data}`);
    expect(routers).toContain(`lsearch;${layout.vmail.domainForward}}`);
    expect(routers).toContain(`lsearch;${layout.vmail.aliasesDir}/$domain_data}`);
    expect(routers).toContain(`lookup{*}lsearch{${layout.vmail.aliasesDir}/$domain_data}`);
    expect(routers).toContain(`${VMAIL_NAMES.router}:`);
    expect(transports).toContain(`${VMAIL_NAMES.transport}:`);
    expect(renderAliases('alice.com', [{ localPart: '*', targets: [':fail:'] }])).toMatch(/^\*: :fail:/m);
    expect(renderDomainForwards([{ domain: 'alice.com', target: 'b.com' }])).toMatch(/^alice\.com: b\.com$/m);
  });
});

describe('vmail.quota.get', () => {
  it('only accepts a plain mailbox address (no option-shaped or expansion input)', async () => {
    for (const bad of ['-u', '--all', 'a@b', 'Info@alice.com', 'a b@c.com', 'a@c.com\n', '${lookup}@c.com', '']) await invalid('vmail.quota.get', { user: bad });
  });

  it('parses doveadm quota output (STORAGE in kilobytes)', () => {
    const out = parseDoveadmQuota('Quota name Type    Value Limit  %\nUser quota STORAGE 2048  102400 2\nUser quota MESSAGE 15    -      0\n');
    expect(out).toEqual({ bytes: 2048 * 1024, limitBytes: 102400 * 1024, messages: 15, messageLimit: null });
    expect(parseDoveadmQuota('')).toEqual({ bytes: null, limitBytes: null, messages: null, messageLimit: null });
  });

  it('reports capability_missing without doveadm before running anything', async () => {
    if (hasBinary('doveadm')) return;
    exec.mockClear();
    const err = await opError(runOp('vmail.quota.get', { user: 'info@alice.com' }, ctx));
    expect(err.code).toBe('capability_missing');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('vmail.render.check', () => {
  it('reports the hosting state read-only (no Dovecot/Exim here means not hooked, with a hint)', async () => {
    const r = await runOp('vmail.render.check', {}, ctx);
    expect(r).toMatchObject({ routerHooked: expect.any(Boolean), authHooked: expect.any(Boolean), transportHooked: expect.any(Boolean) });
    if (!r.exim.installed) expect(r.hint).toMatch(/Exim/);
    if (!r.dovecot.installed) expect(r.hint).toMatch(/Dovecot/);
  });
});

describe('field grammars', () => {
  it('LOCAL_PART and EMAIL_TARGET exclude everything Exim or a passwd file could misread', () => {
    for (const ok of ['a', 'first.last', 'a_b-c', 'x'.repeat(64)]) expect(LOCAL_PART.test(ok), ok).toBe(true);
    for (const bad of ['', '.a', '-a', 'A', 'a@b', 'a b', 'a:b', 'a|b', 'a/b', 'a${b}', 'x'.repeat(65)]) expect(LOCAL_PART.test(bad), bad).toBe(false);
    for (const bad of ['a@b.com|x', 'a@b.com/x', 'a@b.com:x', 'a@b.com,c@d.com', '${a}@b.com', 'a@b.com ', ' a@b.com']) expect(EMAIL_TARGET.test(bad), bad).toBe(false);
  });
});
