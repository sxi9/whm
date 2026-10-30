import net from 'node:net';
import { Router } from 'express';
import { validate, z, fields, pagination } from '../../lib/validate.js';
import { requireRoot } from '../../middleware/rbac.js';
import { createSecurityCenterService, normalizeIpOrCidr } from '../../services/security-center.js';

const yesNo = z.enum(['yes', 'no']);
const sshdSettings = z.object({
  PasswordAuthentication: yesNo.nullable().optional(),
  PermitRootLogin: z.enum(['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only']).nullable().optional(),
  PubkeyAuthentication: yesNo.nullable().optional(),
  KbdInteractiveAuthentication: yesNo.nullable().optional(),
  ChallengeResponseAuthentication: yesNo.nullable().optional(),
  PermitEmptyPasswords: yesNo.nullable().optional(),
  UsePAM: yesNo.nullable().optional(),
  X11Forwarding: yesNo.nullable().optional(),
  AllowTcpForwarding: z.enum(['yes', 'no', 'local', 'remote']).nullable().optional(),
  MaxAuthTries: z.number().int().min(1).max(100).nullable().optional(),
  Port: z.number().int().min(1).max(65535).nullable().optional(),
  LoginGraceTime: z.number().int().min(1).max(3600).nullable().optional(),
  ClientAliveInterval: z.number().int().min(0).max(86400).nullable().optional(),
  ClientAliveCountMax: z.number().int().min(0).max(1000).nullable().optional(),
}).strict();

// Strict (net.isIP + prefix bound) and canonicalising, so cPHulk rows never hold
// non-addresses and firewall records match what iptables/nft print back.
const ipOrCidr = z.string().max(64).transform((v, c) => {
  const n = normalizeIpOrCidr(v);
  if (n === null) { c.addIssue({ code: z.ZodIssueCode.custom, message: 'IP address or CIDR network' }); return z.NEVER; }
  return n;
});
// libwrap separates fields with ":" and needs IPv6 in brackets; the agent renders
// them, so an address containing ":" must parse as IPv6 (brackets optional).
const hostSource = z.string().regex(/^(ALL|LOCAL|KNOWN|UNKNOWN|PARANOID|\[?[A-Za-z0-9.:/_-]{1,255}\]?(\/\d{1,3})?)$/, 'Host, IP, network/mask or wildcard').refine((v) => {
  if (!v.includes(':')) return true;
  const m = v.match(/^\[?([0-9a-fA-F:.]+)\]?(?:\/(\d{1,3}))?$/);
  return Boolean(m) && net.isIP(m[1]) === 6 && (m[2] === undefined || Number(m[2]) <= 128);
}, 'An address containing ":" must be an IPv6 address or network, e.g. [2001:db8::]/32');
const keyName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);
const vendorName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const providerName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, "_" or "-"');
// GET /external-auth/presets is the catalogue, so no provider may take that name.
const newProviderName = providerName.refine((n) => n !== 'presets', 'Reserved identifier');
const providerScopes = z.string().regex(/^[A-Za-z0-9_.:\/ -]{0,200}$/);
const providerCommon = { clientId: z.string().min(1).max(256), clientSecret: z.string().max(4096).optional(), scopes: providerScopes.optional(), enabled: z.boolean().optional() };
const genericProviderBody = z.object({
  name: newProviderName, displayName: z.string().min(1).max(64), issuerUrl: z.string().url().max(512).startsWith('https://', 'Issuer must use https://'), ...providerCommon,
}).strict();
const presetProviderBody = z.object({
  preset: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), name: newProviderName, displayName: z.string().min(1).max(64).optional(),
  fields: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/), z.string().max(512)).optional(), allowForeignEndpoints: z.boolean().optional(), ...providerCommon,
}).strict();
// One endpoint, two shapes: a body naming a preset is validated as such, so field
// errors keep their paths instead of a union's generic "invalid input".
const createProviderBody = z.unknown().transform((value, ctx) => {
  const schema = value && typeof value === 'object' && 'preset' in value ? presetProviderBody : genericProviderBody;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues) ctx.addIssue(issue);
  return z.NEVER;
});
const groupName = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i);
const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

