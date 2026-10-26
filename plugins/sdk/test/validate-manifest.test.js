'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../validate-manifest');
const { fullManifest, minimalManifest } = require('./fixtures');

const codesAt = (res, pathPrefix) => res.errors.filter((e) => e.path.startsWith(pathPrefix)).map((e) => e.code);
const expectError = (manifest, pathPrefix, code) => {
  const res = V.validateManifest(manifest);
  assert.equal(res.ok, false, `expected failure for ${pathPrefix} ${code}`);
  assert.ok(codesAt(res, pathPrefix).includes(code), `expected ${code} at ${pathPrefix}, got ${JSON.stringify(res.errors)}`);
  return res;
};

test('constants: 30 categories, Plugins included, no duplicates', () => {
  assert.equal(V.CATEGORIES.length, 30);
  assert.ok(V.CATEGORIES.includes('Plugins'));
  assert.ok(V.CATEGORIES.includes('Server Configuration'));
  assert.ok(V.CATEGORIES.includes('Restart Services'));
  assert.equal(new Set(V.CATEGORIES).size, 30);
});

test('constants: permission vocabulary and event catalog are frozen and complete', () => {
  for (const s of ['accounts:read', 'accounts:write', 'packages:read', 'dns:read', 'backups:read', 'backups:write',
    'backups:restore', 'settings:own', 'store:own', 'schedule', 'jobs', 'events:emit', 'ui:sidebar', 'api:routes',
    'contacts:notify', 'system:read', 'audit:write', 'crypto:own', 'fs:own']) {
    assert.ok(V.PERMISSION_SCOPES.includes(s), `missing scope ${s}`);
  }
  assert.ok(Object.isFrozen(V.PERMISSIONS));
  assert.ok(Object.isFrozen(V.EVENTS));
  for (const e of ['account.created', 'account.modified', 'account.suspended', 'account.unsuspended', 'account.terminated',
    'backup.completed', 'backup.failed', 'dns.zone.changed', 'ssl.issued', 'login.failed', 'service.restarted', 'plugin.installed']) {
    assert.ok(V.EVENT_NAMES.includes(e), `missing event ${e}`);
  }
  for (const [name, def] of Object.entries(V.EVENTS)) {
    assert.ok(def.stages.every((s) => V.HOOK_STAGES.includes(s)), name);
    if (def.cancellable) {
      assert.ok(def.stages.includes('pre'), `${name} cancellable but has no pre stage`);
      assert.ok(V.PERMISSION_SCOPES.includes(def.cancelScope), `${name} cancelScope unknown`);
    }
    assert.ok(!V.PLUGIN_EVENT_PATTERN.test(name), `catalog event ${name} must not look like a plugin event`);
  }
  assert.deepEqual(V.AGENT_OP_FAMILIES, ['user', 'web', 'dns', 'mail', 'db', 'ftp', 'svc', 'net', 'ssl', 'sec', 'sys', 'fs']);
});

test('isKnownPermission: fixed, agent:op and net:outbound scopes', () => {
  assert.ok(V.isKnownPermission('backups:write'));
  assert.ok(V.isKnownPermission('agent:op:svc.restart'));
  assert.ok(V.isKnownPermission('agent:op:web.vhost.write'));
  assert.ok(!V.isKnownPermission('agent:op:shell.exec'));
  assert.ok(!V.isKnownPermission('agent:op:svc'));
  assert.ok(!V.isKnownPermission('agent:op:svc.*'));
  assert.ok(V.isKnownPermission('net:outbound:api.example.com'));
  assert.ok(V.isKnownPermission('net:outbound:*.s3.amazonaws.com'));
  assert.ok(V.isKnownPermission('net:outbound:backup.example.com:8443'));
  assert.ok(!V.isKnownPermission('net:outbound:*'));
  assert.ok(!V.isKnownPermission('net:outbound:'));
  assert.ok(!V.isKnownPermission('net:outbound:Example.COM'));
  assert.ok(!V.isKnownPermission('backups:admin'));
});

