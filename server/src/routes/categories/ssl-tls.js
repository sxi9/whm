import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createSslService, SSL_SERVICES } from '../../services/ssl-tls.js';

const PEM_BODY = '[A-Za-z0-9+/=\\r\\n ]+';
const pemBlock = (label) => new RegExp(`^\\s*-----BEGIN ${label}-----\\r?\\n${PEM_BODY}-----END ${label}-----\\s*$`);
// Same labels as the agent's pem.key: passphrase-protected keys are refused here
// with a hint instead of making openssl prompt for a passphrase it cannot get.
const keyPem = z.string().max(64 * 1024).regex(pemBlock('(?:RSA |EC )?PRIVATE KEY'), 'Must be one unencrypted PEM private key (decrypt a passphrase-protected key first: openssl pkey -in key.pem -out plain.pem)');
const certPem = z.string().max(64 * 1024).regex(pemBlock('CERTIFICATE'), 'Must be one PEM certificate');
const csrPem = z.string().max(64 * 1024).regex(pemBlock('(?:NEW )?CERTIFICATE REQUEST'), 'Must be a PEM certificate signing request');
const chainPem = z.string().max(256 * 1024).regex(new RegExp(`^\\s*(?:-----BEGIN CERTIFICATE-----\\r?\\n${PEM_BODY}-----END CERTIFICATE-----\\s*)+$`), 'Must be one or more PEM certificates');

