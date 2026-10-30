import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary, resolveBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';

// SSL/TLS op family: key/CSR/self-signed generation, certificate inspection and
// chain verification through openssl, per-domain bundles under /etc/ssl/whm,
// per-service certificates (exim/dovecot/apache/ftp/panel), ACME issuance via
// certbot or acme.sh, and the TLS policy includes (protocols/ciphers/HSTS).
// PEM material only ever travels through stdin or files, never argv.

const MANAGED = '# Managed by WHM panel';
const BUNDLE_ROOT = '/etc/ssl/whm';
const SERVICE_ROOT = `${BUNDLE_ROOT}/service`;
const TMP_ROOT = '/tmp/whm';
const LETSENCRYPT_LIVE = '/etc/letsencrypt/live';
const ACME_SH_HOME = '/root/.acme.sh';
const SERVICES = ['exim', 'dovecot', 'apache', 'ftp', 'panel'];
const SERVICE_UNITS = { exim: ['exim4', 'exim'], dovecot: ['dovecot'], apache: ['apache2', 'httpd'], ftp: ['pure-ftpd', 'proftpd', 'vsftpd'], panel: [] };

// ----------------------------------------------------------------- schemas ---

const PEM_BODY = '[A-Za-z0-9+/=\\r\\n ]+';
const pemBlock = (label) => new RegExp(`^\\s*-----BEGIN ${label}-----\\r?\\n${PEM_BODY}-----END ${label}-----\\s*$`);
// Passphrase-protected keys are refused up front: openssl would prompt on the
// terminal (or fail opaquely without one), so the caller is told to decrypt first.
const KEY_LABEL = '(?:RSA |EC )?PRIVATE KEY';
const CERT_LABEL = 'CERTIFICATE';
const CSR_LABEL = '(?:NEW )?CERTIFICATE REQUEST';
export const KEY_PEM_MESSAGE = 'Must be one unencrypted PEM private key (decrypt a passphrase-protected key first: openssl pkey -in key.pem -out plain.pem)';

export const pem = {
  key: z.string().max(64 * 1024).regex(pemBlock(KEY_LABEL), KEY_PEM_MESSAGE),
  cert: z.string().max(64 * 1024).regex(pemBlock(CERT_LABEL), 'Must be one PEM certificate'),
  csr: z.string().max(64 * 1024).regex(pemBlock(CSR_LABEL), 'Must be a PEM certificate signing request'),
  // A CA chain: one or more concatenated certificates.
  chain: z.string().max(256 * 1024).regex(new RegExp(`^\\s*(?:-----BEGIN ${CERT_LABEL}-----\\r?\\n${PEM_BODY}-----END ${CERT_LABEL}-----\\s*)+$`), 'Must be one or more PEM certificates'),
};

const HOST = '(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// Certificate names: a hostname, optionally with a leading wildcard label.
export const certName = z.string().regex(new RegExp(`^(\\*\\.)?${HOST}$`), 'Must be a hostname such as example.com or *.example.com');
// Bundle directory names: the same lower-case dotted hostname the API accepts
// (fields.hostname), so a name that passes the route also passes here.
export const bundleDomain = z.string().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Must be a lower-case hostname such as example.com');
// Goes into argv after -m / --accountemail, so it may not start with "-".
const acmeEmail = z.string().email().max(254).regex(/^[^-\s]/, 'May not start with "-"');
// Subject attribute values go into -subj "/CN=…/O=…"; the separators / \ and
// leading "-" are refused rather than escaped so no element can be misread.
const subjectValue = z.string().regex(/^(?![-\s])[A-Za-z0-9 .,'&()@_:-]{1,64}$/, 'Letters, digits, spaces and . , \' & ( ) @ _ : - only');
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Two-letter ISO country code');
const subject = z.object({
  CN: certName,
  O: subjectValue.optional(),
  OU: subjectValue.optional(),
  L: subjectValue.optional(),
  ST: subjectValue.optional(),
  C: countryCode.optional(),
  emailAddress: z.string().email().max(128).regex(/^[^\s/\\]+$/).optional(),
}).strict();
const sans = z.array(certName).max(100).default([]);
const keySpec = z.object({
  type: z.enum(['rsa', 'ec']).default('rsa'),
  bits: z.number().int().refine((b) => [2048, 3072, 4096].includes(b), 'RSA keys must be 2048, 3072 or 4096 bits').default(2048),
  curve: z.enum(['prime256v1', 'secp384r1']).default('prime256v1'),
}).strict();
const service = z.enum(SERVICES);
const acmeProvider = z.enum(['certbot', 'acme.sh']);
const cipherList = z.string().regex(/^[A-Za-z0-9:!+@=_-]{1,2048}$/, 'OpenSSL cipher list characters only');
const tlsProtocol = z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);

// ----------------------------------------------------------------- helpers ---

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

function requireOpenssl() {
  if (!hasBinary('openssl')) throw new OpError('capability_missing', 'openssl is not installed on this server');
}

