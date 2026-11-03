import { validate, z, fields, pagination } from '../../lib/validate.js';
import { panelRouter, wrap, created, accepted } from './index.js';
import { createPanelSslService, DOWNLOAD_PARTS } from '../../services/panel-ssl.js';

// PEM shapes mirror routes/categories/ssl-tls.js so the agent sees the same inputs.
const PEM_BODY = '[A-Za-z0-9+/=\\r\\n ]+';
const pemBlock = (label) => new RegExp(`^\\s*-----BEGIN ${label}-----\\r?\\n${PEM_BODY}-----END ${label}-----\\s*$`);
const keyPem = z.string().max(64 * 1024).regex(pemBlock('(?:RSA |EC )?PRIVATE KEY'), 'Must be one unencrypted PEM private key');
const certPem = z.string().max(64 * 1024).regex(pemBlock('CERTIFICATE'), 'Must be one PEM certificate');
const csrPem = z.string().max(64 * 1024).regex(pemBlock('(?:NEW )?CERTIFICATE REQUEST'), 'Must be a PEM certificate signing request');
const chainPem = z.string().max(256 * 1024).regex(new RegExp(`^\\s*(?:-----BEGIN CERTIFICATE-----\\r?\\n${PEM_BODY}-----END CERTIFICATE-----\\s*)+$`), 'Must be one or more PEM certificates');
const HOST = '(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const certName = z.string().toLowerCase().regex(new RegExp(`^(\\*\\.)?${HOST}$`), 'Must be a hostname such as example.com or *.example.com');
const subjectValue = z.string().regex(/^(?![-\s])[A-Za-z0-9 .,'&()@_:-]{1,64}$/, 'Letters, digits, spaces and . , \' & ( ) @ _ : - only');
const subject = z.object({
  O: subjectValue.optional(), OU: subjectValue.optional(), L: subjectValue.optional(), ST: subjectValue.optional(),
  C: z.string().regex(/^[A-Z]{2}$/, 'Two-letter ISO country code').optional(), emailAddress: z.email().max(128).optional(),
}).strict();
const keySpec = z.object({ type: z.enum(['rsa', 'ec']).optional(), bits: z.number().int().refine((b) => [2048, 3072, 4096].includes(b), 'RSA keys must be 2048, 3072 or 4096 bits').optional(), curve: z.enum(['prime256v1', 'secp384r1']).optional() }).strict();
const generateBody = z.object({ domain: certName, sans: z.array(certName).max(100).default([]), key: keySpec.prefault({}), subject: subject.prefault({}) }).strict();
const domainParam = z.object({ domain: fields.hostname });
const idParam = z.object({ id: fields.id });

export async function register(ctx) {
  ctx.panelSsl = createPanelSslService(ctx);
  const s = ctx.panelSsl;

  const r = panelRouter(ctx, 'ssl');
  r.get('/domains', wrap((req) => s.domains(req.panel)));
  r.get('/domains/:domain', validate({ params: domainParam }), wrap((req) => s.get(req.panel, req.params.domain)));
  r.post('/domains/:domain/issue', validate({ params: domainParam, body: z.object({}).strict() }), accepted((req) => s.issue(req.panel, req.params.domain, req)));
  r.post('/domains/:domain/install', validate({ params: domainParam, body: z.object({ certId: fields.id.optional(), certPem: certPem.optional(), keyPem: keyPem.optional(), chainPem: chainPem.optional() }).strict() }),
    wrap((req) => s.install(req.panel, req.params.domain, req.body, req)));
  r.delete('/domains/:domain', validate({ params: domainParam }), wrap((req) => s.uninstall(req.panel, req.params.domain, req)));

  r.get('/certs', validate({ query: pagination.extend({ kind: z.enum(['cert', 'key', 'csr']).optional(), installed: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }) }), wrap((req) => s.certs(req.panel, req.query)));
  r.get('/certs/storage', wrap((req) => s.storage(req.panel)));
  r.post('/certs/csr', validate({ body: generateBody }), created((req) => s.generateCsr(req.panel, req.body, req)));
  r.post('/certs/self-signed', validate({ body: generateBody.extend({ days: z.number().int().min(1).max(3650).default(365) }) }), created((req) => s.generateSelfSigned(req.panel, req.body, req)));
  r.post('/certs/upload', validate({ body: z.object({ domain: fields.hostname.optional(), certPem: certPem.optional(), keyPem: keyPem.optional(), chainPem: chainPem.optional(), csrPem: csrPem.optional() }).strict() }), created((req) => s.upload(req.panel, req.body, req)));
  r.get('/certs/:id/download', validate({ params: idParam, query: z.object({ part: z.enum(DOWNLOAD_PARTS).default('cert') }) }), wrap((req) => s.download(req.panel, req.params.id, req.query.part, req)));
  r.delete('/certs/:id', validate({ params: idParam }), wrap((req) => s.remove(req.panel, req.params.id, req)));

  return { path: '/ssl', router: r };
}
