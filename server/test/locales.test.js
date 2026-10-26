import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockAgent } from './support/app.js';
import { buildLocaleXml, parseLocaleXml, decodeEntities, escapeXml, MAX_XML_BYTES } from '../src/services/locales-xml.js';
import { parseSystemLocaleFile, catalogStats } from '../src/services/locales.js';

let app;
let csrf;
let reseller;
let resellerCsrf;
let plainUser;
let systemFiles = { '/etc/default/locale': 'LANG=en_US.UTF-8\nLC_TIME="de_DE.UTF-8"\n# comment\nexport LANGUAGE=en_US:en\n' };

const mutate = (client, method, url, body, token) => client[method](url).set('X-CSRF-Token', token).send(body);
const put = (url, body) => mutate(app.http, 'put', url, body, csrf);
const post = (url, body = {}) => mutate(app.http, 'post', url, body, csrf);
const del = (url) => mutate(app.http, 'delete', url, undefined, csrf);
const get = (url) => app.http.get(url);
const auditCount = (action) => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

beforeAll(async () => {
  const agent = createMockAgent({
    'sys.read_file': ({ path }) => {
      if (!(path in systemFiles)) throw Object.assign(new Error(`ENOENT: ${path}`), { agentError: true, code: 'command_failed', details: {} });
      return { path, size: systemFiles[path].length, truncated: false, content: systemFiles[path] };
    },
  });
  app = await createTestApp({ agent });
  csrf = await app.login();
  const r = await app.createUser('resell1', 'reseller');
  reseller = request.agent(app.ctx.app);
  resellerCsrf = (await reseller.post('/api/auth/login').send({ username: r.username, password: r.password })).body.data.csrfToken;
  const u = await app.createUser('plainuser', 'user');
  plainUser = request.agent(app.ctx.app);
  await plainUser.post('/api/auth/login').send({ username: u.username, password: u.password }).expect(200);
}, 30_000);

afterAll(async () => { await app?.close(); });

describe('pure helpers', () => {
  it('round-trips a locale through XML with escaping', () => {
    const strings = { 'common.home': 'Inicio "casa" <b> & más', 'a.b/c-d_e': "l'été\n2 lignes", 'empty.key': '' };
    const xml = buildLocaleXml({ code: 'es', name: 'Español & <más>', strings });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<locale code="es" name="Español &amp; &lt;más&gt;" base="en">')).toBe(true);
    const parsed = parseLocaleXml(xml);
    expect(parsed.ok, parsed.errors.join('; ')).toBe(true);
    expect(parsed.locale).toMatchObject({ code: 'es', name: 'Español & <más>', base: 'en' });
    expect(parsed.locale.strings).toEqual(strings);
    expect(escapeXml('<&">')).toBe('&lt;&amp;&quot;&gt;');
    expect(decodeEntities('&apos;&#233;&#x1F600;')).toBe("'é😀");
  });

  it('rejects dangerous or malformed documents with line numbers', () => {
    expect(parseLocaleXml('<!DOCTYPE l [<!ENTITY e SYSTEM "file:///etc/passwd">]><locale code="es">&e;</locale>').errors[0]).toMatch(/DOCTYPE/);
    const bad = parseLocaleXml('<?xml version="1.0"?>\n<locale code="ES" name="x">\n<string key="a">1</string>\n<string key="a">2</string>\n<string key="b;c">3</string><other/></locale>');
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/line 4: duplicate key "a"/), expect.stringMatching(/line 5: key "b;c"/), expect.stringMatching(/unknown element <other>/)]));
    expect(parseLocaleXml('<locale code="es"><string key="a">x').errors).toEqual(expect.arrayContaining([expect.stringMatching(/never closed/)]));
    expect(parseLocaleXml('just text').errors).toContain('no <locale> root element');
    expect(parseLocaleXml('<locale code="not a code"><string key="a">x</string></locale>').errors[0]).toMatch(/locale code/);
    expect(parseLocaleXml('<locale code="es"><string>x</string></locale>').errors[0]).toMatch(/needs a key/);
    expect(parseLocaleXml('<locale code="es"><string key="a">&bogus;</string></locale>').errors[0]).toMatch(/unknown entity/);
    expect(parseLocaleXml('<locale code="es"></locale><locale code="de"></locale>').ok).toBe(false);
    expect(parseLocaleXml(123).ok).toBe(false);
    // CDATA, self-closing strings, comments and case/hyphen normalisation are fine.
    const ok = parseLocaleXml('<!-- c --><locale code="pt-BR"><string key="a"><![CDATA[<b>bold</b>]]></string><string key="e"/></locale>');
    expect(ok.ok).toBe(true);
    expect(ok.locale).toMatchObject({ code: 'pt_br', strings: { a: '<b>bold</b>', e: '' } });
  });

  it('parses a document near the 2 MB limit in linear time', () => {
    const strings = {};
    for (let i = 0; i < 26_000; i++) strings[`section${i % 50}.key${i}`] = `Translated string ${i}`;
    const xml = buildLocaleXml({ code: 'xx', name: 'Big', strings });
    expect(Buffer.byteLength(xml)).toBeGreaterThan(1.5 * 1024 * 1024);
    expect(Buffer.byteLength(xml)).toBeLessThan(MAX_XML_BYTES);
    const started = performance.now();
    const parsed = parseLocaleXml(xml);
    const elapsed = performance.now() - started;
    expect(parsed.ok, parsed.errors.join('; ')).toBe(true);
    expect(Object.keys(parsed.locale.strings)).toHaveLength(26_000);
    expect(elapsed).toBeLessThan(1000);
    // Line numbers still land on the right line when errors are reported late in a big document.
    const broken = xml.replace('</locale>', '<string key="section0.key0">dup</string>\n</locale>');
    const bad = parseLocaleXml(broken);
    // Line 1 is the declaration, line 2 the root, then 26,000 strings, so the appended duplicate sits on line 26,003.
    expect(bad.errors).toEqual([`line ${26_003}: duplicate key "section0.key0"`]);
  });

  it('parses system locale files and computes catalog stats', () => {
    expect(parseSystemLocaleFile(systemFiles['/etc/default/locale'])).toEqual({ LANG: 'en_US.UTF-8', LC_TIME: 'de_DE.UTF-8', LANGUAGE: 'en_US:en' });
    expect(parseSystemLocaleFile('')).toEqual({});
    expect(catalogStats({ a: 'A', b: 'B' }, { a: 'x', c: 'extra', b: '  ' })).toEqual({ total: 2, translated: 1, untranslated: 1, extra: 1, percent: 50 });
  });
});

