import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireScope } from '../../middleware/rbac.js';
import { forbidden } from '../../lib/errors.js';
import { createClustersService, PEER_ROLES, GROUP_NAMES, EVENT_KINDS, PEER_HOST_RE, PUSH_JOB, PUSH_SCHEDULE, CLUSTER_SCOPE } from '../../services/clusters.js';

const idParam = z.object({ id: fields.id });
const nonEmpty = (schema) => schema.refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change', path: ['_'] });
const peerName = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Letters, digits, spaces, ".", "_" or "-"');
const peerHost = z.string().trim().min(1).max(260).regex(PEER_HOST_RE, 'Must be a hostname or IP, optionally with http(s):// and a port');
const peerToken = z.string().trim().min(16, 'API tokens are at least 16 characters').max(512).regex(/^[A-Za-z0-9_.-]+$/, 'Not a valid API token');
const group = z.enum(GROUP_NAMES);
const groupList = z.array(group).max(GROUP_NAMES.length);
const settingKey = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+){1,5}$/, 'Setting keys look like "dns.default_ttl"');
const settingValue = z.union([z.string().max(20_000), z.number(), z.boolean(), z.null(), z.array(z.any()).max(1000), z.record(z.any())]);
const source = z.string().trim().max(260).regex(/^[^\s\0]*$/, 'No whitespace').optional();
const createPeer = z.object({ name: peerName, host: peerHost, token: peerToken, role: z.enum(PEER_ROLES).default('sync'), enabled: z.boolean().optional(), verifyTls: z.boolean().optional(), configEnabled: z.boolean().optional() }).strict();
const updatePeer = nonEmpty(z.object({ name: peerName.optional(), host: peerHost.optional(), token: peerToken.optional(), role: z.enum(PEER_ROLES).optional(), enabled: z.boolean().optional(), verifyTls: z.boolean().optional(), configEnabled: z.boolean().optional() }).strict());
const createToken = z.object({ name: peerName, description: z.string().trim().max(200).regex(/^[^\r\n\0]*$/).optional(), expiresInDays: z.number().int().min(1).max(3650).optional() }).strict();
const eventsQuery = z.object({ page: fields.page, pageSize: fields.pageSize, q: z.string().trim().max(100).optional(), kind: z.enum(EVENT_KINDS).optional(), status: z.enum(['ok', 'failed', 'skipped']).optional(), clusterId: fields.id.optional(), sort: z.enum(['ts', 'kind', 'status', 'peer']).optional(), dir: z.enum(['asc', 'desc']).default('desc') });
const dnsSettings = nonEmpty(z.object({ verifyTls: z.boolean().optional(), autoSync: z.boolean().optional(), acceptPushes: z.boolean().optional() }).strict());
const dnsSync = z.object({ domains: z.array(fields.domain).min(1).max(500).optional(), clusterId: fields.id.optional() }).strict();
const zoneBody = z.string().min(1).max(512 * 1024).regex(/^[^\0]*$/);
const dnsReceive = z.object({ domain: fields.domain, body: zoneBody, serial: z.number().int().min(0).optional(), source }).strict();
const configSettings = nonEmpty(z.object({ groups: groupList.optional(), autoPush: z.boolean().optional(), acceptPushes: z.boolean().optional() }).strict());
const configExportQuery = z.object({ groups: z.string().max(400).regex(/^[a-z_,]*$/).optional() });
const configReceive = z.object({ source, groups: groupList.optional(), settings: z.record(settingKey, settingValue).refine((s) => Object.keys(s).length <= 500, 'At most 500 settings per push') }).strict();
const configPush = z.object({ clusterIds: z.array(fields.id).min(1).max(100).optional(), groups: groupList.min(1).optional() }).strict();
const configPull = z.object({ clusterId: fields.id, groups: groupList.min(1).optional(), apply: z.boolean().default(false) }).strict();