// Private keys and CSR inputs are written to a private scratch directory for
// the duration of one openssl call and shredded afterwards.
async function withTempDir(fn) {
  // As root the scratch root is the agent's private /tmp/whm (never a
  // world-writable directory another user could have planted); an
  // unprivileged test run falls back to a fresh mkdtemp under the system tmp.
  const base = exists(TMP_ROOT) || process.getuid?.() === 0 ? ensurePrivateDir(TMP_ROOT) : os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'ssl-'));
  fs.chmodSync(dir, 0o700);
  try {
    return await fn(dir, (name, content, mode = 0o600) => { const f = path.join(dir, name); fs.writeFileSync(f, content, { mode }); return f; });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const normalizePem = (text) => `${String(text).replace(/\r\n/g, '\n').trim()}\n`;

function subjArg(s) {
  const order = ['C', 'ST', 'L', 'O', 'OU', 'CN', 'emailAddress'];
  return order.filter((k) => s[k]).map((k) => `/${k}=${s[k]}`).join('');
}

function sanExt(cn, list) {
  const names = [...new Set([cn, ...list])];
  return `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`;
}

export function parseOpensslDate(text) {
  const d = new Date(String(text).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Parses "CN=example.com,O=Acme\, Inc." (RFC2253) into an object; commas inside
// values are escaped by openssl, so a split on unescaped commas is exact.
export function parseDn(text) {
  const out = {};
  for (const part of String(text).split(/(?<!\\),/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).replace(/\\(.)/g, '$1').trim();
  }
  return out;
}

export function parseSans(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/DNS:([^,\s]+)/g)) out.push(m[1].toLowerCase());
  return out;
}

// Reads the structured `openssl x509 -noout -subject -issuer …` output.
export function parseX509Fields(stdout, text = '') {
  const field = (name) => stdout.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? null;
  const subjectDn = parseDn(field('subject') || '');
  const issuerDn = parseDn(field('issuer') || '');
  const notBefore = parseOpensslDate(field('notBefore'));
  const notAfter = parseOpensslDate(field('notAfter'));
  const sanLine = stdout.match(/X509v3 Subject Alternative Name:[^\n]*\n\s*([^\n]+)/)?.[1] ?? '';
  const fingerprint = stdout.match(/^(?:sha256|SHA256) Fingerprint=([0-9A-F:]+)$/mi)?.[1] ?? null;
  const serial = field('serial');
  const keyAlgorithm = text.match(/Public Key Algorithm: (\S+)/)?.[1] ?? null;
  const keyBits = Number(text.match(/Public-Key: \((\d+) bit\)/)?.[1]) || null;
  const curve = text.match(/(?:ASN1 OID|NIST CURVE): (\S+)/)?.[1] ?? null;
  const signatureAlgorithm = text.match(/Signature Algorithm: (\S+)/)?.[1] ?? null;
  const days = notAfter ? Math.floor((new Date(notAfter).getTime() - Date.now()) / 86_400_000) : null;
  return {
    subject: subjectDn, subjectText: field('subject'), commonName: subjectDn.CN || null,
    issuer: issuerDn, issuerText: field('issuer'), issuerCommonName: issuerDn.CN || null, issuerOrganization: issuerDn.O || null,
    notBefore, notAfter, daysRemaining: days, expired: days != null && days < 0,
    serial, fingerprintSha256: fingerprint, sans: parseSans(sanLine),
    selfSigned: Boolean(field('subject')) && field('subject') === field('issuer'),
    keyAlgorithm: keyAlgorithm ? keyAlgorithm.replace('Encryption', '').replace('id-ecPublicKey', 'EC').toUpperCase() : null, keyBits, curve, signatureAlgorithm,
  };
}

async function inspectCert(certPem) {
  requireOpenssl();
  const input = normalizePem(certPem);
  const fields = await exec('openssl', ['x509', '-noout', '-subject', '-issuer', '-startdate', '-enddate', '-serial', '-fingerprint', '-sha256', '-nameopt', 'RFC2253', '-ext', 'subjectAltName'], { input, allowFailure: true });
  if (fields.code !== 0) throw new OpError('invalid_certificate', `openssl could not parse the certificate: ${fields.stderr.trim().split('\n').pop()}`);
  const text = await exec('openssl', ['x509', '-noout', '-text', '-certopt', 'no_header,no_version,no_serial,no_validity,no_subject,no_issuer,no_extensions,no_sigdump,no_aux'], { input, allowFailure: true });
  return parseX509Fields(fields.stdout, text.stdout);
}

async function publicKeyOf(kind, pemText) {
  const argv = kind === 'key' ? ['pkey', '-pubout'] : kind === 'csr' ? ['req', '-noout', '-pubkey'] : ['x509', '-noout', '-pubkey'];
  const { code, stdout, stderr } = await exec('openssl', argv, { input: normalizePem(pemText), allowFailure: true });
  if (code !== 0) throw new OpError(`invalid_${kind}`, `openssl could not read the ${kind}: ${stderr.trim().split('\n').pop()}`);
  return stdout.trim();
}

async function inspectKey(keyPem) {
  requireOpenssl();
  const input = normalizePem(keyPem);
  const { code, stdout, stderr } = await exec('openssl', ['pkey', '-noout', '-text_pub'], { input, allowFailure: true });
  if (code !== 0) throw new OpError('invalid_key', `openssl could not read the private key: ${stderr.trim().split('\n').pop()}`);
  const publicKeyPem = await publicKeyOf('key', input);
  const isEc = /ASN1 OID|NIST CURVE|EC Public/i.test(stdout);
  return {
    type: isEc ? 'ec' : 'rsa',
    bits: Number(stdout.match(/Public-Key: \((\d+) bit\)/)?.[1]) || null,
    curve: stdout.match(/(?:ASN1 OID|NIST CURVE): (\S+)/)?.[1] ?? null,
    publicKeyPem,
    publicKeySha256: crypto.createHash('sha256').update(publicKeyPem).digest('hex'),
  };
}

async function generateKey({ type, bits, curve }) {
  requireOpenssl();
  const argv = type === 'ec'
    ? ['genpkey', '-algorithm', 'EC', '-pkeyopt', `ec_paramgen_curve:${curve}`, '-pkeyopt', 'ec_param_enc:named_curve']
    : ['genpkey', '-algorithm', 'RSA', '-pkeyopt', `rsa_keygen_bits:${bits}`];
  const { stdout } = await exec('openssl', argv, { timeoutMs: 120_000 });
  return normalizePem(stdout);
}

function bundleDir(domain) {
  return path.join(BUNDLE_ROOT, domain);
}

function bundlePaths(dir) {
  return { dir, cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem'), chain: path.join(dir, 'chain.pem'), fullchain: path.join(dir, 'fullchain.pem') };
}

// Writes cert/key/chain/fullchain under `dir`; the key is 0600, the rest 0644,
// so daemons running as their own user read the public files only.
function writeBundle(dir, { certPem, keyPem, chainPem }) {
  const paths = bundlePaths(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const cert = normalizePem(certPem);
  const chain = chainPem ? normalizePem(chainPem) : '';
  writeAtomic(paths.cert, cert, 0o644);
  writeAtomic(paths.key, normalizePem(keyPem), 0o600);
  writeAtomic(paths.chain, chain, 0o644);
  writeAtomic(paths.fullchain, chain ? `${cert}${chain}` : cert, 0o644);
  return paths;
}

async function assertKeyMatches(keyPem, certPem) {
  const [k, c] = await Promise.all([publicKeyOf('key', keyPem), publicKeyOf('cert', certPem)]);
  if (k !== c) throw new OpError('key_mismatch', 'The private key does not match the certificate (public keys differ)');
}

async function reloadUnit(candidates) {
  if (!hasBinary('systemctl') || !candidates.length) return { reloaded: false, unit: null };
  const { stdout } = await exec('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain'], { allowFailure: true });
  const present = new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]?.replace(/\.service$/, '')).filter(Boolean));
  const unit = candidates.find((u) => present.has(u));
  if (!unit) return { reloaded: false, unit: null };
  const { code, stderr } = await exec('systemctl', ['reload-or-restart', `${unit}.service`], { allowFailure: true, timeoutMs: 120_000 });
  return { reloaded: code === 0, unit, error: code === 0 ? null : stderr.trim().split('\n').pop() };
}

export function apacheLayout() {
  if (exists('/etc/apache2')) return { flavor: 'debian', bin: ['apache2ctl', 'apachectl'].find(hasBinary) || null, includeDir: '/etc/apache2/conf-enabled', units: ['apache2'] };
  if (exists('/etc/httpd')) return { flavor: 'rhel', bin: ['httpd', 'apachectl'].find(hasBinary) || null, includeDir: '/etc/httpd/conf.d', units: ['httpd'] };
  return null;
}