const modsecDirectives = z.object({
  SecRuleEngine: z.enum(['On', 'Off', 'DetectionOnly']).nullable().optional(),
  SecAuditEngine: z.enum(['On', 'Off', 'RelevantOnly']).nullable().optional(),
  SecRequestBodyAccess: z.enum(['On', 'Off']).nullable().optional(),
  SecResponseBodyAccess: z.enum(['On', 'Off']).nullable().optional(),
  SecRequestBodyLimit: z.number().int().min(1024).nullable().optional(),
  SecRequestBodyNoFilesLimit: z.number().int().min(1024).nullable().optional(),
  SecRequestBodyLimitAction: z.enum(['Reject', 'ProcessPartial']).nullable().optional(),
  SecResponseBodyLimit: z.number().int().min(1024).nullable().optional(),
  SecAuditLogRelevantStatus: z.string().regex(/^[\^$()|\[\]\d\-.?+*:!]{1,64}$/).nullable().optional(),
  SecAuditLogParts: z.string().regex(/^[A-KZ]{1,12}$/).nullable().optional(),
  SecPcreMatchLimit: z.number().int().min(1000).nullable().optional(),
  SecPcreMatchLimitRecursion: z.number().int().min(1000).nullable().optional(),
  SecConnEngine: z.enum(['On', 'Off', 'DetectionOnly']).nullable().optional(),
}).strict();