export async function register(ctx) {
  ctx.clusters = createClustersService(ctx);
  const s = ctx.clusters;
  // Scheduled pushes honour the toggle; a manual push ({ manual }) always runs.
  ctx.jobs.register(PUSH_JOB, async (job) => {
    if (!job.params?.manual && !ctx.settings.get('clusters.config.auto_push', false)) { job.log('automatic configuration pushes are disabled; nothing pushed'); return { skipped: 'disabled' }; }
    return s.config.runPush(job);
  });
  ctx.scheduler.ensure(PUSH_SCHEDULE, '35 */6 * * *', PUSH_JOB);
  if (!ctx.settings.get('clusters.config.auto_push', false)) ctx.scheduler.update(PUSH_SCHEDULE, { enabled: false });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const peerScope = requireScope(CLUSTER_SCOPE);
  // Within this router a cluster token reaches the peer endpoints only; the
  // management routes are for sessions and unscoped root tokens. (Outside this
  // router the token is not confined: see TOKEN_ACCESS_NOTE.)
  const isClusterToken = (req) => req.auth?.via === 'token' && Array.isArray(req.auth.scopes) && req.auth.scopes.length > 0 && !req.auth.scopes.includes('*') && req.auth.scopes.includes(CLUSTER_SCOPE);
  const peersOnly = (req, _res, next) => (isClusterToken(req) ? next(forbidden('A cluster token may only use the peer endpoints (ping, dns/receive, config/export, config/receive)')) : next());
  r.use((req, res, next) => (['/ping', '/dns/receive', '/config/export', '/config/receive'].includes(req.path) ? next() : peersOnly(req, res, next)));

  // Shared: peers, tokens issued for remote panels, exchange log
  r.get('/ping', requireRoot, peerScope, wrap(() => s.identity()));
  r.get('/peers', requireRoot, wrap(() => s.peers.list()));
  r.post('/peers', requireRoot, validate({ body: createPeer }), wrap((req) => s.peers.create(req.body, req), 201));
  r.get('/peers/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.peers.get(req.params.id)));
  r.patch('/peers/:id', requireRoot, validate({ params: idParam, body: updatePeer }), wrap((req) => s.peers.update(req.params.id, req.body, req)));
  r.delete('/peers/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.peers.remove(req.params.id, req)));
  r.post('/peers/:id/test', requireRoot, validate({ params: idParam }), wrap((req) => s.peers.test(req.params.id, req)));
  r.get('/tokens', requireRoot, wrap(() => s.tokens.list()));
  r.post('/tokens', requireRoot, validate({ body: createToken }), wrap((req) => s.tokens.create(req.body, req.user, req), 201));
  r.delete('/tokens/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.tokens.revoke(req.params.id, req)));
  r.get('/events', requireRoot, validate({ query: eventsQuery }), wrap((req) => s.events.list(req.query)));

  // DNS Cluster
  r.get('/dns', requireRoot, wrap(() => s.dns.overview()));
  r.put('/dns/settings', requireRoot, validate({ body: dnsSettings }), wrap((req) => s.dns.updateSettings(req.body, req)));
  r.post('/dns/sync', requireRoot, validate({ body: dnsSync }), wrap((req) => s.dns.sync(req.body, req.user), 202));
  r.post('/dns/receive', requireRoot, peerScope, validate({ body: dnsReceive }), wrap((req) => s.dns.receive(req.body, req.user, req)));

  // Configuration Cluster
  r.get('/config', requireRoot, wrap(() => s.config.overview()));
  r.put('/config/settings', requireRoot, validate({ body: configSettings }), wrap((req) => s.config.updateSettings(req.body, req)));
  r.get('/config/export', requireRoot, peerScope, validate({ query: configExportQuery }), wrap((req) => s.config.export(req.query.groups ? req.query.groups.split(',').filter(Boolean) : null, req)));
  r.post('/config/receive', requireRoot, peerScope, validate({ body: configReceive }), wrap((req) => s.config.receive(req.body, req)));
  r.post('/config/push', requireRoot, validate({ body: configPush }), wrap((req) => s.config.enqueuePush(req.body, req.user), 202));
  r.post('/config/pull', requireRoot, validate({ body: configPull }), wrap((req) => s.config.pull(req.body, req)));

  // The DNS module's sync job pushes zones to /api/dns/zones/import, so the
  // "Accept zones pushed by peers" toggle is enforced in front of that route
  // as well (the DNS module can also call ctx.clusters.dns.guardImport itself).
  const importGuard = Router();
  importGuard.post('/', (req, _res, next) => { try { s.dns.guardImport(req); next(); } catch (err) { next(err); } });

  return [{ path: '/clusters', router: r }, { path: '/dns/zones/import', router: importGuard }];
}