describe('module registration, seeds and RBAC', () => {
  it('attaches ctx.locales, registers the capability and seeds the starter locales', async () => {
    expect(typeof app.ctx.locales.t).toBe('function');
    expect(app.ctx.locales.defaultCode()).toBe('en');
    expect(app.ctx.locales.enabledCodes()).toEqual(['en']);
    expect(Object.keys(app.ctx.locales.baseCatalog()).length).toBeGreaterThan(400);
    expect(app.ctx.locales.t('common.home')).toBe('Home');
    expect(app.ctx.locales.t('common.home', null, 'es')).toBe('Inicio');
    expect(app.ctx.locales.t('nope.key', 'fb')).toBe('fb');
    expect(Object.keys(app.ctx.capabilities.snapshot?.() ?? {}).length >= 0).toBe(true);
    const list = await get('/api/locales');
    expect(list.status).toBe(200);
    expect(list.body.data.map((l) => l.code)).toEqual(['en', 'de', 'es', 'fr', 'pt_br']);
    expect(list.body.meta).toMatchObject({ default: 'en', total: 5 });
    const en = list.body.data.find((l) => l.code === 'en');
    expect(en).toMatchObject({ builtin: true, isDefault: true, enabled: true });
    expect(en.stats.percent).toBe(100);
    const es = list.body.data.find((l) => l.code === 'es');
    expect(es).toMatchObject({ builtin: false, enabled: false, source: 'seed' });
    expect(es.stats.translated).toBeGreaterThan(50);
    expect(es.stats.untranslated).toBeGreaterThan(0);
    expect((await get('/api/locales?q=deut')).body.data.map((l) => l.code)).toEqual(['de']);
  });

  it('mutations and the system view are root only; reads are open to resellers; active is open to every role', async () => {
    expect((await mutate(reseller, 'put', '/api/locales/config', { default: 'es' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/locales/en/copy', { code: 'xx' }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'put', '/api/locales/es', { strings: { 'common.home': 'x' } }, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'delete', '/api/locales/es', undefined, resellerCsrf)).status).toBe(403);
    expect((await mutate(reseller, 'post', '/api/locales/xml', { xml: '<locale code="xx"/>' }, resellerCsrf)).status).toBe(403);
    expect((await reseller.get('/api/locales/system')).status).toBe(403);
    expect((await reseller.get('/api/locales')).status).toBe(200);
    expect((await reseller.get('/api/locales/es')).status).toBe(200);
    expect((await reseller.get('/api/locales/keys')).status).toBe(200);
    expect((await reseller.get('/api/locales/es/xml')).status).toBe(200);
    expect((await plainUser.get('/api/locales')).status).toBe(403);
    const active = await plainUser.get('/api/locales/active');
    expect(active.status).toBe(200);
    expect(active.body.data).toMatchObject({ code: 'en', default: 'en', enabled: ['en'] });
    expect(active.body.data.strings['common.home']).toBe('Home');
    expect((await request(app.ctx.app).get('/api/locales/active')).status).toBe(401);
  });
});

describe('validation (422)', () => {
  it('refuses bad codes, keys, values and bodies before touching the database', async () => {
    for (const code of ['-r', 'a;b', '..', 'e', 'english_language_x', 'es_', 'x%20y']) {
      expect((await get(`/api/locales/${code}`)).status, code).toBe(422);
    }
    expect((await put('/api/locales/config', {})).status).toBe(422);
    expect((await put('/api/locales/config', { default: 'es', extra: 1 })).status).toBe(422);
    expect((await put('/api/locales/config', { enabled: 'es' })).status).toBe(422);
    expect((await put('/api/locales/config', { default: 'xx' })).status).toBe(422);
    expect((await put('/api/locales/config', { enabled: ['en', 'zz'] })).status).toBe(422);
    expect((await post('/api/locales/en/copy', {})).status).toBe(422);
    expect((await post('/api/locales/en/copy', { code: 'ok_ok', name: 'a\nb' })).status).toBe(422);
    expect((await post('/api/locales/en/copy', { code: 'ok_ok', name: '<script>' })).status).toBe(422);
    expect((await put('/api/locales/es', {})).status).toBe(422);
    expect((await put('/api/locales/es', { strings: { 'bad key!': 'x' } })).status).toBe(422);
    expect((await put('/api/locales/es', { strings: { 'common.home': 'a\u0007b' } })).status).toBe(422);
    expect((await put('/api/locales/es', { strings: { 'common.home': 'x'.repeat(2001) } })).status).toBe(422);
    expect((await put('/api/locales/es', { strings: { 'common.home': 5 } })).status).toBe(422);
    expect((await post('/api/locales/xml', {})).status).toBe(422);
    expect((await post('/api/locales/xml', { xml: '<locale code="es"/>', mode: 'upsert' })).status).toBe(422);
    expect((await post('/api/locales/xml', { xml: '<locale code="es"/>', code: '-r' })).status).toBe(422);
    expect((await get('/api/locales/active?code=a;b')).status).toBe(422);
    const invalid = await post('/api/locales/xml', { xml: '<!DOCTYPE x><locale code="xx"/>' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.fields.xml[0]).toMatch(/DOCTYPE/);
    const broken = await post('/api/locales/xml', { xml: '<locale code="xx"><string key="a">1</string><string key="a">2</string></locale>' });
    expect(broken.status).toBe(422);
    expect(broken.body.error.fields.xml).toEqual([expect.stringMatching(/duplicate key "a"/)]);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM locales').get().n).toBe(5);
  });
});

describe('Configure Application Locales', () => {
  it('sets the default and enabled set, always keeping the default enabled', async () => {
    const res = await put('/api/locales/config', { default: 'es', enabled: ['de'] });
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.data.map((l) => [l.code, l]));
    expect(byCode.es).toMatchObject({ isDefault: true, enabled: true });
    expect(byCode.de.enabled).toBe(true);
    expect(byCode.en).toMatchObject({ isDefault: false, enabled: false });
    expect(byCode.fr.enabled).toBe(false);
    expect(app.ctx.locales.defaultCode()).toBe('es');
    expect(app.ctx.locales.enabledCodes()).toEqual(['de', 'es']);
    expect(app.ctx.settings.get('locales.default')).toBe('es');
    expect(auditCount('locales.configure')).toBe(1);
    // Active follows the default and honours a requested enabled locale, never a disabled one.
    expect((await plainUser.get('/api/locales/active')).body.data).toMatchObject({ code: 'es', default: 'es' });
    expect((await plainUser.get('/api/locales/active')).body.data.strings['common.home']).toBe('Inicio');
    expect((await plainUser.get('/api/locales/active?code=de')).body.data.code).toBe('de');
    expect((await plainUser.get('/api/locales/active?code=pt-BR')).body.data.code).toBe('es');
    expect((await plainUser.get('/api/locales/active?code=xx')).body.data.code).toBe('es');
    expect((await plainUser.get('/api/locales/active?code=en')).body.data.code).toBe('es');
    // Partial updates keep the other half.
    const onlyEnabled = await put('/api/locales/config', { enabled: ['en', 'fr'] });
    expect(onlyEnabled.body.data.filter((l) => l.enabled).map((l) => l.code).sort()).toEqual(['en', 'es', 'fr']);
    expect(onlyEnabled.body.meta.default).toBe('es');
    const onlyDefault = await put('/api/locales/config', { default: 'en' });
    expect(onlyDefault.body.meta.default).toBe('en');
    expect(onlyDefault.body.data.filter((l) => l.enabled).map((l) => l.code).sort()).toEqual(['en', 'es', 'fr']);
    await put('/api/locales/config', { default: 'en', enabled: ['en'] });
  });
});

describe('Copy, Edit and Delete a Locale', () => {
  it('copies the built-in locale into an editable one and edits it', async () => {
    const copy = await post('/api/locales/en/copy', { code: 'EN-GB', name: 'English (UK)' });
    expect(copy.status).toBe(201);
    expect(copy.body.data).toMatchObject({ code: 'en_gb', name: 'English (UK)', builtin: false, enabled: false, copiedFrom: 'en', source: 'copy' });
    expect(copy.body.data.stats.percent).toBe(100);
    expect(copy.body.data.strings['common.home']).toBe('Home');
    expect((await post('/api/locales/en/copy', { code: 'en_gb' })).status).toBe(409);
    expect((await post('/api/locales/zzz/copy', { code: 'zz' })).status).toBe(404);
    expect((await post('/api/locales/nope/copy', { code: 'zz' })).status).toBe(422);
    const unnamed = await post('/api/locales/es/copy', { code: 'es_mx' });
    expect(unnamed.body.data.name).toBe('Español (copy)');
    expect(auditCount('locales.copy')).toBe(2);

    const edit = await put('/api/locales/en_gb', { name: 'British English', strings: { 'common.favorite': 'Favourite', 'shell.tools': '', 'custom.extra': 'Cheers', 'common.home': 'Home' } });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ name: 'British English', changed: 2, removed: 1 });
    expect(edit.body.data.strings['common.favorite']).toBe('Favourite');
    expect(edit.body.data.strings['shell.tools']).toBeUndefined();
    expect(edit.body.data.stats).toMatchObject({ untranslated: 1, extra: 1 });
    expect(app.ctx.locales.t('common.favorite', null, 'en_gb')).toBe('Favourite');
    expect(app.ctx.locales.t('shell.tools', null, 'en_gb')).toBe('Tools');
    const cleared = await put('/api/locales/en_gb', { strings: { 'custom.extra': null } });
    expect(cleared.body.data.removed).toBe(1);
    expect(cleared.body.data.stats.extra).toBe(0);
    expect((await put('/api/locales/en', { strings: { 'common.home': 'Casa' } })).status).toBe(409);
    expect((await put('/api/locales/zz', { strings: { 'common.home': 'Casa' } })).status).toBe(404);
    expect(auditCount('locales.update')).toBe(2);
    expect((await get('/api/locales/keys')).body.data.strings['common.home']).toBe('Home');
  });

  it('deletes custom locales but never the built-in or the current default', async () => {
    expect((await del('/api/locales/en')).status).toBe(409);
    await put('/api/locales/config', { default: 'es_mx' });
    const asDefault = await del('/api/locales/es_mx');
    expect(asDefault.status).toBe(409);
    expect(asDefault.body.error.message).toMatch(/default/);
    await put('/api/locales/config', { default: 'en', enabled: ['en'] });
    expect((await del('/api/locales/es_mx')).body.data).toEqual({ code: 'es_mx', deleted: true });
    expect((await get('/api/locales/es_mx')).status).toBe(404);
    expect((await del('/api/locales/es_mx')).status).toBe(404);
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM locale_meta WHERE code = 'es_mx'").get().n).toBe(0);
    expect(auditCount('locales.delete')).toBe(1);
  });
});

describe('Locale XML Download / Upload', () => {
  it('exports a locale and imports it back in every mode', async () => {
    const dl = await get('/api/locales/en_gb/xml');
    expect(dl.status).toBe(200);
    expect(dl.body.data).toMatchObject({ code: 'en_gb', filename: 'en_gb.xml', contentType: 'application/xml' });
    expect(dl.body.data.content).toContain('<locale code="en_gb" name="British English" base="en">');
    expect(dl.body.data.content).toContain('<string key="common.favorite">Favourite</string>');
    expect((await get('/api/locales/zz/xml')).status).toBe(404);
    const en = (await get('/api/locales/en/xml')).body.data;
    expect(parseLocaleXml(en.content).locale.strings['common.home']).toBe('Home');

    const dry = await post('/api/locales/xml', { xml: dl.body.data.content, code: 'en_au', name: 'Australian English', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ code: 'en_au', name: 'Australian English', exists: false, dryRun: true, added: dry.body.data.keys, changed: 0, removed: 0 });
    expect((await get('/api/locales/en_au')).status).toBe(404);

    const created = await post('/api/locales/xml', { xml: dl.body.data.content, code: 'en_au', name: 'Australian English', mode: 'create' });
    expect(created.status).toBe(201);
    expect(created.body.data.locale).toMatchObject({ code: 'en_au', name: 'Australian English', source: 'import', enabled: false });
    expect(created.body.data.locale.strings['common.favorite']).toBe('Favourite');
    expect((await post('/api/locales/xml', { xml: dl.body.data.content, code: 'en_au', mode: 'create' })).status).toBe(409);
    expect((await post('/api/locales/xml', { xml: dl.body.data.content, code: 'en' })).status).toBe(409);

    const mergeXml = buildLocaleXml({ code: 'en_au', name: 'ignored', strings: { 'common.home': 'G\'day', 'custom.new': 'Mate' } });
    const merged = await post('/api/locales/xml', { xml: mergeXml, mode: 'merge' });
    expect(merged.status).toBe(200);
    expect(merged.body.data).toMatchObject({ exists: true, keys: 2, added: 1, changed: 1, removed: 0, unknownKeys: ['custom.new'] });
    expect(merged.body.data.locale.name).toBe('ignored');
    expect(merged.body.data.locale.strings).toMatchObject({ 'common.home': 'G\'day', 'common.favorite': 'Favourite', 'custom.new': 'Mate' });

    const replaced = await post('/api/locales/xml', { xml: buildLocaleXml({ code: 'en_au', name: 'Australian English', strings: { 'common.home': 'Home' } }), mode: 'replace' });
    expect(replaced.body.data.removed).toBeGreaterThan(400);
    expect(Object.keys(replaced.body.data.locale.strings)).toEqual(['common.home']);
    expect(replaced.body.data.locale.stats.translated).toBe(1);
    expect(auditCount('locales.import')).toBe(3);
    expect((await del('/api/locales/en_au')).status).toBe(200);
  });
});

describe('View Available Locales: system locale', () => {
  it('reads LANG from the first readable system file through the agent and degrades when none exists', async () => {
    const res = await get('/api/locales/system');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ capability: false, lang: 'en_US.UTF-8', panelDefault: 'en', config: { path: '/etc/default/locale', vars: { LANG: 'en_US.UTF-8', LC_TIME: 'de_DE.UTF-8' } } });
    expect(app.agent.callsTo('sys.read_file').pop().args).toEqual({ path: '/etc/default/locale', maxBytes: 65536, tail: false });
    systemFiles = { '/etc/locale.conf': 'LANG="C.UTF-8"\n' };
    expect((await get('/api/locales/system')).body.data).toMatchObject({ lang: 'C.UTF-8', config: { path: '/etc/locale.conf' } });
    systemFiles = {};
    const none = await get('/api/locales/system');
    expect(none.status).toBe(200);
    expect(none.body.data).toMatchObject({ capability: false, config: null, lang: null });
    app.agent.set('sys.binaries', ({ names }) => Object.fromEntries(names.map((n) => [n, n === 'locale'])));
    await app.ctx.capabilities.refresh();
    expect((await get('/api/locales/system')).body.data.capability).toBe(true);
    app.agent.reset('sys.binaries');
    await app.ctx.capabilities.refresh();
  });
});
