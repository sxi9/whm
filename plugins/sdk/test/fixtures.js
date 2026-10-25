'use strict';

/** Shared test fixtures: a fully featured, valid manifest and a matching plugin module. */

function fullManifest(overrides = {}) {
  return {
    id: 'net.example.hello',
    name: 'Hello Plugin',
    version: '1.2.3',
    description: 'Exercises every part of the SDK contract.',
    author: { name: 'Example Dev', email: 'dev@example.net', url: 'https://example.net' },
    license: 'MIT',
    homepage: 'https://example.net/hello',
    engines: { whm: '^1.0.0' },
    main: 'main.js',
    permissions: [
      'accounts:read', 'accounts:write', 'packages:read', 'dns:read',
      'backups:read', 'backups:write', 'backups:restore',
      'settings:own', 'store:own', 'schedule', 'jobs', 'events:emit',
      'ui:sidebar', 'api:routes', 'contacts:notify', 'system:read', 'audit:write',
      'crypto:own', 'fs:own',
      'agent:op:svc.status', 'net:outbound:api.example.net', 'net:outbound:*.storage.example.net:8443',
    ],
    hooks: [
      { event: 'account.created', stage: 'pre', handler: 'beforeAccountCreated' },
      { event: 'account.created', handler: 'afterAccountCreated' },
      { event: 'backup.completed', handler: 'onBackupCompleted' },
    ],
    settings: {
      groups: [{ id: 'general', label: 'General' }],
      fields: [
        { key: 'greeting', type: 'text', label: 'Greeting', default: 'hello', group: 'general', maxLength: 32 },
        { key: 'retries', type: 'number', label: 'Retries', default: 3, min: 0, max: 10, integer: true },
        { key: 'mode', type: 'select', label: 'Mode', default: 'fast', options: [{ value: 'fast', label: 'Fast' }, { value: 'safe', label: 'Safe' }] },
        { key: 'targets', type: 'multiselect', label: 'Targets', default: ['a'], options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        { key: 'enabled', type: 'toggle', label: 'Enabled', default: true },
        { key: 'apiKey', type: 'password', label: 'API key' },
        { key: 'schedule', type: 'cron', label: 'Schedule', default: '0 2 * * *' },
        { key: 'notes', type: 'textarea', label: 'Notes', required: false },
      ],
    },
    jobs: {
      nightly: { label: 'Nightly run', description: 'Does the nightly thing', timeoutSec: 3600, cancellable: true },
      locked: { label: 'Locked', cancellable: false },
    },
    cron: [
      { name: 'nightly-run', job: 'nightly', schedule: 'setting:schedule', params: { source: 'cron' } },
      { name: 'hourly-ping', job: 'nightly', schedule: '0 * * * *', params: { source: 'hourly' }, enabled: false },
    ],
    ui: {
      sidebar: [{ category: 'Plugins', label: 'Hello', route: '/', icon: 'hand' }],
      pages: [
        { route: '/', title: 'Hello', kind: 'table', source: '/items', columns: [{ key: 'id', label: 'ID' }] },
        { route: '/settings', title: 'Settings', kind: 'settings' },
        { route: '/run', title: 'Run now', kind: 'action', job: 'nightly', confirm: true },
      ],
    },
    i18n: { default: 'en', dir: 'locales' },
    keywords: ['example'],
    ...overrides,
  };
}

/** Minimal valid manifest with no permissions. */
function minimalManifest(overrides = {}) {
  return {
    id: 'net.example.minimal',
    name: 'Minimal',
    version: '0.1.0',
    description: 'Smallest valid manifest.',
    author: { name: 'Dev' },
    license: 'MIT',
    engines: { whm: '>=1.0.0' },
    main: 'main.js',
    permissions: [],
    ...overrides,
  };
}

function fullModule(spy = {}) {
  const calls = spy.calls || (spy.calls = []);
  return {
    async activate(ctx) {
      calls.push('activate');
      ctx.log.info('activated', { version: ctx.plugin.version });
    },
    async deactivate() { calls.push('deactivate'); },
    async migrate(ctx, from) { calls.push(`migrate:${from}`); },
    hooks: {
      async beforeAccountCreated(evt, ctx) {
        calls.push(`pre:${evt.name}:${evt.payload.username}`);
        if (evt.payload.username === 'blocked') evt.cancel('username is blocked');
      },
      async afterAccountCreated(evt) { calls.push(`post:${evt.name}:${evt.payload.username}`); },
      async onBackupCompleted(evt) { calls.push(`post:${evt.name}:${evt.payload.account}`); },
    },
    jobs: {
      async nightly(job, ctx) {
        calls.push(`job:nightly:${JSON.stringify(job.params)}`);
        job.progress(50, 'halfway');
        await ctx.store.set('lastRun', ctx.now());
        return { ran: true, at: ctx.now() };
      },
      async locked(job) { calls.push('job:locked'); return null; },
    },
    routes(router) {
      router.get('/items', async (req, res) => res.json([{ id: 1 }]));
      router.get('/items/:id', async (req, res) => res.json({ id: req.params.id, q: req.query.q }));
      router.post('/items', { roles: ['root', 'reseller'] }, async (req, res) => res.status(201).json(req.body));
      router.get('/boom', async () => { throw new Error('kaboom'); });
      router.get('/missing', async (req, res, ) => { throw new (require('../errors').NotFoundError)('item', 'x'); });
    },
  };
}

module.exports = { fullManifest, minimalManifest, fullModule };