const HOST = '(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const certName = z.string().toLowerCase().regex(new RegExp(`^(\\*\\.)?${HOST}$`), 'Must be a hostname such as example.com or *.example.com');
const subjectValue = z.string().regex(/^(?![-\s])[A-Za-z0-9 .,'&()@_:-]{1,64}$/, 'Letters, digits, spaces and . , \' & ( ) @ _ : - only');
const subject = z.object({
  O: subjectValue.optional(), OU: subjectValue.optional(), L: subjectValue.optional(), ST: subjectValue.optional(),
  C: z.string().regex(/^[A-Z]{2}$/, 'Two-letter ISO country code').optional(), emailAddress: z.string().email().max(128).optional(),
}).strict();
const keySpec = z.object({ type: z.enum(['rsa', 'ec']).optional(), bits: z.number().int().refine((b) => [2048, 3072, 4096].includes(b), 'RSA keys must be 2048, 3072 or 4096 bits').optional(), curve: z.enum(['prime256v1', 'secp384r1']).optional() }).strict();
const generateBody = z.object({ account: fields.username.optional(), domain: fields.hostname, sans: z.array(certName).max(100).default([]), key: keySpec.default({}), subject: subject.default({}) }).strict();
const idParam = z.object({ id: fields.id });
const part = z.enum(['cert', 'key', 'csr', 'chain', 'fullchain']);
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const tlsProtocol = z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
const serviceName = z.enum(SSL_SERVICES);

export async function register(ctx) {
  ctx.ssl = createSslService(ctx);
  ctx.capabilities.register('ssl', { binaries: ['openssl'], required: ['openssl'] });
  ctx.capabilities.register('acme', { binaries: ['certbot', 'acme.sh'], required: ['certbot', 'acme.sh'] });
  ctx.jobs.register('ssl.autossl.run', (job) => ctx.ssl.autossl.run(job));
  ctx.scheduler.ensure('autossl-daily', '17 3 * * *', 'ssl.autossl.run', { trigger: 'scheduled' });
  ctx.ssl.autossl.syncSchedule();

  const s = ctx.ssl;
  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const created = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(201).json({ data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);

  // Storage: keys, CSRs and certificates (reseller: own accounts only)
  r.get('/certs', requireReseller, validate({ query: pagination.extend({ account: fields.username.optional(), kind: z.enum(['cert', 'key', 'csr']).optional(), installed: boolQuery }) }), wrap((req) => s.certs.list(req.query, req.user)));
  r.post('/certs/csr', requireReseller, validate({ body: generateBody }), created((req) => s.certs.generateCsr(req.body, req.user, req)));
  r.post('/certs/self-signed', requireReseller, validate({ body: generateBody.extend({ days: z.number().int().min(1).max(3650).default(365) }) }), created((req) => s.certs.generateSelfSigned(req.body, req.user, req)));
  r.post('/certs/upload', requireReseller, validate({ body: z.object({ account: fields.username.optional(), domain: fields.hostname.optional(), certPem: certPem.optional(), keyPem: keyPem.optional(), chainPem: chainPem.optional(), csrPem: csrPem.optional() }).strict() }), created((req) => s.certs.upload(req.body, req.user, req)));
  r.post('/certs/inspect', requireReseller, validate({ body: z.object({ certPem, chainPem: chainPem.optional(), domain: fields.hostname.optional() }).strict() }), wrap((req) => s.certs.inspect(req.body.certPem, req.body.chainPem, req.body.domain)));
  r.get('/certs/:id', requireReseller, validate({ params: idParam }), wrap((req) => s.certs.get(req.params.id, req.user)));
  r.get('/certs/:id/download', requireReseller, validate({ params: idParam, query: z.object({ part: part.default('cert') }) }), wrap((req) => s.certs.download(req.params.id, req.query.part, req.user, req)));
  r.delete('/certs/:id', requireReseller, validate({ params: idParam }), wrap((req) => s.certs.remove(req.params.id, req.user, req)));
  r.delete('/certs/:id/:part', requireReseller, validate({ params: idParam.extend({ part: z.enum(['cert', 'key', 'csr']) }) }), wrap((req) => s.certs.deletePart(req.params.id, req.params.part, req.user, req)));
  r.get('/storage', requireReseller, validate({ query: z.object({ account: fields.username.optional() }) }), wrap((req) => s.storage.list(req.user, req.query)));

  // Install on a domain / hosts
  r.get('/domains', requireReseller, wrap((req) => s.domains(req.user)));
  r.post('/install', requireReseller, validate({ body: z.object({ domain: fields.hostname, certId: fields.id.optional(), certPem: certPem.optional(), keyPem: keyPem.optional(), chainPem: chainPem.optional(), force: z.boolean().default(false) }).strict() }), wrap((req) => s.install(req.body, req.user, req)));
  r.get('/hosts', requireReseller, wrap((req) => s.hosts.list(req.user)));
  r.get('/hosts/:domain', requireReseller, validate({ params: z.object({ domain: fields.hostname }) }), wrap((req) => s.hosts.get(req.params.domain, req.user)));
  r.delete('/hosts/:domain', requireReseller, validate({ params: z.object({ domain: fields.hostname }) }), wrap((req) => s.uninstall(req.params.domain, req.user, req)));

  // AutoSSL (server-wide)
  r.get('/autossl', requireRoot, wrap(() => s.autossl.status()));
  r.put('/autossl/settings', requireRoot, validate({ body: z.object({
    provider: z.enum(['disabled', 'certbot', 'acme.sh']).optional(), email: z.union([z.literal(''), z.string().email().max(254).regex(/^[^-\s]/, 'May not start with "-"')]).optional(), method: z.enum(['webroot', 'standalone']).optional(),
    staging: z.boolean().optional(), keyType: z.enum(['rsa', 'ecdsa']).optional(), renewDays: z.number().int().min(1).max(89).optional(), includeWww: z.boolean().optional(), replaceCustom: z.boolean().optional(),
  }).strict() }), wrap((req) => s.autossl.updateSettings(req.body, req)));
  r.post('/autossl/exclusions', requireRoot, validate({ body: z.object({ kind: z.enum(['account', 'domain']), value: z.string().max(253), reason: z.string().max(200).optional() }).strict().refine((v) => (v.kind === 'account' ? fields.username.safeParse(v.value).success : fields.hostname.safeParse(v.value).success), { message: 'Must be a valid username or hostname', path: ['value'] }) }),
    created((req) => s.autossl.exclusions.add(req.body.kind, req.body.value.toLowerCase(), req.body.reason, req)));
  r.delete('/autossl/exclusions/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.autossl.exclusions.remove(req.params.id, req)));
  r.post('/autossl/run', requireRoot, validate({ body: z.object({ domain: fields.hostname.optional(), account: fields.username.optional(), force: z.boolean().default(false) }).strict() }), accepted((req) => s.autossl.runNow(req.body, req.user, req)));
  r.post('/autossl/issue', requireReseller, validate({ body: z.object({ domain: fields.hostname, force: z.boolean().default(false) }).strict() }), accepted((req) => s.autossl.issueNow(req.body, req.user, req)));
  r.get('/autossl/runs', requireRoot, validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }), wrap((req) => s.autossl.runs(req.query.limit)));
  r.get('/autossl/runs/:id', requireRoot, validate({ params: idParam }), wrap((req) => s.autossl.getRun(req.params.id)));

  // Purchase flow
  r.get('/market/providers', requireReseller, wrap(() => s.market.providers()));
  r.get('/market/orders', requireReseller, wrap((req) => s.market.orders(req.user)));
  r.post('/market/orders', requireReseller, validate({ body: z.object({ provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), product: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), domain: fields.hostname, account: fields.username.optional(), certId: fields.id.optional(), subject: subject.default({}) }).strict() }), created((req) => s.market.createOrder(req.body, req.user, req)));
  r.post('/market/orders/:id/complete', requireReseller, validate({ params: idParam, body: z.object({ certPem, chainPem: chainPem.optional(), orderRef: z.string().max(128).optional() }).strict() }), wrap((req) => s.market.completeOrder(req.params.id, req.body, req.user, req)));
  r.delete('/market/orders/:id', requireReseller, validate({ params: idParam }), wrap((req) => s.market.cancelOrder(req.params.id, req.user, req)));

  // TLS policy + service certificates (server-wide)
  r.get('/tls-config', requireRoot, wrap(() => s.tls.get()));
  r.put('/tls-config', requireRoot, validate({ body: z.object({
    preset: z.enum(['modern', 'intermediate', 'old', 'custom']).optional(), protocols: z.array(tlsProtocol).min(1).max(4).optional(),
    ciphers: z.string().regex(/^[A-Za-z0-9:!+@=_-]{1,2048}$/, 'OpenSSL cipher list characters only').optional(), ciphersuites: z.string().regex(/^[A-Za-z0-9_:]{0,512}$/).optional(),
    preferServerCiphers: z.boolean().optional(), services: z.array(z.enum(['apache', 'exim', 'dovecot'])).min(1).optional(),
    hsts: z.object({ enabled: z.boolean().optional(), maxAge: z.number().int().min(0).max(63_072_000).optional(), includeSubdomains: z.boolean().optional(), preload: z.boolean().optional() }).strict().optional(),
    apply: z.boolean().optional(),
  }).strict() }), wrap((req) => s.tls.update(req.body, req)));
  r.get('/service-certs', requireRoot, wrap(() => s.serviceCertStatus()));
  r.post('/service-certs/:service', requireRoot, validate({ params: z.object({ service: serviceName }), body: z.object({ certPem, keyPem, chainPem: chainPem.optional() }).strict() }), wrap((req) => s.installServiceCert(req.params.service, req.body, req)));

  return { path: '/ssl', router: r };
}