// Debian's update-exim4.conf.conf is a sourced shell fragment of KEY='value'
// lines; dc_use_split_config decides whether conf.d/ is read at all.
export function parseUpdateExim4Conf(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// `validate` is the command that proves the whole Exim configuration still loads:
// Debian's update-exim4.conf regenerates config.autogenerated and refuses to
// install one that `exim4 -bV` rejects; elsewhere `exim -bV` reads the live file.
// Debian ships conf.d/ even in its default unsplit mode, where only
// exim4.conf.template is read, so split mode comes from update-exim4.conf.conf.
// exim4.conf.localmacros is prepended to the generated config in both modes, so
// in unsplit mode the panel's fragments live there as managed blocks
// (`block` set) instead of as files Exim would never read.
export function eximLayout({ debianDir = '/etc/exim4', rhelDir = '/etc/exim' } = {}) {
  const bin = ['exim4', 'exim'].find(hasBinary) || null;
  const bV = bin ? [bin, ['-bV']] : null;
  if (exists(debianDir)) {
    const conf = parseUpdateExim4Conf(readText(`${debianDir}/update-exim4.conf.conf`));
    const splitConfig = conf.dc_use_split_config === 'true';
    const macroFile = `${debianDir}/exim4.conf.localmacros`;
    return {
      flavor: 'debian', bin, confDir: debianDir, splitConfig, includeMode: splitConfig ? 'split' : 'localmacros', macroFile,
      tlsInclude: splitConfig ? `${debianDir}/conf.d/main/000_whm_tls` : macroFile, tlsBlock: splitConfig ? null : 'TLS policy',
      tlsEnable: splitConfig ? `${debianDir}/conf.d/main/000_whm_tls_enable` : macroFile, tlsEnableBlock: splitConfig ? null : 'STARTTLS',
      cert: `${debianDir}/exim.crt`, key: `${debianDir}/exim.key`, groups: ['Debian-exim', 'exim'], units: ['exim4'], validate: hasBinary('update-exim4.conf') ? ['update-exim4.conf', []] : bV,
    };
  }
  if (exists(rhelDir)) return { flavor: 'rhel', bin, confDir: rhelDir, splitConfig: false, includeMode: 'manual', macroFile: null, tlsInclude: `${rhelDir}/whm-tls.conf`, tlsBlock: null, tlsEnable: null, tlsEnableBlock: null, cert: `${rhelDir}/exim.crt`, key: `${rhelDir}/exim.key`, groups: ['exim', 'mail'], units: ['exim'], validate: bV };
  return null;
}

// Managed blocks let several panel features share exim4.conf.localmacros with
// whatever the admin wrote there; the markers differ from the Email category's.
const eximBlockMarkers = (name) => ({ begin: `# BEGIN WHM panel (SSL/TLS: ${name}) - managed block, edits inside are overwritten`, end: `# END WHM panel (SSL/TLS: ${name})` });

export function mergeEximBlock(previous, name, content) {
  const { begin, end } = eximBlockMarkers(name);
  const block = `${begin}\n${String(content).trimEnd()}\n${end}\n`;
  const text = previous || '';
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start !== -1 && stop !== -1 && stop >= start) return `${text.slice(0, start)}${block}${text.slice(stop + end.length).replace(/^\n/, '')}`;
  return `${text.length && !text.endsWith('\n') ? `${text}\n` : text}${block}`;
}

export function readEximBlock(text, name) {
  const { begin, end } = eximBlockMarkers(name);
  const t = text || '';
  const start = t.indexOf(begin);
  const stop = t.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return t.slice(start + begin.length, stop).replace(/^\n/, '');
}

export function stripEximBlock(text, name) {
  const { begin, end } = eximBlockMarkers(name);
  const t = text || '';
  const start = t.indexOf(begin);
  const stop = t.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return t;
  return `${t.slice(0, start)}${t.slice(stop + end.length).replace(/^\n/, '')}`;
}

// Resolves the first existing group of `names` from /etc/group.
export function groupId(names, groupFile = '/etc/group') {
  const text = readText(groupFile) || '';
  for (const name of names) {
    const m = text.match(new RegExp(`^${name}:[^:]*:(\\d+):`, 'm'));
    if (m) return { name, gid: Number(m[1]) };
  }
  return null;
}

// `exim -bV` names the TLS library in its "Support for:" line (bare "GnuTLS" or
// "TLS=GnuTLS" depending on the version); Debian/Ubuntu builds use GnuTLS.
export function parseEximTlsLibrary(stdout) {
  const support = String(stdout || '').match(/^Support for:.*$/m)?.[0] ?? String(stdout || '');
  if (/\bGnuTLS\b/.test(support)) return 'gnutls';
  if (/\bOpenSSL\b/.test(support)) return 'openssl';
  return null;
}

async function detectEximTlsLibrary(exim) {
  if (!exim?.bin) return null;
  const { stdout } = await exec(exim.bin, ['-bV'], { allowFailure: true, timeoutMs: 30_000 });
  return parseEximTlsLibrary(stdout);
}

// Writes an Exim config fragment, validates the whole configuration and rolls
// back on error: Exim re-execs itself on reload, so a rejected option would
// otherwise take the MTA down.
export async function writeEximInclude(exim, file, content, mode = 0o644) {
  const previous = readText(file);
  writeAtomic(file, content, mode);
  if (!exim.validate) return { path: file, validated: false };
  const [bin, argv] = exim.validate;
  const { code, stdout, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 60_000 });
  if (code !== 0) {
    restore(file, previous);
    const output = `${stderr}\n${stdout}`.trim();
    throw new OpError('config_invalid', `Exim rejected the new configuration; the previous file was restored: ${output.split('\n').filter(Boolean).pop() || `exit status ${code}`}`, { output });
  }
  return { path: file, validated: true };
}

// Writes one panel fragment for Exim: a whole file, or a managed block merged
// into a shared file (unsplit Debian's localmacros) when `block` is set.
export async function writeEximFragment(exim, { path: file, block }, content, ctx) {
  const target = ctx.assertAllowedPath(file, 'write');
  const written = await writeEximInclude(exim, target, block ? mergeEximBlock(readText(target), block, content) : content);
  return { ...written, block: block || null };
}

// Dovecot reads conf.d alphabetically and later files win. Service Configuration
// owns 97-whm-mailserver.conf (ssl=, protocols, ciphers); this category only
// names the certificate files, from a drop-in that sorts BEFORE it so nothing
// chosen in Mailserver Configuration is overridden. The 98/99 files are what
// earlier builds wrote and are removed whenever the drop-in is rewritten.
export function dovecotLayout() {
  if (!exists('/etc/dovecot')) return null;
  return { confDir: '/etc/dovecot', dropinDir: '/etc/dovecot/conf.d', sslInclude: '/etc/dovecot/conf.d/90-whm-ssl-cert.conf', legacyIncludes: ['/etc/dovecot/conf.d/98-whm-tls.conf', '/etc/dovecot/conf.d/99-whm-ssl.conf'], units: ['dovecot'] };
}

export function renderDovecotCertInclude(paths, { hasChain = false } = {}) {
  const lines = [`${MANAGED} (Manage Service SSL Certificates). Certificate files only: ssl=, protocols and ciphers live in 97-whm-mailserver.conf (Mailserver Configuration).`, `ssl_cert = <${paths.fullchain}`, `ssl_key = <${paths.key}`];
  if (hasChain) lines.push(`ssl_ca = <${paths.chain}`);
  return `${lines.join('\n')}\n`;
}

// Deletes panel-written files only (header check), so an admin's own drop-in
// that happens to share a name is left alone.
function removeManagedFiles(files, ctx) {
  const removed = [];
  for (const f of files) {
    const target = ctx.assertAllowedPath(f, 'write');
    const text = readText(target);
    if (text == null || !text.startsWith(MANAGED)) continue;
    fs.unlinkSync(target);
    removed.push(target);
  }
  return removed;
}

async function validateDovecot() {
  if (!hasBinary('doveconf')) return null;
  const { code, stderr, stdout } = await exec('doveconf', ['-n'], { allowFailure: true, timeoutMs: 60_000 });
  return { ok: code === 0, output: `${stderr}\n${stdout}`.trim() };
}

