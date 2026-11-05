import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { renderSieve, normalizeRules, sieveString, FILTER_FOLDER, FILTER_HEADER_NAME } from '../src/services/panel-email.js';

const HASH = '$6$zbsfcWrdKw0VR0wa$A0rw1A7d4PBa2YN/z1nATzFjoYngcI/Kpt3Ih5IWolea1/ANnjhx8YxtNUdCS5bDEjG80Yb.rvLa4CkZj2/pR1';
const PRESENT = new Set(['exim4', 'exim', 'dovecot', 'doveadm', 'sievec', 'openssl', 'setpriv', 'runuser', 'named', 'rndc', 'named-checkzone']);

const OVERRIDES = {
  'sys.binaries': ({ names }) => Object.fromEntries(names.map((n) => [n, PRESENT.has(n)])),
  'vmail.hash': () => ({ hash: HASH, scheme: 'SHA512-CRYPT', tool: 'openssl' }),
  'vmail.passwd.set': ({ domain, localPart }) => ({ domain, localPart, replaced: false }),
  'vmail.passwd.remove': ({ domain, localPart }) => ({ domain, localPart, removed: true }),
  'vmail.quota.get': ({ user }) => ({ user, bytes: 0, limitBytes: null, messages: 0 }),
  'vmail.render.check': () => ({ dovecot: { installed: true, configOk: true }, exim: { installed: true, configOk: true }, routerHooked: true, transportHooked: true, authHooked: true, hint: null }),
  'vmail.sieve.write': ({ scope, mailbox, script }) => ({ scope, mailbox: mailbox ?? null, path: '/home/alice/x', activated: scope === 'mailbox', bytes: script.length, warnings: [] }),
  'vmail.sieve.remove': ({ scope, mailbox }) => ({ scope, mailbox: mailbox ?? null, removed: true, deactivated: scope === 'mailbox' }),
  'vmail.sieve.test': () => ({ ok: true, errors: [], warnings: [] }),
  'files.mkdir': ({ path }) => ({ path }),
  'files.write': ({ path }) => ({ path }),
  'files.remove': ({ paths }) => ({ removed: paths }),
  'files.du': () => ({ totalKb: 12, entries: [] }),
  'mail.config.include.write': () => ({ domainListsHooked: true, path: '/etc/exim4/whm/x.lst' }),
  'mail.detect': () => ({ installed: true, flavor: 'debian', dovecot: { installed: true, doveadm: true }, spamd: { installed: false } }),
  'dns.layout': () => ({ installed: true, flavor: 'debian', zoneDir: '/etc/bind/zones', includeFile: '/etc/bind/named.conf.whm' }),
  'dns.zone.list': () => ({ installed: true, zones: [] }),
  'dns.zone.read': ({ domain }) => ({ domain, exists: false, body: null }),
  'dns.checkzone': ({ domain }) => ({ domain, ok: true, output: '', serial: 1 }),
  'dns.zone.write': ({ domain }) => ({ domain, path: `/etc/bind/zones/${domain}.db`, stanzaAdded: true, includeAdded: false }),
  'dns.reload': ({ domain }) => ({ method: 'rndc', domain: domain ?? null, output: '' }),
};
const restoreAgent = (agent) => { for (const [name, handler] of Object.entries(OVERRIDES)) agent.set(name, handler); agent.calls.length = 0; };

