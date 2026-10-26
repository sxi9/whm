import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createNetworkingSetupService, MAX_RESOLVERS } from '../../services/networking-setup.js';

// Search domains may be a single label (e.g. "localdomain"), unlike fields.hostname.
const searchDomain = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Must be a valid domain name');
// The service applies WHM's stricter rules (three labels, no "www", not reserved).
const hostnameInput = z.string().trim().toLowerCase().min(1, 'A hostname is required').max(253).regex(/^[a-z0-9.-]+$/, 'Hostnames use letters, digits, "." and "-" only');

const hostnameBody = z.object({
  hostname: hostnameInput,
  ip: fields.ipv4.optional(),
  ipv6: fields.ipv6.optional(),
  updateHosts: z.boolean().default(true),
  addDnsRecord: z.boolean().default(false),
  reissueServiceCerts: z.boolean().default(true),
}).strict();
const previewBody = z.object({ hostname: hostnameInput, ip: fields.ipv4.optional(), ipv6: fields.ipv6.optional() }).strict();
const defaultsBody = z.object({ updateHosts: z.boolean().optional(), addDnsRecord: z.boolean().optional() }).strict().refine((b) => b.updateHosts != null || b.addDnsRecord != null, 'Nothing to change');
const nameservers = z.array(fields.ip).min(1, 'At least one nameserver is required').max(MAX_RESOLVERS, `At most ${MAX_RESOLVERS} nameservers (the resolver library ignores the rest)`);
const resolversBody = z.object({
  nameservers,
  search: z.array(searchDomain).max(6).default([]),
  applyToDns: z.boolean().default(true),
  mode: z.enum(['auto', 'file', 'resolved']).default('auto'),
  test: z.boolean().default(true),
}).strict();
const testBody = z.object({ nameservers: z.array(fields.ip).max(8).optional(), names: z.array(fields.hostname).min(1).max(5).optional() }).strict();
const historyQuery = z.object({ kind: z.enum(['hostname', 'resolvers']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export async function register(ctx) {
  ctx.networking = createNetworkingSetupService(ctx);
  const s = ctx.networking;
  ctx.capabilities.register('hostnamectl', { binaries: ['hostnamectl'], required: ['hostnamectl'] });
  ctx.capabilities.register('resolvectl', { binaries: ['resolvectl', 'systemd-resolve'], required: ['resolvectl', 'systemd-resolve'] });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);

  // Change Hostname
  r.get('/hostname', requireRoot, wrap(() => s.hostnameStatus()));
  r.post('/hostname/preview', requireRoot, validate({ body: previewBody }), wrap((req) => s.previewHostname(req.body)));
  r.post('/hostname', requireRoot, validate({ body: hostnameBody }), wrap((req) => s.setHostname(req.body, req)));
  r.put('/hostname/defaults', requireRoot, validate({ body: defaultsBody }), wrap((req) => s.setHostnameDefaults(req.body, req)));

  // Resolver Configuration
  r.get('/resolvers', requireRoot, wrap(() => s.resolverStatus()));
  r.put('/resolvers', requireRoot, validate({ body: resolversBody }), wrap((req) => s.setResolvers(req.body, req)));
  r.post('/resolvers/test', requireRoot, validate({ body: testBody }), wrap((req) => s.testResolvers(req.body)));

  r.get('/history', requireRoot, validate({ query: historyQuery }), wrap((req) => s.history(req.query)));

  return { path: '/networking', router: r };
}