export function ftpLayout() {
  if (exists('/etc/pure-ftpd')) return { flavor: 'pure-ftpd', confDir: '/etc/pure-ftpd', units: ['pure-ftpd'] };
  if (exists('/etc/proftpd')) return { flavor: 'proftpd', confDir: '/etc/proftpd', units: ['proftpd'] };
  if (exists('/etc/vsftpd.conf')) return { flavor: 'vsftpd', confFile: '/etc/vsftpd.conf', units: ['vsftpd'] };
  return null;
}

// Writes an Apache include, validates the whole config and rolls back on error.
async function writeApacheInclude(apache, file, content) {
  const previous = readText(file);
  writeAtomic(file, content);
  if (!apache.bin) return { path: file, validated: false };
  const { code, stderr } = await exec(apache.bin, ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  if (code !== 0) {
    restore(file, previous);
    throw new OpError('config_invalid', `Apache rejected the new configuration; the previous file was restored: ${stderr.trim().split('\n').pop()}`, { output: stderr.trim() });
  }
  return { path: file, validated: true };
}

// ------------------------------------------------------- key / csr / cert ---

defineOp('ssl.key.generate', {
  description: 'Generate a private key with openssl genpkey (RSA 2048/3072/4096 or EC P-256/P-384)',
  schema: keySpec,
  run: async (spec) => {
    const keyPem = await generateKey(spec);
    const info = await inspectKey(keyPem);
    return { keyPem, ...info, publicKeyPem: undefined };
  },
});

defineOp('ssl.key.inspect', {
  description: 'Key type, size/curve and public key fingerprint of a PEM private key',
  schema: z.object({ keyPem: pem.key }).strict(),
  run: async ({ keyPem }) => inspectKey(keyPem),
});

defineOp('ssl.key.matches', {
  description: 'Whether a private key belongs to a certificate or CSR (public key comparison)',
  schema: z.object({ keyPem: pem.key, certPem: pem.cert.optional(), csrPem: pem.csr.optional() }).strict().refine((v) => v.certPem || v.csrPem, 'certPem or csrPem is required'),
  run: async ({ keyPem, certPem, csrPem }) => {
    requireOpenssl();
    const k = await publicKeyOf('key', keyPem);
    const other = certPem ? await publicKeyOf('cert', certPem) : await publicKeyOf('csr', csrPem);
    return { matches: k === other, publicKeySha256: crypto.createHash('sha256').update(k).digest('hex') };
  },
});

defineOp('ssl.csr.generate', {
  description: 'Generate a CSR (openssl req -new) for a key, with subject fields and DNS SANs',
  schema: z.object({ keyPem: pem.key, subject, sans }).strict(),
  run: async ({ keyPem, subject: s, sans: alt }) => {
    requireOpenssl();
    const csrPem = await withTempDir(async (_dir, put) => {
      const keyFile = put('key.pem', normalizePem(keyPem));
      const { stdout } = await exec('openssl', ['req', '-new', '-key', keyFile, '-subj', subjArg(s), '-addext', sanExt(s.CN, alt), '-utf8'], { timeoutMs: 60_000 });
      return normalizePem(stdout);
    });
    return { csrPem, subject: s, sans: [...new Set([s.CN, ...alt])] };
  },
});

defineOp('ssl.csr.inspect', {
  description: 'Subject, SANs and key details of a PEM certificate signing request',
  schema: z.object({ csrPem: pem.csr }).strict(),
  run: async ({ csrPem }) => {
    requireOpenssl();
    const input = normalizePem(csrPem);
    const fields = await exec('openssl', ['req', '-noout', '-subject', '-nameopt', 'RFC2253'], { input, allowFailure: true });
    if (fields.code !== 0) throw new OpError('invalid_csr', `openssl could not parse the CSR: ${fields.stderr.trim().split('\n').pop()}`);
    const text = await exec('openssl', ['req', '-noout', '-text'], { input, allowFailure: true });
    const dn = parseDn(fields.stdout.match(/^subject=(.*)$/m)?.[1] || '');
    const sanLine = text.stdout.match(/X509v3 Subject Alternative Name:[^\n]*\n\s*([^\n]+)/)?.[1] ?? '';
    return { subject: dn, commonName: dn.CN || null, sans: parseSans(sanLine), keyAlgorithm: text.stdout.match(/Public Key Algorithm: (\S+)/)?.[1]?.replace('Encryption', '').replace('id-ecPublicKey', 'EC').toUpperCase() ?? null, keyBits: Number(text.stdout.match(/Public-Key: \((\d+) bit\)/)?.[1]) || null };
  },
});

defineOp('ssl.selfsigned.generate', {
  description: 'Generate a self-signed certificate (and a key unless one is given)',
  schema: z.object({ keyPem: pem.key.optional(), key: keySpec.optional(), subject, sans, days: z.number().int().min(1).max(3650).default(365) }).strict(),
  run: async ({ keyPem, key, subject: s, sans: alt, days }) => {
    requireOpenssl();
    const useKey = keyPem ? normalizePem(keyPem) : await generateKey(keySpec.parse(key || {}));
    const certPem = await withTempDir(async (_dir, put) => {
      const keyFile = put('key.pem', useKey);
      const { stdout } = await exec('openssl', ['req', '-x509', '-new', '-key', keyFile, '-days', String(days), '-subj', subjArg(s), '-addext', sanExt(s.CN, alt), '-addext', 'basicConstraints=CA:FALSE', '-addext', 'keyUsage=digitalSignature,keyEncipherment', '-addext', 'extendedKeyUsage=serverAuth', '-utf8'], { timeoutMs: 60_000 });
      return normalizePem(stdout);
    });
    return { certPem, keyPem: useKey, certificate: await inspectCert(certPem) };
  },
});

defineOp('ssl.cert.inspect', {
  description: 'Subject, issuer, validity, SANs, fingerprint and key details of a PEM certificate',
  schema: z.object({ certPem: pem.cert }).strict(),
  run: async ({ certPem }) => inspectCert(certPem),
});

defineOp('ssl.cert.verify_chain', {
  description: 'Verify a certificate against its chain and the system CA store (openssl verify)',
  schema: z.object({ certPem: pem.cert, chainPem: pem.chain.optional(), hostname: certName.optional() }).strict(),
  run: async ({ certPem, chainPem, hostname }) => {
    requireOpenssl();
    return withTempDir(async (_dir, put) => {
      const certFile = put('cert.pem', normalizePem(certPem), 0o644);
      const argv = ['verify', '-show_chain'];
      if (chainPem) argv.push('-untrusted', put('chain.pem', normalizePem(chainPem), 0o644));
      if (hostname) argv.push('-verify_hostname', hostname.replace(/^\*\./, 'host.'));
      argv.push(certFile);
      const { code, stdout, stderr } = await exec('openssl', argv, { allowFailure: true, timeoutMs: 60_000 });
      const output = `${stdout}${stderr}`.replaceAll(certFile, 'cert.pem').trim();
      const depth = [...output.matchAll(/depth=(\d+)/g)].map((m) => Number(m[1]));
      return { ok: code === 0, output, chainLength: depth.length ? Math.max(...depth) + 1 : null, error: code === 0 ? null : output.match(/error \d+ at \d+ depth lookup: (.+)|error (.+)/)?.[1]?.trim() || output.split('\n').pop() };
    });
  },
});

// ------------------------------------------------------- domain bundles ---

defineOp('ssl.bundle.install_for_domain', {
  description: `Write cert/key/chain/fullchain for a domain under ${BUNDLE_ROOT}/<domain>/ (key 0600)`,
  schema: z.object({ domain: bundleDomain, certPem: pem.cert, keyPem: pem.key, chainPem: pem.chain.optional() }).strict(),
  run: async ({ domain, certPem, keyPem, chainPem }, ctx) => {
    const dir = ctx.assertAllowedPath(bundleDir(domain), 'write');
    requireOpenssl();
    await assertKeyMatches(keyPem, certPem);
    const paths = writeBundle(dir, { certPem, keyPem, chainPem });
    return { domain, paths, certificate: await inspectCert(certPem) };
  },
});

defineOp('ssl.bundle.read_for_domain', {
  description: `Read the bundle files of a domain from ${BUNDLE_ROOT}/<domain>/`,
  schema: z.object({ domain: bundleDomain, includeKey: z.boolean().default(false) }).strict(),
  run: async ({ domain, includeKey }, ctx) => {
    const dir = ctx.assertAllowedPath(bundleDir(domain), 'read');
    const paths = bundlePaths(dir);
    if (!exists(paths.cert)) return { domain, exists: false, paths };
    const certPem = readText(paths.cert);
    return { domain, exists: true, paths, certPem, chainPem: readText(paths.chain) || null, keyPem: includeKey ? readText(paths.key) : undefined, certificate: await inspectCert(certPem) };
  },
});

defineOp('ssl.bundle.remove_for_domain', {
  description: `Delete ${BUNDLE_ROOT}/<domain>/`,
  destructive: true,
  schema: z.object({ domain: bundleDomain }).strict(),
  run: async ({ domain }, ctx) => {
    const dir = ctx.assertAllowedPath(bundleDir(domain), 'write');
    const existed = exists(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { domain, removed: existed };
  },
});

defineOp('ssl.bundle.list', {
  description: `Every domain bundle under ${BUNDLE_ROOT}; directories in knownDomains (the panel already has their certificate) are listed without running openssl`,
  schema: z.object({ knownDomains: z.array(bundleDomain).max(20_000).default([]) }).strict(),
  run: async ({ knownDomains }, ctx) => {
    ctx.assertAllowedPath(BUNDLE_ROOT, 'read');
    const known = new Set(knownDomains);
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(BUNDLE_ROOT, { withFileTypes: true }); } catch { return { root: BUNDLE_ROOT, bundles: [] }; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'service') continue;
      const paths = bundlePaths(path.join(BUNDLE_ROOT, e.name));
      const certPem = readText(paths.cert);
      if (!certPem) continue;
      let certificate = null;
      if (!known.has(e.name)) { try { certificate = hasBinary('openssl') ? await inspectCert(certPem) : null; } catch { certificate = null; } }
      out.push({ domain: e.name, paths, hasKey: exists(paths.key), hasChain: (readText(paths.chain) || '').trim().length > 0, inspected: !known.has(e.name), certificate });
    }
    return { root: BUNDLE_ROOT, bundles: out.sort((a, b) => a.domain.localeCompare(b.domain)) };
  },
});