test('matchesNetScope: exact, wildcard sub-domain and port rules', () => {
  const scopes = ['net:outbound:api.example.net', 'net:outbound:*.storage.example.net:8443'];
  assert.equal(V.matchesNetScope('api.example.net', '', scopes), 'net:outbound:api.example.net');
  assert.equal(V.matchesNetScope('api.example.net', '443', scopes), 'net:outbound:api.example.net');
  assert.equal(V.matchesNetScope('eu.storage.example.net', '8443', scopes), 'net:outbound:*.storage.example.net:8443');
  assert.equal(V.matchesNetScope('eu.storage.example.net', '', scopes), null);
  assert.equal(V.matchesNetScope('storage.example.net', '8443', scopes), null);
  assert.equal(V.matchesNetScope('evil.net', '', scopes), null);
  // An empty port is the https default, so a "host:443" scope matches https://host/.
  assert.equal(V.matchesNetScope('api.example.net', '', ['net:outbound:api.example.net:443']), 'net:outbound:api.example.net:443');
  assert.equal(V.matchesNetScope('api.example.net', '8443', ['net:outbound:api.example.net:443']), null);
});

test('full manifest is valid; minimal manifest is valid', () => {
  const full = V.validateManifest(fullManifest());
  assert.deepEqual(full.errors, []);
  assert.equal(full.ok, true);
  const min = V.validateManifest(minimalManifest());
  assert.deepEqual(min.errors, []);
});

test('rejects non-object manifests', () => {
  assert.equal(V.validateManifest(null).ok, false);
  assert.equal(V.validateManifest([]).ok, false);
  assert.equal(V.validateManifest('x').ok, false);
});

test('id: must be reverse-DNS with at least three segments', () => {
  expectError(minimalManifest({ id: 'hello' }), 'id', 'PATTERN');
  expectError(minimalManifest({ id: 'example.hello' }), 'id', 'PATTERN');
  expectError(minimalManifest({ id: 'Net.Example.Hello' }), 'id', 'PATTERN');
  expectError(minimalManifest({ id: 'net.example.hello.' }), 'id', 'PATTERN');
  expectError(minimalManifest({ id: undefined }), 'id', 'REQUIRED');
  assert.ok(V.validateManifest(minimalManifest({ id: 'com.acme-corp.backup-tools' })).ok);
});

test('version and engines.whm: semver rules', () => {
  expectError(minimalManifest({ version: '1.2' }), 'version', 'INVALID_SEMVER');
  expectError(minimalManifest({ version: 'v1.2.3.4' }), 'version', 'INVALID_SEMVER');
  assert.ok(V.validateManifest(minimalManifest({ version: '1.2.3-beta.1+build.5' })).ok);
  expectError(minimalManifest({ engines: { whm: 'latest' } }), 'engines.whm', 'INVALID_RANGE');
  expectError(minimalManifest({ engines: { whm: '>=1 <' } }), 'engines.whm', 'INVALID_RANGE');
  expectError(minimalManifest({ engines: {} }), 'engines.whm', 'REQUIRED');
  expectError(minimalManifest({ engines: undefined }), 'engines', 'REQUIRED');
  for (const r of ['^1.0.0', '~1.2', '>=1.0.0 <2.0.0', '1.x', '*', '1.0.0 - 1.5.0', '^1 || ^2']) {
    assert.ok(V.validateManifest(minimalManifest({ engines: { whm: r } })).ok, r);
  }
});

test('required scalar fields and author shape', () => {
  expectError(minimalManifest({ name: '' }), 'name', 'REQUIRED');
  expectError(minimalManifest({ description: undefined }), 'description', 'REQUIRED');
  expectError(minimalManifest({ license: undefined }), 'license', 'REQUIRED');
  expectError(minimalManifest({ author: { name: 'x', email: 'nope' } }), 'author.email', 'PATTERN');
  expectError(minimalManifest({ author: { name: 'x', url: 'ftp://x' } }), 'author.url', 'PATTERN');
  expectError(minimalManifest({ author: { email: 'a@b.co' } }), 'author.name', 'REQUIRED');
  expectError(minimalManifest({ homepage: 'not a url' }), 'homepage', 'PATTERN');
});

test('main: must be a relative .js path without traversal', () => {
  expectError(minimalManifest({ main: undefined }), 'main', 'REQUIRED');
  expectError(minimalManifest({ main: '/abs/main.js' }), 'main', 'PATTERN');
  expectError(minimalManifest({ main: '../main.js' }), 'main', 'PATTERN');
  expectError(minimalManifest({ main: 'main.ts' }), 'main', 'PATTERN');
  expectError(minimalManifest({ main: 42 }), 'main', 'REQUIRED');
  assert.ok(V.validateManifest(minimalManifest({ main: 'src/index.cjs' })).ok);
});