export async function register(ctx) {
  ctx.security = createSecurityCenterService(ctx);
  ctx.capabilities.register('sshd', { binaries: ['sshd', 'ssh-keygen'], required: ['sshd'] });
  ctx.jobs.register('security.cphulk.maintenance', (job) => ctx.security.cphulk.maintenance(job));
  ctx.jobs.register('security.advisor.scan', () => ctx.security.advisor.scan('scheduled'));
  ctx.jobs.register('security.modsec.vendor.install', (job) => ctx.security.modsec.installVendorJob(job));
  ctx.jobs.register('security.firewall.reconcile', (job) => ctx.security.firewall.reconcile(job));
  ctx.scheduler.ensure('security-cphulk-maintenance', '7 * * * *', 'security.cphulk.maintenance');
  ctx.scheduler.ensure('security-advisor-scan', '15 4 * * *', 'security.advisor.scan');
  // Firewall rules do not survive a reboot: put recorded blocks and the SMTP
  // restriction back as soon as the job worker starts, when there is anything to restore.
  if (ctx.security.smtp.desired() || ctx.settings.get('security.cphulk.firewall_sync') || ctx.security.firewall.recorded().length) {
    ctx.jobs.enqueue('security.firewall.reconcile', { trigger: 'boot' });
  }

  const s = ctx.security;
  const r = Router();
  r.use(requireRoot);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  const accepted = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.status(202).json({ data: d })).catch(next);

  // Host Access Control
  r.get('/host-access', wrap(async () => ({ rules: s.hostAccess.list(), services: s.hostAccess.services(), files: await s.hostAccess.files() })));
  r.put('/host-access', validate({ body: z.object({ rules: z.array(z.object({
    service: z.string().regex(/^(ALL|[A-Za-z0-9_.-]{1,32})$/, 'Daemon name such as sshd, vsftpd or ALL'),
    source: hostSource,
    action: z.enum(['allow', 'deny']),
    comment: z.string().regex(/^[^\n\0]{0,120}$/).optional(),
  }).strict()).max(500) }).strict() }), wrap((req) => s.hostAccess.replace(req.body.rules, req)));

  // SSH daemon + root keys
  r.get('/ssh/config', wrap(() => s.ssh.config()));
  r.put('/ssh/config', validate({ body: z.object({ settings: sshdSettings, force: z.boolean().optional() }).strict() }), wrap((req) => s.ssh.setConfig(req.body.settings, req, { force: req.body.force === true })));
  r.get('/ssh/keys', wrap(() => s.ssh.keys()));
  r.post('/ssh/keys', validate({ body: z.object({ publicKey: z.string().min(20).max(16 * 1024).regex(/^[^\n\r\0]+$/, 'One line') }).strict() }), wrap((req) => s.ssh.importKey(req.body.publicKey.trim(), req)));
  r.post('/ssh/keys/generate', validate({ body: z.object({
    name: keyName, type: z.enum(['ed25519', 'rsa', 'ecdsa']).default('ed25519'), bits: z.number().int().optional(),
    comment: z.string().regex(/^[^\n\r\0]{0,128}$/).optional(), passphrase: z.string().max(256).regex(/^[^\n\r\0]*$/).optional(), authorize: z.boolean().default(false),
  }).strict() }), wrap((req) => s.ssh.generate(req.body, req)));
  r.post('/ssh/keys/deauthorize', validate({ body: z.object({ fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }).strict() }), wrap((req) => s.ssh.deauthorize(req.body.fingerprint, req)));
  r.post('/ssh/keys/:name/authorize', validate({ params: z.object({ name: keyName }) }), wrap((req) => s.ssh.authorize(req.params.name, req)));
  r.get('/ssh/keys/:name/private', validate({ params: z.object({ name: keyName }) }), wrap((req) => s.ssh.exportPrivate(req.params.name, req)));
  r.delete('/ssh/keys/:name', validate({ params: z.object({ name: keyName }), query: z.object({ deauthorize: boolQuery }) }), wrap((req) => s.ssh.deletePair(req.params.name, req.query.deauthorize !== false, req)));

  // Compiler access, traceroute, fork bomb
  r.get('/compilers', wrap(() => s.compilers.status()));
  r.put('/compilers', validate({ body: z.object({ allow: z.boolean() }).strict() }), wrap((req) => s.compilers.set(req.body.allow, req)));
  r.get('/traceroute', wrap(() => s.traceroute.status()));
  r.put('/traceroute', validate({ body: z.object({ enabled: z.boolean() }).strict() }), wrap((req) => s.traceroute.set(req.body.enabled, req)));
  r.get('/fork-bomb', wrap(() => s.forkBomb.status()));
  r.put('/fork-bomb', validate({ body: z.object({
    enabled: z.boolean(), maxProcesses: z.number().int().min(1).max(1_000_000).optional(), maxOpenFiles: z.number().int().min(16).max(10_000_000).optional(),
    maxMemoryMb: z.number().int().min(16).max(16_000_000).optional(), excludeGroups: z.array(groupName).max(20).optional(),
  }).strict() }), wrap((req) => s.forkBomb.set(req.body, req)));

  // cPHulk + firewall
  r.get('/cphulk', wrap(() => s.cphulk.overview()));
  r.put('/cphulk/settings', validate({ body: z.object({
    enabled: z.boolean().optional(), maxFailuresPerIp: z.number().int().min(1).max(10000).optional(), lockoutMinutes: z.number().int().min(1).max(525600).optional(),
    firewallSync: z.boolean().optional(), historyRetentionDays: z.number().int().min(1).max(3650).optional(), blockDenylistPermanently: z.boolean().optional(),
  }).strict() }), wrap((req) => s.cphulk.updateSettings(req.body, req)));
  r.get('/cphulk/blocks', wrap(() => s.cphulk.blocks()));
  r.post('/cphulk/blocks', validate({ body: z.object({ ip: ipOrCidr, minutes: z.number().int().min(1).max(525600).nullable().optional(), reason: z.string().max(200).optional(), firewall: z.boolean().optional() }).strict() }),
    wrap((req) => s.cphulk.block(req.body.ip, { minutes: req.body.minutes ?? null, reason: req.body.reason, firewall: req.body.firewall }, req)));
  r.delete('/cphulk/blocks', wrap((req) => s.cphulk.flush(req)));
  r.delete('/cphulk/blocks/:id', validate({ params: z.object({ id: fields.id }) }), wrap((req) => s.cphulk.unblock(req.params.id, req)));
  r.get('/cphulk/history', validate({ query: pagination.extend({ failed: boolQuery }) }), wrap((req) => s.cphulk.history(req.query)));
  r.get('/cphulk/lists', wrap(() => s.cphulk.lists()));
  r.post('/cphulk/lists', validate({ body: z.object({ kind: z.enum(['allow', 'deny']), ip: ipOrCidr, comment: z.string().max(200).optional() }).strict() }), wrap((req) => s.cphulk.addToList(req.body.kind, req.body.ip, req.body.comment, req)));
  r.delete('/cphulk/lists/:id', validate({ params: z.object({ id: fields.id }) }), wrap((req) => s.cphulk.removeFromList(req.params.id, req)));
  r.post('/cphulk/maintenance', wrap(() => s.cphulk.maintenance()));
  r.get('/firewall', wrap(() => s.firewall.status()));
  r.post('/firewall/block', validate({ body: z.object({ ip: ipOrCidr, comment: z.string().max(200).optional() }).strict() }), wrap((req) => s.firewall.block(req.body.ip, req, { comment: req.body.comment })));
  r.post('/firewall/unblock', validate({ body: z.object({ ip: ipOrCidr }).strict() }), wrap((req) => s.firewall.unblock(req.body.ip, req)));
  r.post('/firewall/reconcile', wrap(() => s.firewall.reconcile()));

  // SMTP restrictions, mod_userdir, wheel
  r.get('/smtp-restrictions', wrap(() => s.smtp.status()));
  r.put('/smtp-restrictions', validate({ body: z.object({ enabled: z.boolean() }).strict() }), wrap((req) => s.smtp.set(req.body.enabled, req)));
  r.get('/userdir', wrap(() => s.userdir.status()));
  r.put('/userdir', validate({ body: z.object({ enabled: z.boolean(), excludeUsers: z.array(fields.username).max(5000).default([]) }).strict() }), wrap((req) => s.userdir.set(req.body, req)));
  r.get('/wheel', wrap(() => s.wheel.list()));
  r.post('/wheel', validate({ body: z.object({ username: fields.username }).strict() }), wrap((req) => s.wheel.add(req.body.username, req)));
  r.delete('/wheel/:username', validate({ params: z.object({ username: fields.username }) }), wrap((req) => s.wheel.remove(req.params.username, req)));

  // ModSecurity
  r.get('/modsec', wrap(() => s.modsec.status()));
  r.put('/modsec/config', validate({ body: z.object({ directives: modsecDirectives }).strict() }), wrap((req) => s.modsec.setConfig(req.body.directives, req)));
  r.get('/modsec/rules', validate({ query: pagination.extend({ vendor: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(), disabled: boolQuery }) }), wrap((req) => s.modsec.rules(req.query)));
  r.get('/modsec/rules/disabled', wrap(() => s.modsec.disabledRules()));
  r.put('/modsec/rules/:id', validate({ params: z.object({ id: fields.id }), body: z.object({ disabled: z.boolean(), reason: z.string().max(200).optional() }).strict() }), wrap((req) => s.modsec.setRuleDisabled(req.params.id, req.body.disabled, req.body.reason, req)));
  r.get('/modsec/hits', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(5000).default(500) }) }), wrap((req) => s.modsec.hits(req.query.limit)));
  r.get('/modsec/vendors', wrap(() => s.modsec.vendors()));
  r.post('/modsec/vendors', validate({ body: z.object({ name: vendorName, url: z.string().url().max(2048).startsWith('https://', 'Only https:// URLs'), enabled: z.boolean().optional() }).strict() }), accepted((req) => s.modsec.addVendor(req.body, req.user, req)));
  r.post('/modsec/vendors/:name/update', validate({ params: z.object({ name: vendorName }) }), accepted((req) => s.modsec.updateVendor(req.params.name, req.user, req)));
  r.patch('/modsec/vendors/:name', validate({ params: z.object({ name: vendorName }), body: z.object({ enabled: z.boolean() }).strict() }), wrap((req) => s.modsec.setVendorEnabled(req.params.name, req.body.enabled, req)));
  r.delete('/modsec/vendors/:name', validate({ params: z.object({ name: vendorName }) }), wrap((req) => s.modsec.removeVendor(req.params.name, req)));

  // Policies, password strength, external authentication, advisor
  r.get('/policy', wrap(() => s.policy()));
  r.post('/password-strength', validate({ body: z.object({ password: z.string().max(256), context: z.enum(['account', 'email', 'ftp', 'mysql', 'panel', 'ssh']).default('account') }).strict() }), wrap((req) => s.passwordStrength(req.body.password, req.body.context)));
  r.get('/external-auth', wrap(() => s.externalAuth.list()));
  r.get('/external-auth/presets', wrap((req) => s.externalAuth.presets({ redirectBase: `${req.protocol}://${req.get('host')}` })));
  r.post('/external-auth', validate({ body: createProviderBody }), (req, res, next) => Promise.resolve(req.body.preset ? s.externalAuth.createFromPreset(req.body, req) : s.externalAuth.create(req.body, req)).then((data) => res.status(201).json({ data })).catch(next));
  r.get('/external-auth/:name', validate({ params: z.object({ name: providerName }) }), wrap((req) => s.externalAuth.get(req.params.name)));
  r.put('/external-auth/:name', validate({ params: z.object({ name: providerName }), body: z.object({
    displayName: z.string().min(1).max(64).optional(), issuerUrl: z.string().url().max(512).startsWith('https://').optional(), clientId: z.string().min(1).max(256).optional(),
    clientSecret: z.string().max(4096).optional(), scopes: providerScopes.optional(), enabled: z.boolean().optional(),
  }).strict() }), wrap((req) => s.externalAuth.update(req.params.name, req.body, req)));
  r.delete('/external-auth/:name', validate({ params: z.object({ name: providerName }) }), wrap((req) => s.externalAuth.remove(req.params.name, req)));
  r.post('/external-auth/:name/discover', validate({ params: z.object({ name: providerName }), body: z.object({ allowForeignEndpoints: z.boolean().optional() }).strict() }), wrap((req) => s.externalAuth.discover(req.params.name, req, { allowForeignEndpoints: req.body.allowForeignEndpoints === true })));
  r.get('/advisor', wrap(() => s.advisor.last()));
  r.post('/advisor/scan', wrap((req) => s.advisor.scan('manual', req)));

  return { path: '/security', router: r };
}