// ------------------------------------------------------ service certificates ---

// The file set that wires a service bundle into its daemon. `layouts` lets tests
// describe a host without touching /etc; production calls detect the real one.
export function serviceCopies(svc, paths, layouts = {}, { hasChain = false } = {}) {
  const layout = (key, detect) => (key in layouts ? layouts[key] : detect());
  const copies = [];
  if (svc === 'exim') {
    const exim = layout('exim', eximLayout);
    // Exim loads the key as its run user (Debian-exim / exim), so the key is 0640 root:<group>.
    if (exim) copies.push({ from: paths.fullchain, to: exim.cert, mode: 0o644 }, { from: paths.key, to: exim.key, mode: 0o640, groups: exim.groups });
  } else if (svc === 'dovecot') {
    const dc = layout('dovecot', dovecotLayout);
    if (dc) copies.push({ remove: dc.legacyIncludes }, { include: dc.sslInclude, content: renderDovecotCertInclude(paths, { hasChain }), mode: 0o644, validate: 'dovecot' });
  } else if (svc === 'apache') {
    const apache = layout('apache', apacheLayout);
    if (apache) copies.push({ apacheInclude: `${apache.includeDir}/zz-whm-service-ssl.conf`, content: `${MANAGED} (Manage Service SSL Certificates). Default certificate for SSL vhosts that set none.\n<IfModule ssl_module>\n  SSLCertificateFile ${paths.fullchain}\n  SSLCertificateKeyFile ${paths.key}\n</IfModule>\n` });
  } else if (svc === 'ftp') {
    const ftp = layout('ftp', ftpLayout);
    if (ftp?.flavor === 'pure-ftpd') {
      // pure-ftpd's CertFile must hold the certificate chain AND the private key
      // in one PEM (a separate KeyFile only exists from 1.0.47 on).
      const combined = path.join(paths.dir, 'pure-ftpd.pem');
      copies.push({ combine: combined, mode: 0o600 }, { include: `${ftp.confDir}/conf/CertFile`, content: `${combined}\n`, mode: 0o644 }, { include: `${ftp.confDir}/conf/TLS`, content: '1\n', mode: 0o644 });
    }
    if (ftp?.flavor === 'proftpd') copies.push({ include: `${ftp.confDir}/conf.d/whm-tls.conf`, content: `${MANAGED} (Manage Service SSL Certificates)\n<IfModule mod_tls.c>\n  TLSEngine on\n  TLSRSACertificateFile ${paths.fullchain}\n  TLSRSACertificateKeyFile ${paths.key}\n</IfModule>\n`, mode: 0o644 });
    if (ftp?.flavor === 'vsftpd') copies.push({ vsftpd: ftp.confFile });
  }
  return copies;
}