test('permissions: required array, known scopes only, no duplicates', () => {
  expectError(minimalManifest({ permissions: undefined }), 'permissions', 'REQUIRED');
  expectError(minimalManifest({ permissions: 'jobs' }), 'permissions', 'TYPE');
  expectError(minimalManifest({ permissions: ['root'] }), 'permissions[0]', 'UNKNOWN_PERMISSION');
  expectError(minimalManifest({ permissions: ['agent:op:shell.exec'] }), 'permissions[0]', 'UNKNOWN_PERMISSION');
  expectError(minimalManifest({ permissions: ['jobs', 'jobs'] }), 'permissions[1]', 'DUPLICATE');
});

test('hooks: known events, valid stages, plugin-namespaced events post-only', () => {
  const base = (hooks) => minimalManifest({ hooks });
  expectError(base([{ event: 'account.exploded', handler: 'h' }]), 'hooks[0].event', 'UNKNOWN_EVENT');
  expectError(base([{ event: 'backup.completed', stage: 'pre', handler: 'h' }]), 'hooks[0].stage', 'INVALID_STAGE');
  expectError(base([{ event: 'account.created', stage: 'during', handler: 'h' }]), 'hooks[0].stage', 'INVALID_STAGE');
  expectError(base([{ event: 'account.created', handler: 'not valid' }]), 'hooks[0].handler', 'PATTERN');
  expectError(base([{ event: 'account.created', handler: 'h' }, { event: 'account.created', stage: 'post', handler: 'h' }]), 'hooks[1]', 'DUPLICATE');
  expectError(base([{ event: 'net.example.other.done', stage: 'pre', handler: 'h' }]), 'hooks[0].stage', 'INVALID_STAGE');
  expectError(base([{ event: 'account.created', handler: 'h', extra: 1 }]), 'hooks[0].extra', 'UNKNOWN_KEY');
  assert.ok(V.validateManifest(base([{ event: 'net.example.other.done', handler: 'h' }])).ok);
  assert.ok(V.validateManifest(base([{ event: 'service.restarted', stage: 'pre', handler: 'h' }])).ok);
});

test('settings: schema shape, select options, defaults, secrets, permission', () => {
  const withFields = (fields, perms = ['settings:own']) => minimalManifest({ permissions: perms, settings: { fields } });
  expectError(withFields([{ key: 'mode', type: 'select', label: 'Mode' }]), 'settings.fields[0].options', 'REQUIRED');
  expectError(withFields([{ key: 'Bad-Key', type: 'text', label: 'x' }]), 'settings.fields[0].key', 'PATTERN');
  expectError(withFields([{ key: 'k', type: 'colour', label: 'x' }]), 'settings.fields[0].type', 'UNKNOWN_SETTING_TYPE');
  expectError(withFields([{ key: 'k', type: 'number', label: 'x', default: 'ten' }]), 'settings.fields[0].default', 'INVALID_DEFAULT');
  expectError(withFields([{ key: 'k', type: 'number', label: 'x', min: 5, max: 1 }]), 'settings.fields[0].min', 'RANGE');
  expectError(withFields([{ key: 'k', type: 'cron', label: 'x', default: 'every day' }]), 'settings.fields[0].default', 'INVALID_DEFAULT');
  expectError(withFields([{ key: 'pw', type: 'password', label: 'x', default: 'hunter2' }]), 'settings.fields[0].default', 'SECRET_DEFAULT');
  expectError(withFields([{ key: 'k', type: 'text', label: 'x' }, { key: 'k', type: 'text', label: 'y' }]), 'settings.fields[1].key', 'DUPLICATE');
  expectError(withFields([{ key: 'k', type: 'text', label: 'x', weird: 1 }]), 'settings.fields[0].weird', 'UNKNOWN_KEY');
  expectError(withFields([{ key: 'k', type: 'text', label: 'x' }], []), 'settings', 'MISSING_PERMISSION');
  expectError(withFields([{ key: 'k', type: 'text', label: 'x', pattern: '(' }]), 'settings.fields[0].pattern', 'PATTERN');
  expectError(withFields([{ key: 'k', type: 'text', label: 'x', options: [] }]), 'settings.fields[0].options', 'UNEXPECTED');
  assert.ok(V.validateManifest(withFields([{ key: 'k', type: 'multiselect', label: 'x', default: ['a'], options: [{ value: 'a', label: 'A' }] }])).ok);
});

