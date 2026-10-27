import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createDnsService } from '../../services/dns-functions.js';

const domainParam = z.object({ domain: fields.domain });
const recordParam = z.object({ domain: fields.domain, id: fields.id });
const templateName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Lowercase letters, digits, "_" or "-"; max 40 chars');
const ttl = z.coerce.number().int().min(0).max(2147483647);
// null / '' means "inherit $TTL"; z.null() goes first because the coerce
// branch would turn null into 0.
const recordTtl = z.preprocess((v) => (v === '' ? null : v), z.union([z.null(), ttl, z.string().regex(/^\d+[smhdw]?$/)]));
const recordBody = z.object({
  name: z.string().trim().max(253).default('@'),
  type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR']),
  ttl: recordTtl.optional(),
  priority: z.number().int().min(0).max(65535).nullable().optional(),
  value: z.string().trim().min(1).max(4096),
});
const zoneBody = z.string().max(2 * 1024 * 1024);
const domainList = z.array(fields.domain).min(1).max(500);

export async function register(ctx) {
  ctx.dns = createDnsService(ctx);
  ctx.jobs.register('dns.sync', (job) => ctx.dns.runSync(job));
  ctx.jobs.register('dns.email_auth_all', (job) => ctx.dns.runEmailAuthAll(job));
  ctx.jobs.register('dns.resign', (job) => ctx.dns.runResign(job));
  ctx.scheduler.ensure('dns-cluster-sync', '20 * * * *', 'dns.sync');
  ctx.scheduler.ensure('dns-resign', '15 3 * * *', 'dns.resign');
  ctx.capabilities.register('bind', { binaries: ['named', 'rndc', 'named-checkzone', 'named-checkconf', 'dnssec-keygen', 'dnssec-signzone'], required: ['named'] });

  const r = Router();
  const wrap = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(status).json(d?.meta ? d : { data: d })).catch(next);
  const dns = () => ctx.dns;

  // Zones ---------------------------------------------------------------------
  r.get('/zones', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional(), orphans: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => dns().listZones(req.query, req.user)));
  r.post('/zones', requireReseller, validate({ body: z.object({ domain: fields.domain, ip: fields.ip.optional(), template: templateName.optional(), account: fields.username.optional(), ttl: ttl.optional() }).strict() }),
    wrap((req) => dns().createZone(req.body, req.user, req), 201));
  // Peer pushes land here with an API token; the Clusters category's "accept
  // pushes" toggle and exchange log apply through its guard when it is loaded.
  r.post('/zones/import', requireRoot, validate({ body: z.object({ domain: fields.domain, body: zoneBody, serial: z.number().int().optional() }).strict() }),
    wrap(async (req) => { await ctx.clusters?.dns?.guardImport?.(req); return dns().importZone(req.body, req.user, req); }));
  r.post('/zones/ttl', requireReseller, validate({ body: z.object({ domains: domainList, ttl }).strict() }),
    wrap((req) => dns().setTtlBulk(req.body.domains, req.body.ttl, req.user, req)));
  r.get('/zones/:domain', requireReseller, validate({ params: domainParam }), wrap((req) => dns().getZone(req.params.domain, req.user)));
  r.delete('/zones/:domain', requireReseller, validate({ params: domainParam }), wrap((req) => dns().deleteZone(req.params.domain, req.user, req)));
  r.get('/zones/:domain/raw', requireReseller, validate({ params: domainParam }), wrap((req) => dns().rawZone(req.params.domain, req.user)));
  r.put('/zones/:domain/raw', requireReseller, validate({ params: domainParam, body: z.object({ body: zoneBody }).strict() }),
    wrap((req) => dns().saveRawZone(req.params.domain, req.body.body, req.user, req)));
  r.post('/zones/:domain/validate', requireReseller, validate({ params: domainParam, body: z.object({ body: zoneBody }).strict() }),
    wrap((req) => dns().validateZone(req.params.domain, req.body.body, req.user)));
  r.post('/zones/:domain/apply', requireReseller, validate({ params: domainParam }), wrap((req) => dns().applyZone(req.params.domain, req.user, req)));
  r.put('/zones/:domain/ttl', requireReseller, validate({ params: domainParam, body: z.object({ ttl }).strict() }),
    wrap((req) => dns().setTtl(req.params.domain, req.body.ttl, req.user, req)));
  r.put('/zones/:domain/soa', requireReseller, validate({ params: domainParam, body: z.object({
    primary: fields.hostname.optional(), hostmaster: fields.hostname.optional(),
    refresh: ttl.optional(), retry: ttl.optional(), expire: ttl.optional(), minimum: ttl.optional(),
  }).strict() }), wrap((req) => dns().setSoa(req.params.domain, req.body, req.user, req)));
  r.get('/zones/:domain/dnssec', requireRoot, validate({ params: domainParam }), wrap((req) => dns().dnssecStatus(req.params.domain, req.user)));
  r.put('/zones/:domain/dnssec', requireRoot, validate({ params: domainParam, body: z.object({ enabled: z.boolean() }).strict() }),
    wrap((req) => dns().setDnssec(req.params.domain, req.body.enabled, req.user, req)));

  // Records -------------------------------------------------------------------
  r.post('/zones/:domain/records', requireReseller, validate({ params: domainParam, body: recordBody.strict() }),
    wrap((req) => dns().addRecord(req.params.domain, req.body, req.user, req), 201));
  r.put('/zones/:domain/records/:id', requireReseller, validate({ params: recordParam, body: recordBody.partial().strict() }),
    wrap((req) => dns().updateRecord(req.params.domain, req.params.id, req.body, req.user, req)));
  r.delete('/zones/:domain/records/:id', requireReseller, validate({ params: recordParam }),
    wrap((req) => dns().deleteRecord(req.params.domain, req.params.id, req.user, req)));

  // Email DNS (SPF / DKIM / DMARC) --------------------------------------------
  r.get('/email', requireReseller, wrap((req) => dns().emailOverview(req.user)));
  r.post('/email/enable-all', requireRoot, validate({ body: z.object({ dkim: z.boolean().optional(), spf: z.boolean().optional(), dmarc: z.boolean().optional(), domains: domainList.optional() }).strict() }),
    wrap((req) => dns().enableEmailAuthAll(req.body, req.user), 202));
  r.get('/zones/:domain/email', requireReseller, validate({ params: domainParam }), wrap((req) => dns().emailStatus(req.params.domain, req.user)));
  r.put('/zones/:domain/email/spf', requireReseller, validate({ params: domainParam, body: z.object({ value: z.string().trim().max(1024).optional() }).strict() }),
    wrap((req) => dns().setSpf(req.params.domain, req.body, req.user, req)));
  r.post('/zones/:domain/email/dkim', requireReseller, validate({ params: domainParam, body: z.object({ selector: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(), bits: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).optional(), rotate: z.boolean().optional() }).strict() }),
    wrap((req) => dns().ensureDkim(req.params.domain, req.body, req.user, req)));
  r.delete('/zones/:domain/email/dkim', requireReseller, validate({ params: domainParam }), wrap((req) => dns().removeDkim(req.params.domain, req.user, req)));
  r.put('/zones/:domain/email/dmarc', requireReseller, validate({ params: domainParam, body: z.object({
    value: z.string().trim().max(1024).optional(),
    p: z.enum(['none', 'quarantine', 'reject']).optional(), sp: z.enum(['none', 'quarantine', 'reject']).optional(),
    rua: z.string().trim().max(500).optional(), ruf: z.string().trim().max(500).optional(),
    pct: z.number().int().min(0).max(100).optional(), adkim: z.enum(['r', 's']).optional(), aspf: z.enum(['r', 's']).optional(),
  }).strict() }), wrap((req) => dns().setDmarc(req.params.domain, req.body, req.user, req)));

  // Email routing ---------------------------------------------------------------
  r.get('/routing', requireReseller, validate({ query: z.object({ account: fields.username.optional() }) }), wrap((req) => dns().listRouting(req.query, req.user)));
  r.put('/routing/:domain', requireReseller, validate({ params: domainParam, body: z.object({
    routing: z.enum(['local', 'remote', 'backup', 'auto']),
    exchanges: z.array(z.object({ priority: z.number().int().min(0).max(65535), exchange: fields.hostname }).strict()).max(20).optional(),
  }).strict() }), wrap((req) => dns().setRouting(req.params.domain, req.body, req.user, req)));

  // Hostname A entry ----------------------------------------------------------
  r.get('/hostname', requireRoot, wrap(() => dns().hostnameStatus()));
  r.post('/hostname', requireRoot, validate({ body: z.object({ ip: fields.ipv4.optional() }).strict() }), wrap((req) => dns().ensureHostnameA(req.body, req.user, req)));

  // Nameserver record report --------------------------------------------------
  r.get('/nameserver-report', requireReseller, validate({ query: z.object({ domain: fields.domain.optional(), limit: z.coerce.number().int().min(1).max(500).default(50) }) }),
    wrap((req) => dns().nameserverReport(req.query, req.user)));

  // Park a domain -------------------------------------------------------------
  r.get('/parked', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional() }) }), wrap((req) => dns().listParked(req.query, req.user)));
  r.post('/parked', requireReseller, validate({ body: z.object({ domain: fields.domain, account: fields.username, ip: fields.ip.optional(), createZone: z.boolean().optional() }).strict() }),
    wrap((req) => dns().parkDomain(req.body, req.user, req), 201));
  r.delete('/parked/:domain', requireReseller, validate({ params: domainParam, query: z.object({ removeZone: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }),
    wrap((req) => dns().unparkDomain(req.params.domain, req.query, req.user, req)));

  // DNS cleanup ---------------------------------------------------------------
  r.get('/cleanup', requireRoot, wrap(() => dns().cleanupReport()));
  r.post('/cleanup', requireRoot, validate({ body: z.object({ domains: domainList.optional(), all: z.boolean().optional(), republish: z.boolean().optional() }).strict() }),
    wrap((req) => dns().cleanup(req.body, req.user, req)));

  // Domain forwarding ---------------------------------------------------------
  r.get('/forwarding', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional() }) }), wrap((req) => dns().listForwarding(req.query, req.user)));
  r.put('/forwarding/:domain', requireReseller, validate({ params: domainParam, body: z.object({ targetUrl: z.string().trim().min(1).max(2048), type: z.enum(['permanent', 'temporary']).optional(), matchWww: z.boolean().optional(), keepPath: z.boolean().optional() }).strict() }),
    wrap((req) => dns().setForwarding(req.params.domain, req.body, req.user, req)));
  r.delete('/forwarding/:domain', requireReseller, validate({ params: domainParam }), wrap((req) => dns().removeForwarding(req.params.domain, req.user, req)));
  r.post('/forwarding/apply', requireRoot, wrap((req) => dns().applyForwarding(req.user, req)));

  // Zone templates --------------------------------------------------------------
  r.get('/templates', requireRoot, wrap(() => dns().listTemplates()));
  r.post('/templates', requireRoot, validate({ body: z.object({ name: templateName, body: zoneBody }).strict() }), wrap((req) => dns().saveTemplate(req.body.name, req.body.body, req, { create: true }), 201));
  r.get('/templates/:name', requireRoot, validate({ params: z.object({ name: templateName }) }), wrap((req) => dns().getTemplate(req.params.name)));
  r.put('/templates/:name', requireRoot, validate({ params: z.object({ name: templateName }), body: z.object({ body: zoneBody }).strict() }), wrap((req) => dns().saveTemplate(req.params.name, req.body.body, req)));
  r.delete('/templates/:name', requireRoot, validate({ params: z.object({ name: templateName }) }), wrap((req) => dns().deleteTemplate(req.params.name, req)));
  r.post('/templates/:name/preview', requireRoot, validate({ params: z.object({ name: templateName }), body: z.object({ domain: fields.domain.optional(), ip: fields.ip.optional() }).strict() }),
    wrap((req) => dns().previewTemplate(req.params.name, req.body)));

  // Cluster synchronisation ----------------------------------------------------
  r.get('/sync', requireRoot, wrap(() => dns().syncStatus()));
  r.post('/sync', requireRoot, validate({ body: z.object({ domains: domainList.optional(), clusterId: fields.id.optional() }).strict() }), wrap((req) => dns().enqueueSync(req.body, req.user), 202));

  return { path: '/dns', router: r };
}