function applyVsftpd(file, paths) {
  const current = readText(file) || '';
  const settings = { ssl_enable: 'YES', rsa_cert_file: paths.fullchain, rsa_private_key_file: paths.key };
  const lines = current.split('\n').filter((l) => !Object.keys(settings).some((k) => new RegExp(`^\\s*#?\\s*${k}\\s*=`).test(l)));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${MANAGED} (Manage Service SSL Certificates)`, ...Object.entries(settings).map(([k, v]) => `${k}=${v}`));
  writeAtomic(file, `${lines.join('\n')}\n`, 0o644);
}

export const PANEL_TLS_DIR = '/etc/whm/tls';
export const PANEL_TLS_NOTE = `The panel listener reloads ${PANEL_TLS_DIR}/cert.pem and key.pem in place while whm.conf tlsCert/tlsKey (or WHM_TLS_CERT/WHM_TLS_KEY) point at them; otherwise point them there and restart whm-panel.`;

// The pair the panel listener serves. whm-panel.service runs as the non-root
// whmpanel user and install.sh creates the directory root:whmpanel 0750, so
// the key is handed to the directory's group (0640) instead of being locked
// to root; a root-owned directory (manual install) keeps it 0600. The owner
// is never changed: the agent runs as root, so a new file is root's already.
export function installPanelPair(dest, paths) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o750 });
  const { gid } = fs.statSync(dest);
  const files = [['cert.pem', paths.fullchain, 0o644], ['key.pem', paths.key, gid ? 0o640 : 0o600]];
  return files.map(([name, from, mode]) => {
    const file = path.join(dest, name);
    fs.copyFileSync(from, file);
    fs.chownSync(file, -1, gid);
    fs.chmodSync(file, mode);
    return file;
  });
}

async function installServiceCert(svc, { certPem, keyPem, chainPem }, ctx) {
  const dir = ctx.assertAllowedPath(path.join(SERVICE_ROOT, svc), 'write');
  requireOpenssl();
  await assertKeyMatches(keyPem, certPem);
  const paths = writeBundle(dir, { certPem, keyPem, chainPem });
  const applied = [];
  const removed = [];
  const notes = [];
  let validated = null;
  const copies = serviceCopies(svc, paths, {}, { hasChain: Boolean(chainPem) });
  for (const c of copies) {
    if (c.remove) { removed.push(...removeManagedFiles(c.remove, ctx)); }
    else if (c.combine) { ctx.assertAllowedPath(c.combine, 'write'); writeAtomic(c.combine, `${readText(paths.fullchain)}${readText(paths.key)}`, c.mode); applied.push(c.combine); }
    else if (c.to) {
      ctx.assertAllowedPath(c.to, 'write'); fs.mkdirSync(path.dirname(c.to), { recursive: true }); fs.copyFileSync(c.from, c.to); fs.chmodSync(c.to, c.mode);
      if (c.groups) {
        const group = groupId(c.groups);
        if (!group) notes.push(`${c.to} is readable by root only: none of the groups ${c.groups.join(', ')} exist, so the daemon cannot load the key.`);
        else { try { fs.chownSync(c.to, 0, group.gid); } catch (err) { notes.push(`${c.to} could not be handed to group ${group.name}: ${err.message}`); } }
      }
      applied.push(c.to);
    }
    else if (c.include) {
      const file = ctx.assertAllowedPath(c.include, 'write');
      const previous = readText(file);
      writeAtomic(file, c.content, c.mode);
      if (c.validate === 'dovecot') {
        const check = await validateDovecot();
        if (check && !check.ok) { restore(file, previous); throw new OpError('config_invalid', `Dovecot rejected the certificate drop-in; the previous file was restored: ${check.output.split('\n').filter(Boolean).pop()}`, { output: check.output }); }
        validated = check ? true : validated;
      }
      applied.push(file);
    }
    else if (c.apacheInclude) { ctx.assertAllowedPath(c.apacheInclude, 'write'); validated = (await writeApacheInclude(apacheLayout(), c.apacheInclude, c.content)).validated; applied.push(c.apacheInclude); }
    else if (c.vsftpd) { ctx.assertAllowedPath(c.vsftpd, 'write'); applyVsftpd(c.vsftpd, paths); applied.push(c.vsftpd); }
  }
  if (svc === 'exim') {
    const exim = eximLayout();
    if (exim?.tlsEnable) {
      // Debian advertises STARTTLS only while MAIN_TLS_ENABLE is defined: in split mode the
      // fragment sorts before 03_exim4-config_tlsoptions, in unsplit mode it is a block in
      // localmacros; either way it is validated like any include.
      const written = await writeEximFragment(exim, { path: exim.tlsEnable, block: exim.tlsEnableBlock }, `${MANAGED} (Manage Service SSL Certificates)\n.ifndef MAIN_TLS_ENABLE\nMAIN_TLS_ENABLE = true\n.endif\n`, ctx);
      validated = written.validated;
      applied.push(written.path);
    } else if (exim) notes.push(`Set tls_advertise_hosts = *, tls_certificate = ${exim.cert} and tls_privatekey = ${exim.key} in the main section of the Exim configuration.`);
  }
  if (svc === 'panel') {
    applied.push(...installPanelPair(ctx.assertAllowedPath(PANEL_TLS_DIR, 'write'), paths));
    notes.push(PANEL_TLS_NOTE);
  } else if (!copies.length) notes.push(`No ${svc} daemon configuration was found on this server; the bundle was stored under ${dir} only.`);
  const reload = copies.length ? await reloadUnit(SERVICE_UNITS[svc]) : { reloaded: false, unit: null };
  return { service: svc, paths, applied, removed, validated, reload, certificate: await inspectCert(certPem), note: notes.length ? notes.join(' ') : null };
}

defineOp('ssl.service_cert.install', {
  description: 'Install a certificate for exim, dovecot, apache, ftp or the panel: write the bundle, wire the daemon config and reload it',
  schema: z.object({ service, certPem: pem.cert, keyPem: pem.key, chainPem: pem.chain.optional() }).strict(),
  run: async ({ service: svc, ...pems }, ctx) => installServiceCert(svc, pems, ctx),
});

defineOp('ssl.service_cert.status', {
  description: 'Which services have a panel-installed certificate and when it expires',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(SERVICE_ROOT, 'read');
    const out = {};
    for (const svc of SERVICES) {
      const paths = bundlePaths(path.join(SERVICE_ROOT, svc));
      const certPem = readText(paths.cert);
      let certificate = null;
      if (certPem && hasBinary('openssl')) { try { certificate = await inspectCert(certPem); } catch { certificate = null; } }
      const installed = svc === 'exim' ? Boolean(eximLayout()) : svc === 'dovecot' ? Boolean(dovecotLayout()) : svc === 'apache' ? Boolean(apacheLayout()) : svc === 'ftp' ? Boolean(ftpLayout()) : true;
      out[svc] = { service: svc, daemonPresent: installed, hasCertificate: Boolean(certPem), paths, certificate };
    }
    return out;
  },
});

// ---------------------------------------------------------------- ACME ---

function acmeShPath() {
  return resolveBinary('acme.sh') || (exists(`${ACME_SH_HOME}/acme.sh`) ? `${ACME_SH_HOME}/acme.sh` : null);
}

export function detectAcme() {
  const certbot = hasBinary('certbot');
  const acmeSh = acmeShPath();
  return { certbot, acmeSh, providers: [certbot && 'certbot', acmeSh && 'acme.sh'].filter(Boolean), provider: certbot ? 'certbot' : acmeSh ? 'acme.sh' : null };
}

function requireProvider(provider) {
  const d = detectAcme();
  if (provider === 'certbot' && !d.certbot) throw new OpError('capability_missing', 'certbot is not installed on this server');
  if (provider === 'acme.sh' && !d.acmeSh) throw new OpError('capability_missing', `acme.sh is not installed (expected in PATH or ${ACME_SH_HOME}/acme.sh)`);
  return d;
}

const acmeEnv = { HOME: '/root', LE_WORKING_DIR: ACME_SH_HOME };
const tail = (s, n = 60) => String(s || '').trim().split('\n').slice(-n).join('\n');

// The split-mode socket client gives up after 600 s, so every ACME run (issue +
// acme.sh --install-cert) must finish, or fail, inside that: a run the panel has
// already reported as timed out must never complete behind its back.
export const ACME_OP_TIMEOUT_MS = 540_000;
const ACME_EXEC_TIMEOUT_MS = 480_000;

const acmeIssueSchema = z.object({
  provider: acmeProvider,
  domains: z.array(certName).min(1).max(100),
  email: acmeEmail.optional(),
  method: z.enum(['webroot', 'standalone']).default('webroot'),
  webroot: arg.absPath.optional(),
  staging: z.boolean().default(false),
  keyType: z.enum(['rsa', 'ecdsa']).default('ecdsa'),
  force: z.boolean().default(false),
}).strict().refine((v) => v.method !== 'webroot' || v.webroot, { message: 'webroot is required for the webroot method', path: ['webroot'] })
  .refine((v) => !v.domains.some((d) => d.startsWith('*.')), { message: 'Wildcard names need DNS validation, which webroot/standalone cannot do', path: ['domains'] });

function certbotLive(name) {
  const dir = path.join(LETSENCRYPT_LIVE, name);
  return { dir, cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'privkey.pem'), chain: path.join(dir, 'chain.pem'), fullchain: path.join(dir, 'fullchain.pem') };
}

defineOp('ssl.acme.detect', { description: 'Which ACME clients (certbot, acme.sh) exist on this server', run: async () => detectAcme() });

defineOp('ssl.acme.issue', {
  description: 'Issue or renew a certificate through certbot or acme.sh (webroot or standalone) and store it under /etc/ssl/whm/<domain>/',
  timeoutMs: ACME_OP_TIMEOUT_MS,
  schema: acmeIssueSchema,
  run: async ({ provider, domains, email, method, webroot, staging, keyType, force }, ctx) => {
    requireProvider(provider);
    requireOpenssl();
    const primary = domains[0];
    const target = ctx.assertAllowedPath(bundleDir(primary), 'write');
    if (webroot) ctx.assertAllowedPath(webroot, 'read');
    const dArgs = domains.flatMap((d) => ['-d', d]);
    let output = '';
    let renewed = false;
    let pems;
    if (provider === 'certbot') {
      ctx.assertAllowedPath(LETSENCRYPT_LIVE, 'read');
      const argv = ['certonly', '--non-interactive', '--agree-tos', '--no-eff-email', '--cert-name', primary, '--key-type', keyType, ...dArgs];
      argv.push(email ? '-m' : '--register-unsafely-without-email');
      if (email) argv.push(email);
      argv.push(...(method === 'webroot' ? ['--webroot', '-w', webroot] : ['--standalone']));
      if (staging) argv.push('--test-cert');
      argv.push(force ? '--force-renewal' : '--keep-until-expiring');
      const res = await exec('certbot', argv, { allowFailure: true, timeoutMs: ACME_EXEC_TIMEOUT_MS });
      output = tail(`${res.stdout}\n${res.stderr}`);
      if (res.code !== 0) throw new OpError('acme_failed', `certbot failed: ${tail(res.stderr || res.stdout, 3)}`, { output });
      renewed = /Successfully received certificate|Congratulations/i.test(res.stdout) || force;
      const live = certbotLive(primary);
      pems = { certPem: readText(live.cert), keyPem: readText(live.key), chainPem: readText(live.chain) || undefined };
      if (!pems.certPem || !pems.keyPem) throw new OpError('acme_failed', `certbot reported success but ${live.dir} has no certificate`, { output });
    } else {
      const bin = acmeShPath();
      const argv = ['--issue', '--server', staging ? 'letsencrypt_test' : 'letsencrypt', ...dArgs, '--keylength', keyType === 'rsa' ? '2048' : 'ec-256'];
      argv.push(...(method === 'webroot' ? ['-w', webroot] : ['--standalone']));
      if (email) argv.push('--accountemail', email);
      if (force) argv.push('--force');
      const res = await exec(bin, argv, { allowFailure: true, timeoutMs: ACME_EXEC_TIMEOUT_MS, env: acmeEnv });
      output = tail(`${res.stdout}\n${res.stderr}`);
      // Exit status 2 means "not due for renewal yet"; everything else non-zero is a failure.
      if (res.code !== 0 && res.code !== 2) throw new OpError('acme_failed', `acme.sh failed: ${tail(res.stdout || res.stderr, 3)}`, { output });
      renewed = res.code === 0;
      const paths = bundlePaths(target);
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      const install = await exec(bin, ['--install-cert', '-d', primary, ...(keyType === 'rsa' ? [] : ['--ecc']), '--key-file', paths.key, '--cert-file', paths.cert, '--ca-file', paths.chain, '--fullchain-file', paths.fullchain], { allowFailure: true, timeoutMs: ACME_OP_TIMEOUT_MS - ACME_EXEC_TIMEOUT_MS, env: acmeEnv });
      if (install.code !== 0) throw new OpError('acme_failed', `acme.sh --install-cert failed: ${tail(install.stdout || install.stderr, 3)}`, { output: tail(`${install.stdout}\n${install.stderr}`) });
      pems = { certPem: readText(paths.cert), keyPem: readText(paths.key), chainPem: readText(paths.chain) || undefined };
      if (!pems.certPem || !pems.keyPem) throw new OpError('acme_failed', 'acme.sh installed no certificate files', { output });
    }
    const paths = writeBundle(target, pems);
    return { provider, domains, primary, renewed, paths, ...pems, certificate: await inspectCert(pems.certPem), output };
  },
});

// Called when an AutoSSL certificate is uninstalled or its account terminated, so
// the client's own timer stops renewing a name whose docroot is gone.
defineOp('ssl.acme.remove', {
  description: 'Stop managing a certificate in the ACME client (certbot delete / acme.sh --remove)',
  destructive: true,
  schema: z.object({ provider: acmeProvider, name: certName }).strict(),
  run: async ({ provider, name }) => {
    requireProvider(provider);
    const res = provider === 'certbot'
      ? await exec('certbot', ['delete', '--non-interactive', '--cert-name', name], { allowFailure: true, timeoutMs: 120_000 })
      : await exec(acmeShPath(), ['--remove', '-d', name, '--home', ACME_SH_HOME], { allowFailure: true, timeoutMs: 120_000, env: acmeEnv });
    return { provider, name, removed: res.code === 0, output: tail(`${res.stdout}\n${res.stderr}`, 20) };
  },
});

// -------------------------------------------------------- TLS policy includes ---

const tlsPolicy = z.object({
  protocols: z.array(tlsProtocol).min(1).max(4),
  ciphers: cipherList,
  ciphersuites: z.string().regex(/^[A-Za-z0-9_:]{0,512}$/).default(''),
  preferServerCiphers: z.boolean().default(true),
  hsts: z.object({ enabled: z.boolean(), maxAge: z.number().int().min(0).max(63_072_000).default(31_536_000), includeSubdomains: z.boolean().default(true), preload: z.boolean().default(false) }).strict(),
}).strict();

export function renderApacheTls(p) {
  const all = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
  const proto = ['all', ...all.filter((v) => !p.protocols.includes(v)).map((v) => `-${v}`)].join(' ');
  const lines = [`${MANAGED} (SSL/TLS Configuration). Protocols, ciphers and HSTS for every SSL vhost.`, '<IfModule ssl_module>', `  SSLProtocol ${proto}`, `  SSLCipherSuite ${p.ciphers}`];
  if (p.ciphersuites && p.protocols.includes('TLSv1.3')) lines.push(`  SSLCipherSuite TLSv1.3 ${p.ciphersuites}`);
  lines.push(`  SSLHonorCipherOrder ${p.preferServerCiphers ? 'on' : 'off'}`, '  SSLSessionTickets off', '</IfModule>');
  if (p.hsts.enabled) lines.push('<IfModule headers_module>', `  Header always set Strict-Transport-Security "max-age=${p.hsts.maxAge}${p.hsts.includeSubdomains ? '; includeSubDomains' : ''}${p.hsts.preload ? '; preload' : ''}" "expr=%{HTTPS} == 'on'"`, '</IfModule>');
  return `${lines.join('\n')}\n`;
}

// Exim has no tls_prefer_server_ciphers option: server preference is an
// openssl_options flag, or %SERVER_PRECEDENCE in a GnuTLS priority string. A
// GnuTLS build cannot take the OpenSSL cipher list, so only the protocol floor
// and preference are expressed there.
const GNUTLS_VERSIONS = { 'TLSv1': 'VERS-TLS1.0', 'TLSv1.1': 'VERS-TLS1.1', 'TLSv1.2': 'VERS-TLS1.2', 'TLSv1.3': 'VERS-TLS1.3' };

export function renderEximTls(p, { library = 'openssl' } = {}) {
  const all = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
  const min = all.find((v) => p.protocols.includes(v)) || 'TLSv1.3';
  if (library === 'gnutls') {
    const priority = ['NORMAL', '-VERS-ALL', ...all.filter((v) => p.protocols.includes(v)).map((v) => `+${GNUTLS_VERSIONS[v]}`), ...(p.preferServerCiphers ? ['%SERVER_PRECEDENCE'] : [])];
    return `${MANAGED} (SSL/TLS Configuration). Minimum protocol ${min}; GnuTLS build, so the policy is a priority string.\ntls_require_ciphers = ${priority.join(':')}\n`;
  }
  const options = ['+no_sslv2', '+no_sslv3', ...all.filter((v) => !p.protocols.includes(v)).map((v) => `+no_${v.toLowerCase().replace('.', '_')}`), '+single_dh_use', '+no_ticket', ...(p.preferServerCiphers ? ['+cipher_server_preference'] : [])];
  return `${MANAGED} (SSL/TLS Configuration). Minimum protocol ${min}.\ntls_require_ciphers = ${p.ciphers}\nopenssl_options = ${options.join(' ')}\n`;
}

// Dovecot's protocol floor and ciphers are Service Configuration's
// (97-whm-mailserver.conf); the panel service hands the preset to it, so this
// family never renders a Dovecot TLS include any more.

// Removes the Exim TLS fragment earlier builds wrote once Service Configuration
// renders those options itself (two definitions of tls_require_ciphers would
// make Exim refuse its configuration). Validated and restored like any write.
async function removeEximTlsFragment(exim, ctx) {
  const file = ctx.assertAllowedPath(exim.tlsInclude, 'write');
  const previous = readText(file);
  if (previous == null) return { path: file, removed: false, validated: false };
  if (exim.tlsBlock) {
    if (readEximBlock(previous, exim.tlsBlock) == null) return { path: file, removed: false, validated: false };
    const written = await writeEximInclude(exim, file, stripEximBlock(previous, exim.tlsBlock));
    return { ...written, removed: true };
  }
  if (!previous.startsWith(MANAGED)) return { path: file, removed: false, validated: false };
  fs.unlinkSync(file);
  if (exim.validate) {
    const [bin, argv] = exim.validate;
    const { code, stdout, stderr } = await exec(bin, argv, { allowFailure: true, timeoutMs: 60_000 });
    if (code !== 0) { restore(file, previous); throw new OpError('config_invalid', `Exim rejected the configuration without the panel's TLS fragment; it was restored: ${`${stderr}\n${stdout}`.trim().split('\n').filter(Boolean).pop() || `exit status ${code}`}`); }
  }
  return { path: file, removed: true, validated: Boolean(exim.validate) };
}