test('settings group reference must exist', () => {
  const m = minimalManifest({ permissions: ['settings:own'], settings: { groups: [{ id: 'g', label: 'G' }], fields: [{ key: 'k', type: 'text', label: 'x', group: 'other' }] } });
  expectError(m, 'settings.fields[0].group', 'UNKNOWN_GROUP');
});

test('jobs and cron: names, references, cron syntax, setting references, permissions', () => {
  expectError(minimalManifest({ permissions: ['jobs'], jobs: { 'Bad Name': { label: 'x' } } }), 'jobs.Bad Name', 'PATTERN');
  expectError(minimalManifest({ permissions: ['jobs'], jobs: { ok: {} } }), 'jobs.ok.label', 'REQUIRED');
  expectError(minimalManifest({ permissions: ['jobs'], jobs: { ok: { label: 'x', timeoutSec: 0 } } }), 'jobs.ok.timeoutSec', 'RANGE');
  expectError(minimalManifest({ permissions: [], jobs: { ok: { label: 'x' } } }), 'jobs', 'MISSING_PERMISSION');
  const withCron = (cronEntries, extra = {}) => minimalManifest({
    permissions: ['jobs', 'schedule', 'settings:own'],
    jobs: { sync: { label: 'Sync' } },
    settings: { fields: [{ key: 'when', type: 'cron', label: 'When', default: '@daily' }, { key: 'txt', type: 'text', label: 'T' }] },
    cron: cronEntries,
    ...extra,
  });
  expectError(withCron([{ name: 'a', job: 'sync', schedule: '* * * *' }]), 'cron[0].schedule', 'INVALID_CRON');
  expectError(withCron([{ name: 'a', job: 'sync', schedule: '61 * * * *' }]), 'cron[0].schedule', 'INVALID_CRON');
  expectError(withCron([{ name: 'a', job: 'nope', schedule: '@daily' }]), 'cron[0].job', 'UNKNOWN_JOB');
  expectError(withCron([{ name: 'a', job: 'sync', schedule: 'setting:missing' }]), 'cron[0].schedule', 'UNKNOWN_SETTING');
  expectError(withCron([{ name: 'a', job: 'sync', schedule: 'setting:txt' }]), 'cron[0].schedule', 'INVALID_SETTING_TYPE');
  expectError(withCron([{ name: 'a', job: 'sync', schedule: '@daily' }, { name: 'a', job: 'sync', schedule: '@hourly' }]), 'cron[1].name', 'DUPLICATE');
  expectError(withCron([{ name: 'a', job: 'sync', schedule: '@daily' }], { permissions: ['jobs', 'settings:own'] }), 'cron', 'MISSING_PERMISSION');
  assert.ok(V.validateManifest(withCron([{ name: 'a', job: 'sync', schedule: 'setting:when' }, { name: 'b', job: 'sync', schedule: '*/15 2-4 * jan-mar mon,fri' }])).ok);
});

test('ui: category must be one of the 30 categories; sidebar routes must match a page; permissions', () => {
  const ui = (sidebar, pages, perms = ['ui:sidebar']) => minimalManifest({ permissions: perms, ui: { sidebar, pages } });
  const page = { route: '/', title: 'Home', kind: 'markdown', content: '# hi' };
  expectError(ui([{ category: 'Hacks', label: 'x', route: '/', icon: 'zap' }], [page]), 'ui.sidebar[0].category', 'UNKNOWN_CATEGORY');
  expectError(ui([{ category: 'Backup', label: 'x', route: '/nope', icon: 'zap' }], [page]), 'ui.sidebar[0].route', 'UNKNOWN_ROUTE');
  expectError(ui([{ category: 'Backup', label: 'x', route: '/', icon: 'Zap!' }], [page]), 'ui.sidebar[0].icon', 'PATTERN');
  expectError(ui([{ category: 'Backup', label: 'x', route: '/', icon: 'zap' }], [page], []), 'ui.sidebar', 'MISSING_PERMISSION');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'widget' }]), 'ui.pages[0].kind', 'UNKNOWN_PAGE_KIND');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'table' }]), 'ui.pages[0].source', 'REQUIRED');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'table', source: '/rows' }]), 'ui.pages[0]', 'MISSING_PERMISSION');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'settings' }]), 'ui.pages[0].kind', 'NO_SETTINGS');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'action', job: 'nope' }], ['ui:sidebar', 'jobs']), 'ui.pages[0].job', 'UNKNOWN_JOB');
  expectError(ui([], [{ route: '/x', title: 'X', kind: 'html', file: '../../etc/passwd.html' }]), 'ui.pages[0].file', 'REQUIRED');
  expectError(ui([], [{ route: 'x', title: 'X', kind: 'markdown', content: 'c' }]), 'ui.pages[0].route', 'PATTERN');
  expectError(ui([], [page, page]), 'ui.pages[1].route', 'DUPLICATE');
  for (const cat of V.CATEGORIES) {
    assert.ok(V.validateManifest(ui([{ category: cat, label: 'x', route: '/', icon: 'zap' }], [page])).ok, cat);
  }
});