async function panelLogin(app, username, password = 'Panel-Passw0rd!1') {
  const hash = await app.ctx.crypto.hashPassword(password);
  app.ctx.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
  const http = request.agent(app.ctx.app);
  const res = await http.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`panel login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.data.csrfToken;
  return {
    http, csrf,
    get: (p) => http.get(`/api/panel${p}`),
    post: (p, body = {}) => http.post(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    put: (p, body = {}) => http.put(`/api/panel${p}`).set('X-CSRF-Token', csrf).send(body),
    del: (p) => http.delete(`/api/panel${p}`).set('X-CSRF-Token', csrf),
  };
}

function setFeature(app, username, key, enabled) {
  const row = app.ctx.db.prepare('SELECT plan_snapshot_json FROM accounts WHERE username = ?').get(username);
  const plan = JSON.parse(row.plan_snapshot_json || '{}');
  app.ctx.db.prepare('UPDATE accounts SET plan_snapshot_json = ? WHERE username = ?').run(JSON.stringify({ ...plan, features: { ...(plan.features || {}), [key]: enabled } }), username);
}

const rule = (over = {}) => ({ name: 'Test to Junk', rules: { matchAll: true, match: [{ header: 'subject', op: 'contains', value: '[test]' }], actions: [{ type: 'fileinto', folder: 'Junk' }, { type: 'stop' }] }, ...over });

describe('Sieve rendering', () => {
  it('escapes quotes and backslashes inside Sieve strings and refuses control characters or a second line', () => {
    expect(sieveString('a "quoted" \\ value')).toBe('"a \\"quoted\\" \\\\ value"');
    for (const bad of ['line1\nline2', 'tab\there', 'cr\rhere', 'nul\0x', '', 'x'.repeat(999)]) expect(() => sieveString(bad), JSON.stringify(bad)).toThrow();
    const script = renderSieve([{ name: 'Quoted', enabled: true, rules: { match: [{ header: 'from', op: 'contains', value: 'say "hi" \\ bye' }], actions: [{ type: 'fileinto', folder: "Clients' mail" }, { type: 'redirect', address: 'a@b.com' }] } }]);
    expect(script).toContain('if header :contains "from" "say \\"hi\\" \\\\ bye" {');
    expect(script).toContain('  fileinto :create "Clients\' mail";');
    // Folder names and addresses never need escaping: their grammars exclude quotes and backslashes.
    expect(() => renderSieve([{ name: 'F', enabled: true, rules: { match: [{ header: 'from', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: 'Folder "x"' }] } }])).toThrow();
    expect(script.split('\n').filter((l) => l.startsWith('if ')).length).toBe(1);
  });

  it('renders every header, operator and action; requires only what is used; skips disabled filters; keeps the order', () => {
    const filters = [
      { name: 'Second', enabled: true, rules: { matchAll: false, match: [{ header: 'to', op: 'is', value: 'me@x.com' }, { header: 'custom', name: 'X-Priority', op: 'matches', value: '1*' }], actions: [{ type: 'redirect', address: 'Other@Example.com' }, { type: 'discard' }] } },
      { name: 'Off', enabled: false, rules: { match: [{ header: 'body', op: 'contains', value: 'x' }], actions: [{ type: 'discard' }] } },
      { name: 'Third', enabled: true, rules: { match: [{ header: 'any_header', op: 'not_contains', value: 'spam' }, { header: 'body', op: 'contains', value: 'lottery' }], actions: [{ type: 'stop' }] } },
    ];
    const script = renderSieve(filters);
    const lines = script.split('\n');
    expect(lines[0]).toMatch(/^# Keel/);
    expect(lines[1]).toBe('require ["body"];');
    expect(script).toContain('# Second\nif anyof (header :is "to" "me@x.com", header :matches "x-priority" "1*") {\n  redirect "other@example.com";\n  discard;\n}');
    expect(script).toContain('# Third\nif allof (not header :contains ["from", "to", "cc", "subject", "reply-to", "sender", "list-id"] "spam", body :text :contains "lottery") {\n  stop;\n}');
    expect(script).not.toContain('# Off');
    expect(script.indexOf('# Second')).toBeLessThan(script.indexOf('# Third'));
    expect(renderSieve([])).toBe('# Keel (customer panel mail filters) - managed script, edits are overwritten\n');
    expect(renderSieve([{ name: 'F', enabled: true, rules: { match: [{ header: 'subject', op: 'contains', value: 'a' }], actions: [{ type: 'fileinto', folder: 'Junk' }] } }])).toContain('require ["fileinto", "mailbox"];');
  });

  it('normalizeRules refuses what the grammars cannot carry', () => {
    const ok = normalizeRules({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] });
    expect(ok).toEqual({ matchAll: true, match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] });
    const bad = (rules) => expect(() => normalizeRules(rules), JSON.stringify(rules)).toThrow();
    bad({ match: [], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [] });
    bad({ match: [{ header: 'nope', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'subject', op: 'regex', value: 'x' }], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'custom', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'custom', name: 'X Priority', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'a\nb' }], actions: [{ type: 'stop' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: '../etc' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: '.hidden' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: 'a"b' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'redirect', address: 'not an address' }] });
    bad({ match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: Array.from({ length: 5 }, () => ({ type: 'redirect', address: 'a@b.com' })) });
    for (const good of ['Junk', 'INBOX.Archive', 'Projects 2026', "Clients' mail"]) expect(FILTER_FOLDER.test(good), good).toBe(true);
    for (const bad2 of ['', '.Junk', 'Junk.', 'a..b', 'a/b', 'a\\b', 'x'.repeat(201)]) expect(FILTER_FOLDER.test(bad2), bad2).toBe(false);
    expect(FILTER_HEADER_NAME.test('X-Spam-Flag')).toBe(true);
    expect(FILTER_HEADER_NAME.test('X-Spam: Flag')).toBe(false);
  });
});

describe('Customer panel: email filters', () => {
  let app;
  let csrf;
  let alice;
  let bob;
  let mailboxId;
  const db = () => app.ctx.db;
  const rows = (sql, ...args) => db().prepare(sql).all(...args);
  const names = () => app.agent.calls.map((c) => c.name);
  const writes = () => app.agent.callsTo('vmail.sieve.write').map((c) => c.args);

  beforeAll(async () => {
    app = await createTestApp({ agent: createMockAgent(OVERRIDES) });
    csrf = await app.login();
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.com', ip: '203.0.113.5', provision: { mail: false } }).expect(201);
    await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'bob', domain: 'bob.com', ip: '203.0.113.6', provision: { mail: false } }).expect(201);
    alice = await panelLogin(app, 'alice');
    bob = await panelLogin(app, 'bob');
    await app.ctx.capabilities.refresh();
    const created = await alice.post('/email/accounts', { localPart: 'info', domain: 'alice.com', password: 'Str0ng-Passw0rd!' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    mailboxId = created.body.data.id;
  });
  afterAll(() => app.close());
  beforeEach(() => restoreAgent(app.agent));

  it('gates on the emailfilters feature and never reaches the host while off', async () => {
    setFeature(app, 'alice', 'emailfilters', false);
    for (const call of [() => alice.get(`/email/filters?mailbox=${mailboxId}`), () => alice.post(`/email/filters?mailbox=${mailboxId}`, rule()), () => alice.get('/email/global-filters'), () => alice.post('/email/global-filters', rule())]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('feature_disabled');
    }
    setFeature(app, 'alice', 'emailfilters', true);
    expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
  });

  it('lists an empty scope with the builder vocabulary and the rendered (empty) script', async () => {
    const res = await alice.get(`/email/filters?mailbox=${mailboxId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ scope: 'mailbox', mailbox: { id: mailboxId, address: 'info@alice.com' }, max: 100, folders: expect.arrayContaining(['Junk']), sieve: { available: true, dovecot: true, sievec: true } });
    expect(res.body.meta.script).toMatch(/^# Keel/);
    const g = await alice.get('/email/global-filters');
    expect(g.body.meta).toMatchObject({ scope: 'account', mailbox: null });
    expect((await alice.get('/email/filters')).status).toBe(422);
  });

  it('answers 404 for a mailbox of another account and for unknown ids', async () => {
    expect((await bob.get(`/email/filters?mailbox=${mailboxId}`)).status).toBe(404);
    expect((await bob.post(`/email/filters?mailbox=${mailboxId}`, rule())).status).toBe(404);
    expect((await alice.get('/email/filters?mailbox=99999')).status).toBe(404);
    expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
  });

  it('422s on malformed rules before anything reaches the host', async () => {
    const cases = [
      rule({ name: '' }),
      rule({ name: 'a\nb' }),
      rule({ rules: { match: [], actions: [{ type: 'stop' }] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x\ny' }], actions: [{ type: 'stop' }] } }),
      rule({ rules: { match: [{ header: 'x-mailer', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] } }),
      rule({ rules: { match: [{ header: 'custom', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] } }),
      rule({ rules: { match: [{ header: 'custom', name: 'X:Y', op: 'contains', value: 'x' }], actions: [{ type: 'stop' }] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: '../Junk' }] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'fileinto', folder: 'a"b' }] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'redirect', address: 'x' }] } }),
      rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'x' }], actions: [{ type: 'stop', folder: 'x' }], script: 'discard;' } }),
      { ...rule(), script: 'discard;' },
    ];
    for (const body of cases) {
      const res = await alice.post(`/email/filters?mailbox=${mailboxId}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(names().filter((n) => n.startsWith('vmail.'))).toEqual([]);
    expect(rows('SELECT id FROM panel_mail_filters')).toEqual([]);
  });

  it('creates a filter: script written as alice for the mailbox first, row second, audited', async () => {
    const res = await alice.post(`/email/filters?mailbox=${mailboxId}`, rule({ rules: { match: [{ header: 'subject', op: 'contains', value: 'say "hi" \\ there' }], actions: [{ type: 'fileinto', folder: 'Junk' }, { type: 'stop' }] } }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ scope: 'mailbox', mailboxId, name: 'Test to Junk', position: 1, enabled: true });
    expect(res.body.data.rules.match[0].value).toBe('say "hi" \\ there');
    expect(res.body.meta.activated).toBe(true);
    const [w] = writes();
    expect(w).toMatchObject({ username: 'alice', scope: 'mailbox', mailbox: 'info@alice.com' });
    expect(w.script).toContain('if header :contains "subject" "say \\"hi\\" \\\\ there" {\n  fileinto :create "Junk";\n  stop;\n}');
    expect(w.script.startsWith('# Keel')).toBe(true);
    expect(rows('SELECT scope, mailbox_id, position FROM panel_mail_filters')).toEqual([{ scope: 'mailbox', mailbox_id: mailboxId, position: 1 }]);
    const audit = rows("SELECT args_redacted FROM audit_log WHERE action = 'panel.email.filter.create' AND target = 'alice'");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].args_redacted)).toMatchObject({ scope: 'mailbox', mailbox: 'info@alice.com', name: 'Test to Junk' });
  });

  it('a compile failure is a 422 with the compiler lines and leaves no row', async () => {
    app.agent.set('vmail.sieve.write', Object.assign(new Error('The filter script does not compile: line 3: unknown command'), { agentError: true, code: 'invalid_sieve', details: { errors: [{ line: 3, message: 'unknown command' }] } }));
    const res = await alice.post(`/email/filters?mailbox=${mailboxId}`, rule({ name: 'Broken' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('sieve_compile_failed');
    expect(res.body.error.fields.rules).toEqual(['line 3: unknown command']);
    expect(rows("SELECT id FROM panel_mail_filters WHERE name = 'Broken'")).toEqual([]);
  });

  it('keeps mailbox and account scopes apart: global ids are not reachable through /filters and vice versa', async () => {
    const g = await alice.post('/email/global-filters', rule({ name: 'Global discard', rules: { match: [{ header: 'from', op: 'contains', value: 'spammer' }], actions: [{ type: 'discard' }] } }));
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const w = writes()[0];
    expect(w).toEqual({ username: 'alice', scope: 'account', script: expect.stringContaining('discard;') });
    expect(w).not.toHaveProperty('mailbox');
    const mailboxRow = rows("SELECT id FROM panel_mail_filters WHERE scope = 'mailbox'")[0];
    expect((await alice.put(`/email/global-filters/${mailboxRow.id}`, { enabled: false })).status).toBe(404);
    expect((await alice.put(`/email/filters/${g.body.data.id}`, { enabled: false })).status).toBe(404);
    expect((await alice.del(`/email/filters/${g.body.data.id}`)).status).toBe(404);
    expect((await bob.del(`/email/global-filters/${g.body.data.id}`)).status).toBe(404);
    expect(rows('SELECT id FROM panel_mail_filters')).toHaveLength(2);
  });

  it('orders filters, re-renders the whole script on reorder and refuses an incomplete order', async () => {
    const second = await alice.post(`/email/filters?mailbox=${mailboxId}`, rule({ name: 'Newsletters', rules: { match: [{ header: 'any_header', op: 'contains', value: 'newsletter' }], actions: [{ type: 'fileinto', folder: 'Archive' }] } }));
    expect(second.status).toBe(201);
    expect(second.body.data.position).toBe(2);
    const ids = (await alice.get(`/email/filters?mailbox=${mailboxId}`)).body.data.map((f) => f.id);
    expect(ids).toHaveLength(2);
    expect((await alice.post(`/email/filters/reorder?mailbox=${mailboxId}`, { ids: [ids[0]] })).status).toBe(422);
    expect((await alice.post(`/email/filters/reorder?mailbox=${mailboxId}`, { ids: [ids[0], ids[0]] })).status).toBe(422);
    expect((await alice.post(`/email/filters/reorder?mailbox=${mailboxId}`, { ids: [ids[0], 99999] })).status).toBe(422);
    app.agent.calls.length = 0;
    const res = await alice.post(`/email/filters/reorder?mailbox=${mailboxId}`, { ids: [ids[1], ids[0]] });
    expect(res.status).toBe(200);
    expect(res.body.data.map((f) => [f.id, f.position])).toEqual([[ids[1], 1], [ids[0], 2]]);
    const script = writes()[0].script;
    expect(script.indexOf('# Newsletters')).toBeLessThan(script.indexOf('# Test to Junk'));
    expect(rows("SELECT id FROM audit_log WHERE action = 'panel.email.filter.reorder'")).toHaveLength(1);
  });

  it('update re-renders with the change (a disabled filter leaves the script), delete of the last filter removes the script', async () => {
    const list = (await alice.get(`/email/filters?mailbox=${mailboxId}`)).body.data;
    const off = await alice.put(`/email/filters/${list[0].id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data.enabled).toBe(false);
    expect(writes()[0].script).not.toContain(`# ${list[0].name}`);
    expect(writes()[0].script).toContain(`# ${list[1].name}`);
    const renamed = await alice.put(`/email/filters/${list[1].id}`, { name: 'Renamed', rules: { match: [{ header: 'subject', op: 'is', value: 'exact' }], actions: [{ type: 'discard' }] } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Renamed', rules: { match: [{ header: 'subject', op: 'is', value: 'exact' }] } });
    expect((await alice.put(`/email/filters/${list[1].id}`, {})).status).toBe(422);
    app.agent.calls.length = 0;
    expect((await alice.del(`/email/filters/${list[0].id}`)).status).toBe(200);
    expect(names()).toContain('vmail.sieve.write');
    expect(names()).not.toContain('vmail.sieve.remove');
    app.agent.calls.length = 0;
    expect((await alice.del(`/email/filters/${list[1].id}`)).status).toBe(200);
    expect(names()).toEqual(['vmail.sieve.remove']);
    expect(app.agent.callsTo('vmail.sieve.remove')[0].args).toEqual({ username: 'alice', scope: 'mailbox', mailbox: 'info@alice.com' });
    expect(rows("SELECT id FROM panel_mail_filters WHERE scope = 'mailbox'")).toEqual([]);
  });

  it('the Test action compiles one filter without touching the live script', async () => {
    const res = await alice.post(`/email/filters/test?mailbox=${mailboxId}`, { rules: rule().rules });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: true, errors: [] });
    expect(res.body.data.script).toContain('fileinto :create "Junk";');
    expect(names()).toEqual(['vmail.sieve.test']);
    expect(app.agent.callsTo('vmail.sieve.test')[0].args).toMatchObject({ username: 'alice', scope: 'mailbox', mailbox: 'info@alice.com' });
    app.agent.set('vmail.sieve.test', () => ({ ok: false, errors: [{ line: 2, message: 'nope' }], warnings: [] }));
    const bad = await alice.post('/email/global-filters/test', { rules: rule().rules });
    expect(bad.status).toBe(200);
    expect(bad.body.data.ok).toBe(false);
    expect((await alice.post('/email/global-filters/test', { rules: { match: [], actions: [] } })).status).toBe(422);
  });

  it('answers 501 when the host lacks Sieve support', async () => {
    app.agent.set('vmail.sieve.write', Object.assign(new Error('sievec (dovecot-sieve / Pigeonhole) is required'), { agentError: true, code: 'capability_missing', details: {} }));
    const res = await alice.post('/email/global-filters', rule({ name: 'No sieve' }));
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('capability_missing');
    expect(rows("SELECT id FROM panel_mail_filters WHERE name = 'No sieve'")).toEqual([]);
  });

  it('deleting the mailbox removes its filter rows', async () => {
    const created = await alice.post(`/email/filters?mailbox=${mailboxId}`, rule({ name: 'Orphan' }));
    expect(created.status).toBe(201);
    expect((await alice.del(`/email/accounts/${mailboxId}`)).status).toBe(200);
    expect(rows("SELECT id FROM panel_mail_filters WHERE name = 'Orphan'")).toEqual([]);
  });
});