defineOp('ssl.tls_config.status', {
  description: 'Which daemons exist and what the panel-managed TLS includes currently contain',
  run: async () => {
    const apache = apacheLayout();
    const exim = eximLayout();
    const dovecot = dovecotLayout();
    const read = (f) => (f ? readText(f) : null);
    return {
      apache: apache ? { present: true, path: `${apache.includeDir}/zz-whm-tls.conf`, content: read(`${apache.includeDir}/zz-whm-tls.conf`) } : { present: false },
      exim: exim ? { present: true, path: exim.tlsInclude, block: exim.tlsBlock, splitConfig: exim.splitConfig, includeMode: exim.includeMode, library: await detectEximTlsLibrary(exim).catch(() => null), content: exim.tlsBlock ? readEximBlock(read(exim.tlsInclude), exim.tlsBlock) : read(exim.tlsInclude) } : { present: false },
      dovecot: dovecot ? { present: true, path: dovecot.sslInclude, content: read(dovecot.sslInclude), legacy: dovecot.legacyIncludes.filter(exists), managedBy: 'service-configuration' } : { present: false },
    };
  },
});

defineOp('ssl.tls_config.apply', {
  description: 'Render the TLS policy into managed includes for Apache (and Exim when Service Configuration does not own it), validated and rolled back on error, then reload; removeLegacy drops includes this category used to write for exim/dovecot',
  schema: z.object({ policy: tlsPolicy, services: z.array(z.enum(['apache', 'exim'])).default(['apache']), removeLegacy: z.array(z.enum(['exim', 'dovecot'])).default([]) }).strict(),
  run: async ({ policy, services, removeLegacy }, ctx) => {
    const results = {};
    const removed = {};
    const apache = apacheLayout();
    if (services.includes('apache') && apache) {
      const file = ctx.assertAllowedPath(`${apache.includeDir}/zz-whm-tls.conf`, 'write');
      const written = await writeApacheInclude(apache, file, renderApacheTls(policy));
      results.apache = { ...written, reload: await reloadUnit(apache.units) };
    }
    const exim = eximLayout();
    if (services.includes('exim') && exim) {
      const library = await detectEximTlsLibrary(exim);
      const written = await writeEximFragment(exim, { path: exim.tlsInclude, block: exim.tlsBlock }, renderEximTls(policy, { library }), ctx);
      // Only a layout the panel cannot hook (RHEL-style single file) needs the admin's .include;
      // until then the file is not read, so it is reported as not applied rather than reloaded.
      const manual = exim.includeMode === 'manual';
      results.exim = { ...written, library, includeMode: exim.includeMode, note: manual ? `Add ".include ${written.path}" to the main section of the Exim configuration for this to take effect.` : null, reload: manual ? { reloaded: false, unit: null } : await reloadUnit(exim.units) };
    } else if (removeLegacy.includes('exim') && exim) {
      removed.exim = await removeEximTlsFragment(exim, ctx);
      if (removed.exim.removed && exim.includeMode !== 'manual') removed.exim.reload = await reloadUnit(exim.units);
    }
    const dovecot = dovecotLayout();
    if (removeLegacy.includes('dovecot') && dovecot) {
      const files = removeManagedFiles(dovecot.legacyIncludes, ctx);
      removed.dovecot = { files, removed: files.length > 0, reload: files.length ? await reloadUnit(dovecot.units) : { reloaded: false, unit: null } };
    }
    if (!Object.keys(results).length && !Object.keys(removed).length) throw new OpError('capability_missing', 'None of Apache or Exim is installed, so there is nothing to apply the TLS policy to');
    return { applied: Object.keys(results), results, removed };
  },
});

export { SERVICES as SSL_SERVICES, BUNDLE_ROOT as SSL_BUNDLE_ROOT, SERVICE_ROOT as SSL_SERVICE_ROOT, bundlePaths };