test('unknown top-level keys, isolation, i18n, keywords', () => {
  expectError(minimalManifest({ bogus: true }), '.bogus', 'UNKNOWN_KEY');
  expectError(minimalManifest({ isolation: 'vm' }), 'isolation', 'UNKNOWN_ISOLATION');
  expectError(minimalManifest({ i18n: { default: 'english' } }), 'i18n.default', 'PATTERN');
  expectError(minimalManifest({ keywords: new Array(11).fill('k') }), 'keywords', 'TYPE');
  assert.ok(V.validateManifest(minimalManifest({ isolation: 'process', i18n: { default: 'pt-BR' }, $schema: 'x' })).ok);
});

test('validateSettingValue covers every type', () => {
  const ok = (f, v) => assert.equal(V.validateSettingValue(f, v).ok, true, JSON.stringify([f, v]));
  const bad = (f, v) => assert.equal(V.validateSettingValue(f, v).ok, false, JSON.stringify([f, v]));
  ok({ key: 't', type: 'text' }, 'x'); bad({ key: 't', type: 'text' }, 1); bad({ key: 't', type: 'text', maxLength: 1 }, 'xx');
  bad({ key: 't', type: 'text', pattern: '^a' }, 'b'); ok({ key: 't', type: 'text', required: false }, '');
  bad({ key: 't', type: 'text', required: true }, '');
  ok({ key: 'n', type: 'number', min: 1 }, 1); bad({ key: 'n', type: 'number', min: 1 }, 0); bad({ key: 'n', type: 'number', integer: true }, 1.5); bad({ key: 'n', type: 'number' }, NaN);
  ok({ key: 'b', type: 'toggle' }, false); bad({ key: 'b', type: 'toggle' }, 'false');
  const opts = [{ value: 'a', label: 'A' }];
  ok({ key: 's', type: 'select', options: opts }, 'a'); bad({ key: 's', type: 'select', options: opts }, 'z');
  ok({ key: 'm', type: 'multiselect', options: opts }, ['a']); bad({ key: 'm', type: 'multiselect', options: opts }, ['a', 'a']); bad({ key: 'm', type: 'multiselect', options: opts }, 'a');
  ok({ key: 'c', type: 'cron' }, '*/5 * * * *'); bad({ key: 'c', type: 'cron' }, 'soon');
  ok({ key: 'p', type: 'password' }, 'secret'); ok({ key: 'a', type: 'textarea' }, 'long');
});

test('manifest.schema.json enums match the validator constants', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const defs = schema.$defs;
  assert.deepEqual(defs.category.enum, [...V.CATEGORIES]);
  assert.deepEqual(defs.fixedPermission.enum, [...V.PERMISSION_SCOPES]);
  assert.deepEqual(defs.hostEvent.enum, [...V.EVENT_NAMES]);
  assert.deepEqual(defs.settingType.enum, [...V.SETTING_TYPES]);
  assert.deepEqual(defs.pageKind.enum, [...V.PAGE_KINDS]);
  assert.deepEqual(schema.properties.isolation.enum, [...V.ISOLATION_MODES]);
  assert.deepEqual(defs.hookStage.enum, [...V.HOOK_STAGES]);
  assert.equal(defs.agentOpPermission.pattern, V.AGENT_OP_SCOPE_PATTERN.source);
  assert.equal(defs.netOutboundPermission.pattern, V.NET_OUTBOUND_SCOPE_PATTERN.source);
  assert.equal(defs.pluginEvent.pattern, V.PLUGIN_EVENT_PATTERN.source);
  assert.equal(schema.properties.id.pattern, V.ID_PATTERN.source);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...V.TOP_LEVEL_KEYS].sort());
  assert.deepEqual(Object.keys(defs.settingField.properties).sort(), [...V.SETTING_FIELD_KEYS].sort());
  assert.deepEqual(Object.keys(defs.page.properties).sort(), [...V.PAGE_KEYS].sort());
  assert.equal(schema.additionalProperties, false);
});
