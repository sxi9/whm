import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';

// Web op family: Apache (Debian apache2 or RHEL httpd layout) virtual hosts,
// the panel's global include, MPM switching, status; PHP-FPM per-account pools;
// FTP daemon configuration (pure-ftpd / proftpd / vsftpd) and daemon selection
// for the ftp and dns roles; logrotate policies; managed Dovecot and Exim
// includes. Every write is validated with the daemon's own config test and
// rolled back when it is rejected, then the unit is reloaded.

const MANAGED = '# Managed by WHM panel';
const VHOST_MARK = '# whm-vhost ';
// Apache opens its log files as root and follows symlinks, so per-domain logs
// never live in a directory the account can write to: root-owned, group = the
// account so it can still read them.
export const DOMLOGS_ROOT = '/var/log/whm/domlogs';
export const domlogDir = (user) => `${DOMLOGS_ROOT}/${user}`;

// ---------------------------------------------------------------- helpers ---

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// Backups of overwritten files live under /var/lib/whm, never next to the
// file: /etc/logrotate.d and pure-ftpd's conf/ parse every entry in the
// directory, so a sibling copy would be read as a second configuration.
const BACKUP_ROOT = '/var/lib/whm/backups/config';
const backupPath = (file) => path.join(BACKUP_ROOT, file);

function writeAtomic(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (exists(file)) { try { fs.mkdirSync(path.dirname(backupPath(file)), { recursive: true }); fs.copyFileSync(file, backupPath(file)); } catch { /* best effort */ } }
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  dropLegacyBackup(file);
}

// Earlier releases left <file>.whm-bak beside the file.
function dropLegacyBackup(file) {
  try { fs.unlinkSync(`${file}.whm-bak`); } catch { /* none */ }
}

function restore(file, previous) {
  if (previous == null) { try { fs.unlinkSync(file); } catch { /* already gone */ } } else fs.writeFileSync(file, previous);
}

function restoreAll(list) {
  for (const { file, content } of list) restore(file, content);
}

function passwdEntry(name) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? { name, uid: Number(line.split(':')[2]), gid: Number(line.split(':')[3]), home: line.split(':')[5] } : null;
}

// Creates <dir> for a tenant's Apache logs (0750 root:<gid>, traversable
// parents) and refuses one that is a symlink or not owned by root.
function ensureRootLogDir(dir, gid) {
  const parents = [];
  for (let p = path.dirname(dir); p !== '/' && !exists(p); p = path.dirname(p)) parents.unshift(p);
  for (const p of parents) { fs.mkdirSync(p, { mode: 0o755 }); fs.chmodSync(p, 0o755); }
  let st = null;
  try { st = fs.lstatSync(dir); } catch { st = null; }
  if (!st) {
    fs.mkdirSync(dir, { mode: 0o750 });
    fs.chmodSync(dir, 0o750);
    fs.chownSync(dir, 0, gid ?? 0);
    return dir;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OpError('refused', `${dir} is not a directory; refusing to log there`);
  if (st.uid !== 0) throw new OpError('refused', `${dir} is not owned by root; Apache logs must live in a root-owned directory`);
  if (st.mode & 0o022) fs.chmodSync(dir, st.mode & 0o7755 & ~0o022);
  return dir;
}

const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
const ensureNl = (s) => (s.endsWith('\n') ? s : `${s}\n`);

let unitCache = { at: 0, units: null };
async function knownUnits() {
  if (unitCache.units && Date.now() - unitCache.at < 15_000) return unitCache.units;
  if (!hasBinary('systemctl')) return new Set();
  const { stdout } = await exec('systemctl', ['list-unit-files', '--type=service', '--no-legend', '--no-pager', '--plain'], { allowFailure: true });
  const units = new Set();
  for (const line of stdout.split('\n')) {
    const name = line.trim().split(/\s+/)[0];
    if (name?.endsWith('.service')) units.add(name.replace(/\.service$/, ''));
  }
  unitCache = { at: Date.now(), units };
  return units;
}

async function firstUnit(candidates) {
  const units = await knownUnits();
  return candidates.find((u) => units.has(u)) || null;
}

async function unitState(unit) {
  if (!unit || !hasBinary('systemctl')) return { unit, present: false, active: false, state: null, enabled: null };
  const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '--no-pager', '--property=ActiveState,SubState,UnitFileState,LoadState,MainPID,NRestarts'], { allowFailure: true });
  const kv = Object.fromEntries(stdout.trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  return { unit, present: Boolean(kv.LoadState) && kv.LoadState !== 'not-found', active: kv.ActiveState === 'active', state: kv.ActiveState || null, subState: kv.SubState || null, enabled: kv.UnitFileState === 'enabled' || kv.UnitFileState === 'static', unitFileState: kv.UnitFileState || null, pid: Number(kv.MainPID) || null, restarts: Number(kv.NRestarts) || 0 };
}

async function reloadUnit(candidates, verb = 'reload-or-restart') {
  const unit = await firstUnit(candidates);
  if (!unit) return { reloaded: false, unit: null, error: 'no systemd unit found' };
  const { code, stderr } = await exec('systemctl', [verb, `${unit}.service`], { allowFailure: true, timeoutMs: 180_000 });
  unitCache.at = 0;
  return { reloaded: code === 0, unit, verb, error: code === 0 ? null : lastLine(stderr) };
}

// ---------------------------------------------------------------- layouts ---

export function apacheLayout() {
  if (exists('/etc/apache2')) {
    return {
      flavor: 'debian', root: '/etc/apache2', bin: ['apache2ctl', 'apachectl'].find(hasBinary) || null,
      sitesAvailable: '/etc/apache2/sites-available', sitesEnabled: '/etc/apache2/sites-enabled',
      confAvailable: '/etc/apache2/conf-available', confEnabled: '/etc/apache2/conf-enabled',
      modsAvailable: '/etc/apache2/mods-available', modsEnabled: '/etc/apache2/mods-enabled',
      globalInclude: '/etc/apache2/conf-available/whm.conf', globalEnabled: '/etc/apache2/conf-enabled/whm.conf',
      logDir: '/var/log/apache2', runUser: 'www-data', units: ['apache2'], a2tools: hasBinary('a2enmod') && hasBinary('a2dismod'),
    };
  }
  if (exists('/etc/httpd')) {
    return {
      flavor: 'rhel', root: '/etc/httpd', bin: ['httpd', 'apachectl'].find(hasBinary) || null,
      confD: '/etc/httpd/conf.d', globalInclude: '/etc/httpd/conf.d/whm.conf', mpmConf: '/etc/httpd/conf.modules.d/00-mpm.conf',
      logDir: '/var/log/httpd', runUser: 'apache', units: ['httpd'], a2tools: false,
    };
  }
  return null;
}

export function nginxLayout() {
  if (!exists('/etc/nginx')) return null;
  const sites = exists('/etc/nginx/sites-available');
  return { root: '/etc/nginx', bin: hasBinary('nginx') ? 'nginx' : null, vhostDir: sites ? '/etc/nginx/sites-available' : '/etc/nginx/conf.d', sitesEnabled: sites ? '/etc/nginx/sites-enabled' : null, units: ['nginx'] };
}

function requireApache() {
  const apache = apacheLayout();
  if (!apache || !apache.bin) throw new OpError('capability_missing', 'Apache is not installed on this server (no /etc/apache2 or /etc/httpd with apache2ctl/httpd)');
  return apache;
}

function vhostFile(apache, domain) {
  return path.join(apache.flavor === 'debian' ? apache.sitesAvailable : apache.confD, `${domain}.conf`);
}

function vhostLink(apache, domain) {
  return apache.flavor === 'debian' ? path.join(apache.sitesEnabled, `${domain}.conf`) : null;
}

// PHP-FPM: Debian ships one tree per version under /etc/php/<ver>/fpm; RHEL
// ships a single /etc/php-fpm.d (or Remi SCL trees under /etc/opt/remi).
export function phpLayout() {
  const versions = [];
  try {
    for (const v of fs.readdirSync('/etc/php')) {
      if (!/^\d\.\d+$/.test(v) || !exists(`/etc/php/${v}/fpm/pool.d`)) continue;
      versions.push({ version: v, flavor: 'debian', poolDir: `/etc/php/${v}/fpm/pool.d`, bin: hasBinary(`php-fpm${v}`) ? `php-fpm${v}` : null, units: [`php${v}-fpm`], socketDir: '/run/php', listenOwner: 'www-data' });
    }
  } catch { /* no /etc/php */ }
  try {
    for (const d of fs.readdirSync('/etc/opt/remi')) {
      const m = d.match(/^php(\d)(\d+)$/);
      if (m && exists(`/etc/opt/remi/${d}/php-fpm.d`)) versions.push({ version: `${m[1]}.${m[2]}`, flavor: 'remi', poolDir: `/etc/opt/remi/${d}/php-fpm.d`, bin: hasBinary(`${d}-php-fpm`) ? `${d}-php-fpm` : null, units: [`${d}-php-fpm`], socketDir: `/var/opt/remi/${d}/run/php-fpm`, listenOwner: 'apache' });
    }
  } catch { /* no remi */ }
  if (exists('/etc/php-fpm.d')) {
    let version = null;
    if (hasBinary('php')) { try { version = fs.readlinkSync('/etc/alternatives/php').match(/php(\d\.\d+)/)?.[1] || null; } catch { version = null; } }
    versions.push({ version: version || 'system', flavor: 'rhel', poolDir: '/etc/php-fpm.d', bin: hasBinary('php-fpm') ? 'php-fpm' : null, units: ['php-fpm'], socketDir: '/run/php-fpm', listenOwner: 'apache' });
  }
  return { versions: versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })), installed: versions.length > 0 };
}

export function phpSocket(version, user) {
  const tree = phpLayout().versions.find((v) => v.version === version) || phpLayout().versions[0];
  const dir = tree?.socketDir || '/run/php';
  return `${dir}/php${version === 'system' ? '' : version}-fpm-${user}.sock`;
}

export function ftpLayout() {
  const out = { daemons: [] };
  if (exists('/etc/pure-ftpd')) out.daemons.push({ name: 'pure-ftpd', bin: ['pure-ftpd', 'pure-ftpd-wrapper'].find(hasBinary) || null, confDir: '/etc/pure-ftpd', style: exists('/etc/pure-ftpd/conf') ? 'debian-dir' : 'file', confFile: exists('/etc/pure-ftpd/conf') ? null : '/etc/pure-ftpd/pure-ftpd.conf', units: ['pure-ftpd', 'pure-ftpd-mysql'] });
  if (exists('/etc/proftpd')) out.daemons.push({ name: 'proftpd', bin: hasBinary('proftpd') ? 'proftpd' : null, confDir: '/etc/proftpd', confFile: exists('/etc/proftpd/proftpd.conf') ? '/etc/proftpd/proftpd.conf' : null, managedFile: '/etc/proftpd/conf.d/whm.conf', units: ['proftpd'] });
  const vsconf = ['/etc/vsftpd.conf', '/etc/vsftpd/vsftpd.conf'].find(exists);
  if (vsconf || hasBinary('vsftpd')) out.daemons.push({ name: 'vsftpd', bin: hasBinary('vsftpd') ? 'vsftpd' : null, confFile: vsconf || '/etc/vsftpd/vsftpd.conf', units: ['vsftpd'] });
  return out;
}

export function dovecotLayout() {
  const installed = hasBinary('dovecot');
  if (!installed && !exists('/etc/dovecot')) return null;
  return { installed, bin: installed ? 'dovecot' : null, confDir: '/etc/dovecot', dropinDir: '/etc/dovecot/conf.d', include: '/etc/dovecot/conf.d/97-whm-mailserver.conf', doveconf: hasBinary('doveconf'), units: ['dovecot'] };
}

export function eximLayout() {
  const bin = ['exim4', 'exim'].find(hasBinary) || null;
  let flavor = null;
  if (exists('/etc/exim4')) flavor = 'debian';
  else if (exists('/etc/exim') || exists('/etc/exim.conf')) flavor = 'rhel';
  if (!flavor && !bin) return null;
  const confDir = flavor === 'debian' ? '/etc/exim4' : '/etc/exim';
  const whmDir = `${confDir}/whm`;
  const split = flavor === 'debian' && exists('/etc/exim4/conf.d');
  const mainConf = flavor === 'debian' ? (split ? null : '/etc/exim4/exim4.conf.template') : ['/etc/exim/exim.conf', '/etc/exim.conf'].find(exists) || '/etc/exim/exim.conf';
  return {
    installed: Boolean(bin), bin, flavor, confDir, whmDir, splitConfig: split, mainConf, updateConf: hasBinary('update-exim4.conf'),
    units: flavor === 'debian' ? ['exim4', 'exim'] : ['exim', 'exim4'],
    slots: {
      // Debian's split config concatenates conf.d/main/* into the main section,
      // so a file there is live without any include line; ACL fragments are
      // pulled in through the CHECK_{RCPT,DATA}_LOCAL_ACL_FILE macros the
      // distribution ACLs .include (defined by the main slot when nothing else,
      // such as the Email category's localmacros, claimed them first).
      main: split ? { path: '/etc/exim4/conf.d/main/001_whm_service_config', hookable: true } : { path: `${whmDir}/service_config.conf`, hookable: false },
      acl_rcpt: { path: `${whmDir}/acl_rcpt_protect.conf`, hookable: split, macro: split ? 'CHECK_RCPT_LOCAL_ACL_FILE' : null },
      acl_data: { path: `${whmDir}/acl_data_whm.conf`, hookable: split, macro: split ? 'CHECK_DATA_LOCAL_ACL_FILE' : null },
    },
  };
}

// ---------------------------------------------------------------- schemas ---

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'lowercase slug');
const phpVersion = z.string().regex(/^(?:[5-9]\.[0-9]{1,2}|system)$/, 'PHP version such as 8.3');
const urlTarget = z.string().max(2048).regex(/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[^\s"'<>\\$]*)?$/, 'http(s) URL');
const urlPath = z.string().max(512).regex(/^\/[A-Za-z0-9._~\/-]*$/, 'URL path');
const redirect = z.object({ from: urlPath.default('/'), to: urlTarget, type: z.enum(['301', '302', 'permanent', 'temporary']).default('301'), matchWww: z.boolean().default(true), keepPath: z.boolean().default(true) }).strict();
// Paths rendered into a root-parsed daemon configuration: absolute, no `..`,
// and none of the characters that could end a directive or start a new one
// (whitespace, quotes, control characters, `;` for ini files, `:` because
// open_basedir lists are colon-joined).
export const confPath = z.string().min(1).max(4096).regex(/^\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._~+@=\/-]*$/, 'absolute path without spaces, quotes or ..');
const sslPaths = z.object({ cert: confPath, key: confPath, chain: confPath.nullable().optional(), fullchain: confPath.nullable().optional() }).strict();
const freeText = z.string().max(256 * 1024).regex(/^[^\0]*$/s);
const metaValue = z.union([z.string().max(128), z.number(), z.boolean(), z.null()]);
const emailAddress = z.string().max(254).regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/, 'Email address');
const sizeSpec = z.string().regex(/^\d{1,6}[kKmMgG]?$/, 'size such as 100M');
const logGlob = z.string().max(512).regex(/^\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._*\/-]+$/, 'absolute path or glob');
const hostList = z.array(arg.hostname).max(50);

// `bind` (set while nginx fronts Apache on 127.0.0.1:<port>) replaces the
// account IPs in the <VirtualHost> address; a null `sslPort` drops the TLS
// block because Apache no longer listens for HTTPS.
const vhostSchema = z.object({
  domain: arg.hostname, aliases: hostList.default([]), docroot: confPath, user: arg.username, group: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  ip: arg.ipv4.nullable().optional(), ipv6: arg.ipv6.nullable().optional(), bind: arg.ip.nullable().optional(), port: z.number().int().min(1).max(65535).default(80), sslPort: z.number().int().min(1).max(65535).nullable().default(443),
  phpVersion: phpVersion.nullable().optional(), ssl: sslPaths.nullable().optional(), redirects: z.array(redirect).max(100).default([]),
  customDirectives: freeText.default(''), logDir: confPath.optional(), serverAdmin: emailAddress.optional(), options: z.string().regex(/^[A-Za-z +-]{0,200}$/).optional(),
  meta: z.record(z.string().regex(/^[A-Za-z0-9_]{1,32}$/), metaValue).default({}), reload: z.boolean().default(true),
}).strict();

const mpmSchema = z.object({
  module: z.enum(['prefork', 'worker', 'event']).optional(), startServers: z.number().int().min(1).max(10_000).optional(), minSpareServers: z.number().int().min(1).max(10_000).optional(), maxSpareServers: z.number().int().min(1).max(10_000).optional(),
  minSpareThreads: z.number().int().min(1).max(100_000).optional(), maxSpareThreads: z.number().int().min(1).max(100_000).optional(), threadsPerChild: z.number().int().min(1).max(10_000).optional(),
  maxRequestWorkers: z.number().int().min(1).max(100_000).optional(), maxConnectionsPerChild: z.number().int().min(0).max(10_000_000).optional(), serverLimit: z.number().int().min(1).max(20_000).optional(),
}).strict();

const globalDirectives = z.object({
  timeout: z.number().int().min(1).max(86_400).optional(), keepAlive: z.boolean().optional(), maxKeepAliveRequests: z.number().int().min(0).max(100_000).optional(), keepAliveTimeout: z.number().int().min(1).max(3600).optional(),
  serverTokens: z.enum(['Prod', 'Major', 'Minor', 'Min', 'OS', 'Full']).optional(), serverSignature: z.enum(['On', 'Off', 'EMail']).optional(), traceEnable: z.enum(['on', 'off', 'extended']).optional(),
  hostnameLookups: z.enum(['On', 'Off', 'Double']).optional(), serverAdmin: emailAddress.optional(), directoryIndex: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).max(20).optional(),
  fileETag: z.enum(['None', 'MTime Size', 'INode MTime Size', 'All']).optional(), limitRequestBody: z.number().int().min(0).max(2_147_483_647).optional(), serverStatus: z.boolean().optional(),
  mpm: mpmSchema.optional(), customDirectives: freeText.optional(),
}).strict();

const poolSchema = z.object({
  user: arg.username, version: phpVersion, pm: z.enum(['ondemand', 'dynamic', 'static']).default('ondemand'),
  maxChildren: z.number().int().min(1).max(10_000).default(10), startServers: z.number().int().min(1).max(10_000).optional(), minSpareServers: z.number().int().min(1).max(10_000).optional(), maxSpareServers: z.number().int().min(1).max(10_000).optional(),
  processIdleTimeout: z.number().int().min(1).max(3600).default(10), maxRequests: z.number().int().min(0).max(1_000_000).default(500),
  memoryLimit: sizeSpec.default('256M'), uploadMaxFilesize: sizeSpec.default('64M'), postMaxSize: sizeSpec.default('64M'), maxExecutionTime: z.number().int().min(0).max(86_400).default(120),
  openBasedir: z.array(confPath).max(20).optional(), errorLog: confPath.optional(), tmpDir: confPath.optional(), reload: z.boolean().default(true),
}).strict();

const ftpSettings = z.object({
  passivePortMin: z.number().int().min(1024).max(65535).optional(), passivePortMax: z.number().int().min(1024).max(65535).optional(), passiveAddress: arg.ipv4.nullable().optional(),
  tls: z.enum(['off', 'optional', 'required']).optional(), maxClients: z.number().int().min(1).max(100_000).optional(), maxPerIp: z.number().int().min(1).max(10_000).optional(),
  anonymous: z.boolean().optional(), idleTimeoutMinutes: z.number().int().min(1).max(1440).optional(), chroot: z.boolean().optional(),
}).strict().refine((s) => s.passivePortMin == null || s.passivePortMax == null || s.passivePortMin <= s.passivePortMax, { message: 'passivePortMin must not exceed passivePortMax', path: ['passivePortMax'] });

const groupName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const logCreate = z.object({ mode: arg.mode, owner: arg.username.or(z.literal('root')), group: groupName }).strict();
const logSu = z.object({ user: arg.username.or(z.literal('root')), group: groupName }).strict();
const postrotateKind = z.enum(['none', 'apache-reload', 'nginx-reload', 'php-fpm-reload', 'exim-reload', 'dovecot-reload']);
// `stanzas` renders several blocks that share the options but differ in paths,
// su and postrotate (one per tenant directory, rotated as that tenant).
const logrotateSchema = z.object({
  name: slug, paths: z.array(logGlob).min(1).max(50), frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'yearly']).default('daily'), rotate: z.number().int().min(0).max(3650).default(14),
  compress: z.boolean().default(true), delaycompress: z.boolean().default(true), missingok: z.boolean().default(true), notifempty: z.boolean().default(true), dateext: z.boolean().default(false), copytruncate: z.boolean().default(false),
  maxSize: sizeSpec.nullable().optional(), minSize: sizeSpec.nullable().optional(), create: logCreate.nullable().optional(),
  su: logSu.nullable().optional(),
  postrotate: postrotateKind.default('none'), sharedscripts: z.boolean().default(true),
  stanzas: z.array(z.object({ paths: z.array(logGlob).min(1).max(50), su: logSu.nullable().optional(), create: logCreate.nullable().optional(), postrotate: postrotateKind.optional() }).strict()).max(10_000).optional(),
}).strict();

const ROLES = {
  ftp: [
    { name: 'pure-ftpd', label: 'Pure-FTPd', binaries: ['pure-ftpd', 'pure-ftpd-wrapper'], units: ['pure-ftpd', 'pure-ftpd-mysql'], packages: { apt: 'pure-ftpd', dnf: 'pure-ftpd', yum: 'pure-ftpd' } },
    { name: 'proftpd', label: 'ProFTPD', binaries: ['proftpd'], units: ['proftpd'], packages: { apt: 'proftpd-core', dnf: 'proftpd', yum: 'proftpd' } },
    { name: 'vsftpd', label: 'vsftpd', binaries: ['vsftpd'], units: ['vsftpd'], packages: { apt: 'vsftpd', dnf: 'vsftpd', yum: 'vsftpd' } },
  ],
  dns: [
    { name: 'bind', label: 'BIND (named)', binaries: ['named'], units: ['named', 'bind9'], packages: { apt: 'bind9', dnf: 'bind', yum: 'bind' } },
    { name: 'powerdns', label: 'PowerDNS Authoritative Server', binaries: ['pdns_server'], units: ['pdns'], packages: { apt: 'pdns-server', dnf: 'pdns', yum: 'pdns' } },
  ],
};
const role = z.enum(['ftp', 'dns']);

// -------------------------------------------------------------- rendering ---

// Quoting is a backstop behind confPath: anything the schema should have
// refused is an error here, never silently rewritten into a different path.
const q = (s) => {
  const str = String(s);
  if (/["'\\\s\0-\x1f\x7f]/.test(str)) throw new OpError('invalid_args', `"${str.replace(/[\0-\x1f\x7f]/g, '?')}" cannot be rendered into the Apache configuration`);
  return `"${str}"`;
};

const listenAddr = (addr, port) => (addr.includes(':') ? `[${addr}]:${port}` : `${addr}:${port}`);

export function renderRedirects(redirects, indent = '  ') {
  const lines = [];
  for (const r of redirects) {
    const code = { permanent: '301', temporary: '302' }[r.type] || r.type;
    const target = r.to.replace(/\/$/, '');
    const from = r.from.replace(/\/$/, '');
    const pattern = r.keepPath ? `^${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(.*)$` : `^${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    const dest = r.keepPath ? `${target}/$1` : r.to;
    // `from`/`to` are schema-restricted to URL-safe characters (no quotes), so
    // the regex escapes must survive quoting here.
    const rule = `RedirectMatch ${code} "${pattern}" "${dest}"`;
    if (r.matchWww) lines.push(`${indent}${rule}`);
    else lines.push(`${indent}<If "%{HTTP_HOST} !~ /^www\\./i">`, `${indent}  ${rule}`, `${indent}</If>`);
  }
  return lines;
}

function vhostBlock(v, { ssl, port }) {
  const addrs = v.bind ? [listenAddr(v.bind, port)] : [v.ip ? `${v.ip}:${port}` : null, v.ipv6 ? `[${v.ipv6}]:${port}` : null].filter(Boolean);
  const listen = addrs.length ? addrs.join(' ') : `*:${port}`;
  const logDir = v.logDir || domlogDir(v.user);
  const names = [...new Set([`www.${v.domain}`, ...v.aliases].filter((a) => a !== v.domain))];
  const lines = [`<VirtualHost ${listen}>`, `  ServerName ${v.domain}`];
  if (names.length) lines.push(`  ServerAlias ${names.join(' ')}`);
  lines.push(`  ServerAdmin ${v.serverAdmin || `webmaster@${v.domain}`}`, `  DocumentRoot ${q(v.docroot)}`, '  UseCanonicalName Off');
  lines.push(`  CustomLog ${q(`${logDir}/${v.domain}${ssl ? '-ssl' : ''}-access.log`)} combined`, `  ErrorLog ${q(`${logDir}/${v.domain}${ssl ? '-ssl' : ''}-error.log`)}`);
  lines.push('  <IfModule mod_userdir.c>', '    UserDir disabled', '  </IfModule>');
  lines.push(`  <Directory ${q(v.docroot)}>`, `    Options ${v.options || '-Indexes +FollowSymLinks'}`, '    AllowOverride All', '    Require all granted', '  </Directory>');
  if (v.phpVersion) {
    lines.push('  <IfModule proxy_fcgi_module>', '    <FilesMatch "\\.ph(ar|p|tml)$">', `      SetHandler "proxy:unix:${phpSocket(v.phpVersion, v.user)}|fcgi://localhost"`, '    </FilesMatch>', '  </IfModule>');
  }
  if (ssl) {
    lines.push('  SSLEngine on');
    if (v.ssl.fullchain) lines.push(`  SSLCertificateFile ${q(v.ssl.fullchain)}`);
    else { lines.push(`  SSLCertificateFile ${q(v.ssl.cert)}`); if (v.ssl.chain) lines.push(`  SSLCertificateChainFile ${q(v.ssl.chain)}`); }
    lines.push(`  SSLCertificateKeyFile ${q(v.ssl.key)}`);
    if (v.phpVersion) lines.push('  <IfModule proxy_fcgi_module>', '    SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1', '  </IfModule>');
  }
  if (v.redirects.length) lines.push('  # Redirects (Setup/Edit Domain Forwarding)', ...renderRedirects(v.redirects));
  if (v.customDirectives.trim()) lines.push('  # Custom directives', ...v.customDirectives.trim().split('\n').map((l) => `  ${l}`));
  lines.push('</VirtualHost>');
  return lines;
}

export function renderVhost(v) {
  const meta = { domain: v.domain, user: v.user, docroot: v.docroot, aliases: v.aliases, ip: v.ip ?? null, ipv6: v.ipv6 ?? null, bind: v.bind ?? null, phpVersion: v.phpVersion ?? null, ssl: Boolean(v.ssl && v.sslPort), redirects: v.redirects.length, ...v.meta };
  const lines = [`${MANAGED} (virtual host ${v.domain}). Edit through the panel; manual changes are overwritten.`, `${VHOST_MARK}${JSON.stringify(meta)}`, ''];
  lines.push(...vhostBlock(v, { ssl: false, port: v.port }));
  if (v.ssl && v.sslPort) lines.push('', '<IfModule ssl_module>', ...vhostBlock(v, { ssl: true, port: v.sslPort }), '</IfModule>');
  else if (v.ssl) lines.push('', '# TLS is terminated by the reverse proxy (Apache has no HTTPS listener); the certificate paths are kept in the panel.');
  return `${lines.join('\n')}\n`;
}

export function parseVhostMeta(text) {
  const line = (text || '').split('\n').find((l) => l.startsWith(VHOST_MARK));
  if (!line) return null;
  try { return JSON.parse(line.slice(VHOST_MARK.length)); } catch { return null; }
}

export function renderGlobalInclude(d) {
  const lines = [`${MANAGED} (Apache Configuration). Global directives; loaded after the distribution defaults so these values win.`];
  if (d.timeout != null) lines.push(`Timeout ${d.timeout}`);
  if (d.keepAlive != null) lines.push(`KeepAlive ${d.keepAlive ? 'On' : 'Off'}`);
  if (d.maxKeepAliveRequests != null) lines.push(`MaxKeepAliveRequests ${d.maxKeepAliveRequests}`);
  if (d.keepAliveTimeout != null) lines.push(`KeepAliveTimeout ${d.keepAliveTimeout}`);
  if (d.serverTokens) lines.push(`ServerTokens ${d.serverTokens}`);
  if (d.serverSignature) lines.push(`ServerSignature ${d.serverSignature}`);
  if (d.traceEnable) lines.push(`TraceEnable ${d.traceEnable}`);
  if (d.hostnameLookups) lines.push(`HostnameLookups ${d.hostnameLookups}`);
  if (d.serverAdmin) lines.push(`ServerAdmin ${d.serverAdmin}`);
  if (d.fileETag) lines.push(`FileETag ${d.fileETag}`);
  if (d.limitRequestBody != null) lines.push(`LimitRequestBody ${d.limitRequestBody}`);
  if (d.directoryIndex?.length) lines.push('<IfModule dir_module>', `  DirectoryIndex ${d.directoryIndex.join(' ')}`, '</IfModule>');
  if (d.mpm) {
    const m = d.mpm;
    const threaded = m.module !== 'prefork';
    const block = [];
    if (m.startServers != null) block.push(`  StartServers ${m.startServers}`);
    if (m.serverLimit != null) block.push(`  ServerLimit ${m.serverLimit}`);
    if (!threaded && m.minSpareServers != null) block.push(`  MinSpareServers ${m.minSpareServers}`);
    if (!threaded && m.maxSpareServers != null) block.push(`  MaxSpareServers ${m.maxSpareServers}`);
    if (threaded && m.minSpareThreads != null) block.push(`  MinSpareThreads ${m.minSpareThreads}`);
    if (threaded && m.maxSpareThreads != null) block.push(`  MaxSpareThreads ${m.maxSpareThreads}`);
    if (threaded && m.threadsPerChild != null) block.push(`  ThreadsPerChild ${m.threadsPerChild}`);
    if (m.maxRequestWorkers != null) block.push(`  MaxRequestWorkers ${m.maxRequestWorkers}`);
    if (m.maxConnectionsPerChild != null) block.push(`  MaxConnectionsPerChild ${m.maxConnectionsPerChild}`);
    if (block.length && m.module) lines.push(`<IfModule mpm_${m.module}_module>`, ...block, '</IfModule>');
  }
  if (d.serverStatus) lines.push('<IfModule status_module>', '  ExtendedStatus On', '  <Location "/server-status">', '    SetHandler server-status', '    Require local', '  </Location>', '</IfModule>');
  if (d.customDirectives?.trim()) lines.push('# Custom directives (include editor)', d.customDirectives.trim());
  return `${lines.join('\n')}\n`;
}

export function renderPhpPool(p, { listenOwner = 'www-data', socket, homeDir }) {
  const lines = [`; ${MANAGED.slice(2)} (PHP-FPM pool for ${p.user}, PHP ${p.version}). Edit through the panel; manual changes are overwritten.`, `[${p.user}]`, `user = ${p.user}`, `group = ${p.user}`, `listen = ${socket}`, `listen.owner = ${listenOwner}`, `listen.group = ${listenOwner}`, 'listen.mode = 0660', `pm = ${p.pm}`, `pm.max_children = ${p.maxChildren}`];
  if (p.pm === 'dynamic') {
    const start = p.startServers ?? Math.max(1, Math.min(p.maxChildren, 2));
    lines.push(`pm.start_servers = ${start}`, `pm.min_spare_servers = ${p.minSpareServers ?? Math.max(1, Math.min(start, p.maxChildren))}`, `pm.max_spare_servers = ${p.maxSpareServers ?? Math.max(start, Math.min(p.maxChildren, start * 2))}`);
  }
  if (p.pm === 'ondemand') lines.push(`pm.process_idle_timeout = ${p.processIdleTimeout}s`);
  lines.push(`pm.max_requests = ${p.maxRequests}`, 'catch_workers_output = yes', 'security.limit_extensions = .php .phar .phtml');
  lines.push(`php_admin_value[memory_limit] = ${p.memoryLimit}`, `php_admin_value[upload_max_filesize] = ${p.uploadMaxFilesize}`, `php_admin_value[post_max_size] = ${p.postMaxSize}`, `php_admin_value[max_execution_time] = ${p.maxExecutionTime}`);
  const tmp = p.tmpDir || `${homeDir}/tmp`;
  lines.push(`php_admin_value[upload_tmp_dir] = ${tmp}`, `php_admin_value[session.save_path] = ${tmp}`, `php_admin_value[sys_temp_dir] = ${tmp}`, `env[TMP] = ${tmp}`, `env[TMPDIR] = ${tmp}`, `env[TEMP] = ${tmp}`);
  lines.push(`php_admin_value[error_log] = ${p.errorLog || `${homeDir}/logs/php-error.log`}`, 'php_admin_flag[log_errors] = on', 'php_admin_flag[display_errors] = off');
  if (p.openBasedir?.length) lines.push(`php_admin_value[open_basedir] = ${p.openBasedir.join(':')}`);
  return `${lines.join('\n')}\n`;
}

const POSTROTATE = {
  'apache-reload': 'if command -v systemctl >/dev/null; then systemctl reload apache2.service >/dev/null 2>&1 || systemctl reload httpd.service >/dev/null 2>&1 || true; fi',
  'nginx-reload': 'if command -v systemctl >/dev/null; then systemctl reload nginx.service >/dev/null 2>&1 || true; fi',
  'php-fpm-reload': 'if command -v systemctl >/dev/null; then systemctl reload \'php*-fpm.service\' >/dev/null 2>&1 || systemctl reload php-fpm.service >/dev/null 2>&1 || true; fi',
  'exim-reload': 'if command -v systemctl >/dev/null; then systemctl reload exim4.service >/dev/null 2>&1 || systemctl reload exim.service >/dev/null 2>&1 || true; fi',
  'dovecot-reload': 'if command -v systemctl >/dev/null; then systemctl reload dovecot.service >/dev/null 2>&1 || true; fi',
};

export function renderLogrotate(l) {
  const lines = [`${MANAGED} (cPanel Log Rotation Configuration: ${l.name}). Edit through the panel; manual changes are overwritten.`];
  const blocks = l.stanzas?.length ? l.stanzas : [{ paths: l.paths, su: l.su, create: l.create, postrotate: l.postrotate }];
  for (const b of blocks) {
    lines.push(`${b.paths.join(' ')} {`);
    if (b.su) lines.push(`    su ${b.su.user} ${b.su.group}`);
    lines.push(`    ${l.frequency}`, `    rotate ${l.rotate}`);
    if (l.maxSize) lines.push(`    maxsize ${l.maxSize}`);
    if (l.minSize) lines.push(`    minsize ${l.minSize}`);
    for (const k of ['compress', 'delaycompress', 'missingok', 'notifempty', 'dateext', 'copytruncate']) if (l[k]) lines.push(`    ${k}`);
    if (!l.compress) lines.push('    nocompress');
    if (b.create) lines.push(`    create ${b.create.mode} ${b.create.owner} ${b.create.group}`);
    const post = POSTROTATE[b.postrotate ?? l.postrotate];
    if (post) { if (l.sharedscripts) lines.push('    sharedscripts'); lines.push('    postrotate', `        ${post}`, '    endscript'); }
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

// Replaces `key = value` / `key=value` style lines for the given keys and appends a
// managed block, so an operator's other settings in the same file are kept.
export function mergeKeyValueFile(current, settings, { sep = '=' } = {}) {
  const keys = Object.keys(settings);
  const owned = (l) => keys.some((k) => new RegExp(`^\\s*(?:#\\s*)?${k}(?:\\s*=|\\s)`).test(l));
  const lines = (current || '').split('\n').filter((l) => !owned(l) && !l.startsWith(MANAGED));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${MANAGED} (FTP Server Configuration). Values below override anything above.`, ...Object.entries(settings).filter(([, v]) => v != null).map(([k, v]) => `${k}${sep === ' ' ? ' ' : sep}${v}`));
  return `${lines.join('\n')}\n`;
}

export function renderProftpd(s) {
  const lines = [`${MANAGED} (FTP Server Configuration)`];
  if (s.passivePortMin != null && s.passivePortMax != null) lines.push(`PassivePorts ${s.passivePortMin} ${s.passivePortMax}`);
  if (s.passiveAddress) lines.push(`MasqueradeAddress ${s.passiveAddress}`);
  if (s.maxClients != null) lines.push(`MaxInstances ${s.maxClients}`, `MaxClients ${s.maxClients}`);
  if (s.maxPerIp != null) lines.push(`MaxClientsPerHost ${s.maxPerIp}`);
  if (s.idleTimeoutMinutes != null) lines.push(`TimeoutIdle ${s.idleTimeoutMinutes * 60}`);
  if (s.chroot != null) lines.push(s.chroot ? 'DefaultRoot ~' : '# DefaultRoot not enforced');
  if (s.tls) lines.push('<IfModule mod_tls.c>', `  TLSEngine ${s.tls === 'off' ? 'off' : 'on'}`, `  TLSRequired ${s.tls === 'required' ? 'on' : 'off'}`, '</IfModule>');
  return `${lines.join('\n')}\n`;
}

export function vsftpdSettings(s) {
  const out = {};
  if (s.passivePortMin != null) out.pasv_min_port = s.passivePortMin;
  if (s.passivePortMax != null) out.pasv_max_port = s.passivePortMax;
  if (s.passiveAddress !== undefined) { out.pasv_address = s.passiveAddress || null; out.pasv_enable = 'YES'; }
  if (s.tls) { out.ssl_enable = s.tls === 'off' ? 'NO' : 'YES'; out.force_local_logins_ssl = s.tls === 'required' ? 'YES' : 'NO'; out.force_local_data_ssl = s.tls === 'required' ? 'YES' : 'NO'; }
  if (s.maxClients != null) out.max_clients = s.maxClients;
  if (s.maxPerIp != null) out.max_per_ip = s.maxPerIp;
  if (s.anonymous != null) out.anonymous_enable = s.anonymous ? 'YES' : 'NO';
  if (s.idleTimeoutMinutes != null) out.idle_session_timeout = s.idleTimeoutMinutes * 60;
  if (s.chroot != null) { out.chroot_local_user = s.chroot ? 'YES' : 'NO'; if (s.chroot) out.allow_writeable_chroot = 'YES'; }
  out.local_enable = 'YES'; out.write_enable = 'YES';
  return out;
}

export function pureFtpdSettings(s) {
  const out = {};
  if (s.passivePortMin != null && s.passivePortMax != null) out.PassivePortRange = `${s.passivePortMin} ${s.passivePortMax}`;
  if (s.passiveAddress !== undefined) out.ForcePassiveIP = s.passiveAddress || null;
  if (s.tls) out.TLS = { off: '0', optional: '1', required: '2' }[s.tls];
  if (s.maxClients != null) out.MaxClientsNumber = String(s.maxClients);
  if (s.maxPerIp != null) out.MaxClientsPerIP = String(s.maxPerIp);
  if (s.anonymous != null) out.NoAnonymous = s.anonymous ? 'no' : 'yes';
  if (s.idleTimeoutMinutes != null) out.MaxIdleTime = String(s.idleTimeoutMinutes);
  if (s.chroot != null) out.ChrootEveryone = s.chroot ? 'yes' : 'no';
  return out;
}

export function parseServerStatus(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const num = (k) => (kv[k] != null && kv[k] !== '' && !Number.isNaN(Number(kv[k])) ? Number(kv[k]) : null);
  return {
    serverVersion: kv.ServerVersion || null, mpm: kv.ServerMPM || null, uptimeSeconds: num('ServerUptimeSeconds') ?? num('Uptime'), totalAccesses: num('Total Accesses'), totalKBytes: num('Total kBytes'),
    requestsPerSecond: num('ReqPerSec'), bytesPerSecond: num('BytesPerSec'), bytesPerRequest: num('BytesPerReq'), busyWorkers: num('BusyWorkers'), idleWorkers: num('IdleWorkers'), cpuLoad: num('CPULoad'),
    scoreboard: kv.Scoreboard || null, load: [num('Load1'), num('Load5'), num('Load15')], raw: kv,
  };
}

export function parseApacheVersion(stdout) {
  return { version: stdout.match(/Server version:\s*(.+)/)?.[1]?.trim() || null, built: stdout.match(/Server built:\s*(.+)/)?.[1]?.trim() || null, mpm: stdout.match(/Server MPM:\s*(\S+)/)?.[1]?.toLowerCase() || null, architecture: stdout.match(/Architecture:\s*(.+)/)?.[1]?.trim() || null };
}

export function parseModules(stdout) {
  return [...String(stdout || '').matchAll(/^\s*(\w+)_module\s+\((static|shared)\)/gm)].map((m) => ({ name: m[1], type: m[2] }));
}

function fetchServerStatus(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 80, path: '/server-status?auto', headers: { Host: 'localhost' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 65_536) body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && /ServerVersion|Total Accesses|BusyWorkers/.test(body) ? parseServerStatus(body) : null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function apacheInfo(apache) {
  if (!apache?.bin) return { version: null, built: null, mpm: null, modules: [] };
  const v = await exec(apache.bin, ['-V'], { allowFailure: true, timeoutMs: 30_000 });
  const m = await exec(apache.bin, ['-M'], { allowFailure: true, timeoutMs: 30_000 });
  return { ...parseApacheVersion(`${v.stdout}${v.stderr}`), modules: parseModules(`${m.stdout}${m.stderr}`) };
}

async function configtest(apache) {
  if (!apache.bin) return { ok: null, output: 'no apache2ctl/httpd binary; configuration not tested' };
  const { code, stdout, stderr } = await exec(apache.bin, ['-t'], { allowFailure: true, timeoutMs: 60_000 });
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0, output };
}

// Writes an Apache file, tests the whole configuration and restores the
// previous content when Apache rejects it.
async function writeApacheFile(apache, file, content, { link = null } = {}) {
  const previous = readText(file);
  const linkExisted = link ? exists(link) : null;
  writeAtomic(file, content);
  if (link && !linkExisted) { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(link), file), link); }
  const test = await configtest(apache);
  if (test.ok === false) {
    restore(file, previous);
    if (link && !linkExisted) { try { fs.unlinkSync(link); } catch { /* gone */ } }
    throw new OpError('config_invalid', `Apache rejected the new configuration; the previous file was restored: ${lastLine(test.output)}`, { output: test.output, path: file });
  }
  return { path: file, validated: test.ok === true, output: test.output, linked: Boolean(link) };
}

// ----------------------------------------------------------------- detect ---

defineOp('web.detect', {
  description: 'Web stack layout on this host: Apache flavor/version/MPM/modules, nginx, PHP-FPM trees, FTP daemons, Dovecot, Exim',
  run: async () => {
    const apache = apacheLayout();
    const info = await apacheInfo(apache);
    const unit = apache ? await unitState(await firstUnit(apache.units)) : null;
    const nginx = nginxLayout();
    const ftp = ftpLayout();
    for (const d of ftp.daemons) d.unit = await unitState(await firstUnit(d.units));
    const dovecot = dovecotLayout();
    const exim = eximLayout();
    return {
      apache: apache ? { installed: Boolean(apache.bin), ...apache, ...info, unit } : { installed: false },
      nginx: nginx ? { installed: Boolean(nginx.bin), ...nginx, unit: await unitState(await firstUnit(nginx.units)) } : { installed: false },
      php: phpLayout(),
      ftp,
      dovecot: dovecot ? { ...dovecot, unit: await unitState(await firstUnit(dovecot.units)) } : { installed: false },
      exim: exim ? { ...exim, unit: await unitState(await firstUnit(exim.units)) } : { installed: false },
      systemd: hasBinary('systemctl'), logrotate: hasBinary('logrotate'),
    };
  },
});

defineOp('web.status', {
  description: 'Apache runtime status: unit state, version, MPM, loaded modules and mod_status counters when enabled',
  run: async () => {
    const apache = apacheLayout();
    if (!apache || !apache.bin) return { installed: false };
    const info = await apacheInfo(apache);
    const unit = await unitState(await firstUnit(apache.units));
    const serverStatus = unit.active && info.modules.some((m) => m.name === 'status') ? await fetchServerStatus() : null;
    const vhostDir = apache.flavor === 'debian' ? apache.sitesAvailable : apache.confD;
    let vhosts = 0;
    try { vhosts = fs.readdirSync(vhostDir).filter((f) => f.endsWith('.conf') && (readText(path.join(vhostDir, f)) || '').includes(VHOST_MARK)).length; } catch { vhosts = 0; }
    return { installed: true, flavor: apache.flavor, bin: apache.bin, ...info, unit, serverStatus, statusModule: info.modules.some((m) => m.name === 'status'), managedVhosts: vhosts, globalInclude: { path: apache.globalInclude, exists: exists(apache.globalInclude), enabled: apache.flavor === 'debian' ? exists(apache.globalEnabled) : exists(apache.globalInclude) } };
  },
});

defineOp('web.configtest', {
  description: 'Run the Apache configuration test (apache2ctl -t / httpd -t)',
  run: async () => {
    const apache = requireApache();
    return { bin: apache.bin, ...(await configtest(apache)) };
  },
});

defineOp('web.reload', { description: 'Validate and reload Apache', run: async () => { const apache = requireApache(); const test = await configtest(apache); if (test.ok === false) throw new OpError('config_invalid', `Apache configuration is invalid: ${lastLine(test.output)}`, { output: test.output }); return { validated: test.ok === true, ...(await reloadUnit(apache.units)) }; } });
defineOp('web.restart', { description: 'Validate and restart Apache', destructive: true, run: async () => { const apache = requireApache(); const test = await configtest(apache); if (test.ok === false) throw new OpError('config_invalid', `Apache configuration is invalid: ${lastLine(test.output)}`, { output: test.output }); return { validated: test.ok === true, ...(await reloadUnit(apache.units, 'restart')) }; } });

// ----------------------------------------------------------------- vhosts ---

defineOp('web.vhost.write', {
  description: 'Render and install a virtual host (sites-available + sites-enabled symlink, or conf.d), validate with configtest (rolled back on error) and reload',
  schema: vhostSchema,
  run: async (v, ctx) => {
    // Every path is vetted before the daemon check so a bad caller learns
    // path_not_allowed even on a host without Apache.
    ctx.assertAllowedPath(v.docroot, 'read');
    const logDir = ctx.assertAllowedPath(v.logDir || domlogDir(v.user), 'write');
    if (v.ssl) for (const f of [v.ssl.cert, v.ssl.key, v.ssl.chain, v.ssl.fullchain].filter(Boolean)) ctx.assertAllowedPath(f, 'read');
    const apache = requireApache();
    const file = ctx.assertAllowedPath(vhostFile(apache, v.domain), 'write');
    const link = vhostLink(apache, v.domain);
    if (link) ctx.assertAllowedPath(link, 'write');
    ensureRootLogDir(logDir, passwdEntry(v.user)?.gid);
    if (v.ssl) { for (const f of [v.ssl.cert, v.ssl.key]) if (!exists(f)) throw new OpError('not_found', `Certificate file ${f} does not exist`); }
    const content = renderVhost({ ...v, logDir });
    const written = await writeApacheFile(apache, file, content, { link });
    const reload = v.reload ? await reloadUnit(apache.units) : { reloaded: false, unit: null };
    return { domain: v.domain, ...written, link, logDir, bytes: Buffer.byteLength(content), ssl: Boolean(v.ssl && v.sslPort), bind: v.bind ?? null, phpVersion: v.phpVersion ?? null, ...reload };
  },
});

defineOp('web.vhost.remove', {
  description: 'Remove a panel-managed virtual host file (and its sites-enabled link), then reload',
  destructive: true,
  schema: z.object({ domain: arg.hostname, reload: z.boolean().default(true) }).strict(),
  run: async ({ domain, reload }, ctx) => {
    const apache = requireApache();
    const file = ctx.assertAllowedPath(vhostFile(apache, domain), 'write');
    const link = vhostLink(apache, domain);
    const text = readText(file);
    if (text != null && !text.includes(VHOST_MARK)) throw new OpError('refused', `${file} was not written by the panel; refusing to delete it`);
    let removed = false;
    if (link) { try { fs.unlinkSync(link); } catch { /* none */ } }
    if (text != null) { fs.unlinkSync(file); removed = true; dropLegacyBackup(file); }
    const test = await configtest(apache);
    const result = reload && removed ? await reloadUnit(apache.units) : { reloaded: false, unit: null };
    return { domain, path: file, removed, validated: test.ok, ...result };
  },
});

defineOp('web.vhost.list', {
  description: 'Panel-managed virtual hosts with their metadata and whether they are enabled',
  run: async (_args, ctx) => {
    const apache = apacheLayout();
    if (!apache) return { installed: false, vhosts: [] };
    const dir = ctx.assertAllowedPath(apache.flavor === 'debian' ? apache.sitesAvailable : apache.confD, 'read');
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.conf')); } catch { files = []; }
    for (const f of files) {
      const file = path.join(dir, f);
      const text = readText(file);
      const meta = parseVhostMeta(text);
      if (!meta) continue;
      const link = apache.flavor === 'debian' ? path.join(apache.sitesEnabled, f) : null;
      out.push({ domain: meta.domain || f.replace(/\.conf$/, ''), path: file, enabled: link ? exists(link) : true, meta, size: text.length, mtime: fs.statSync(file).mtime.toISOString() });
    }
    return { installed: Boolean(apache.bin), dir, vhosts: out.sort((a, b) => a.domain.localeCompare(b.domain)) };
  },
});

defineOp('web.vhost.read', {
  description: 'Read a panel-managed virtual host file',
  schema: z.object({ domain: arg.hostname }).strict(),
  run: async ({ domain }, ctx) => {
    const apache = requireApache();
    const file = ctx.assertAllowedPath(vhostFile(apache, domain), 'read');
    const content = readText(file);
    const link = vhostLink(apache, domain);
    return { domain, path: file, exists: content != null, managed: content != null && content.includes(VHOST_MARK), enabled: link ? exists(link) : content != null, meta: parseVhostMeta(content), content };
  },
});

// ------------------------------------------------------------ global include ---

defineOp('web.global.read', {
  description: 'Current contents of the panel-managed global Apache include',
  run: async (_args, ctx) => {
    const apache = apacheLayout();
    if (!apache) return { installed: false, exists: false, content: null };
    const file = ctx.assertAllowedPath(apache.globalInclude, 'read');
    return { installed: Boolean(apache.bin), path: file, exists: exists(file), enabled: apache.flavor === 'debian' ? exists(apache.globalEnabled) : exists(file), content: readText(file) };
  },
});

defineOp('web.global.write', {
  description: 'Render global directives into the managed include (conf-available/whm.conf or conf.d/whm.conf), run configtest (rolled back on error) and reload; dryRun tests without keeping the change',
  schema: z.object({ directives: globalDirectives, dryRun: z.boolean().default(false), reload: z.boolean().default(true) }).strict(),
  run: async ({ directives, dryRun, reload }, ctx) => {
    const apache = requireApache();
    const file = ctx.assertAllowedPath(apache.globalInclude, 'write');
    const link = apache.flavor === 'debian' ? ctx.assertAllowedPath(apache.globalEnabled, 'write') : null;
    const content = renderGlobalInclude(directives);
    if (dryRun) {
      const previous = readText(file);
      const linkExisted = link ? exists(link) : null;
      writeAtomic(file, content);
      if (link && !linkExisted) fs.symlinkSync(path.relative(path.dirname(link), file), link);
      try {
        const test = await configtest(apache);
        return { dryRun: true, path: file, ok: test.ok, output: test.output, content };
      } finally {
        restore(file, previous);
        if (link && !linkExisted) { try { fs.unlinkSync(link); } catch { /* gone */ } }
      }
    }
    const written = await writeApacheFile(apache, file, content, { link });
    const result = reload ? await reloadUnit(apache.units) : { reloaded: false, unit: null };
    return { dryRun: false, ...written, bytes: Buffer.byteLength(content), content, ...result };
  },
});

defineOp('web.mpm.set', {
  description: 'Switch the Apache MPM (a2dismod/a2enmod on Debian, conf.modules.d/00-mpm.conf on RHEL), validate and restart',
  destructive: true,
  schema: z.object({ module: z.enum(['prefork', 'worker', 'event']) }).strict(),
  run: async ({ module }, ctx) => {
    const apache = requireApache();
    const info = await apacheInfo(apache);
    if (info.mpm === module) return { module, changed: false, mpm: info.mpm };
    if (module !== 'prefork' && info.modules.some((m) => /^php\d/.test(m.name))) throw new OpError('refused', `mod_${info.modules.find((m) => /^php\d/.test(m.name)).name} is loaded; it only works with the prefork MPM. Switch PHP to PHP-FPM first.`);
    if (apache.flavor === 'debian') {
      if (!apache.a2tools) throw new OpError('capability_missing', 'a2enmod/a2dismod are not available on this server');
      const current = info.mpm ? `mpm_${info.mpm}` : null;
      if (current) await exec('a2dismod', ['-q', '-f', current], { allowFailure: true, timeoutMs: 60_000 });
      const en = await exec('a2enmod', ['-q', `mpm_${module}`], { allowFailure: true, timeoutMs: 60_000 });
      const test = await configtest(apache);
      if (en.code !== 0 || test.ok === false) {
        await exec('a2dismod', ['-q', '-f', `mpm_${module}`], { allowFailure: true, timeoutMs: 60_000 });
        if (current) await exec('a2enmod', ['-q', current], { allowFailure: true, timeoutMs: 60_000 });
        throw new OpError('config_invalid', `Apache rejected the ${module} MPM; the previous MPM was restored: ${lastLine(en.stderr || test.output)}`, { output: test.output });
      }
    } else {
      const file = ctx.assertAllowedPath(apache.mpmConf, 'write');
      const previous = readText(file) || '';
      const lines = previous.split('\n').map((l) => (/^\s*LoadModule\s+mpm_\w+_module/.test(l) ? `#${l.replace(/^#+/, '')}` : l));
      lines.push(`${MANAGED} (Apache Configuration: MPM)`, `LoadModule mpm_${module}_module modules/mod_mpm_${module}.so`);
      writeAtomic(file, `${lines.join('\n')}\n`);
      const test = await configtest(apache);
      if (test.ok === false) { restore(file, previous); throw new OpError('config_invalid', `Apache rejected the ${module} MPM; the previous file was restored: ${lastLine(test.output)}`, { output: test.output }); }
    }
    const restart = await reloadUnit(apache.units, 'restart');
    return { module, changed: true, previous: info.mpm, ...restart };
  },
});

// Apache's Listen directives live in ports.conf (Debian) or httpd.conf (RHEL);
// moving them (e.g. to 127.0.0.1:8080 behind an nginx proxy) rewrites those
// lines only. A bind address pins every listener to it; a null https releases
// 443 so the proxy can terminate TLS.
export function rewriteListen(text, { http, https, bind = null }) {
  const lines = (text || '').split('\n').filter((l) => !l.startsWith(MANAGED)).map((l) => (/^\s*Listen\s+/.test(l) ? `#${l.replace(/^#+/, '')}` : l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const addr = (port) => (bind ? listenAddr(bind, port) : String(port));
  lines.push(`${MANAGED} (Apache ports${bind ? `, bound to ${bind}` : ''})`, `Listen ${addr(http)}`);
  if (https) lines.push('<IfModule ssl_module>', `  Listen ${addr(https)}`, '</IfModule>', '<IfModule mod_gnutls.c>', `  Listen ${addr(https)}`, '</IfModule>');
  return `${lines.join('\n')}\n`;
}

defineOp('web.ports.set', {
  description: 'Change the ports (and optionally the bind address) Apache listens on (ports.conf / httpd.conf Listen lines), validate (rolled back on error) and restart',
  destructive: true,
  schema: z.object({ http: z.number().int().min(1).max(65535), https: z.number().int().min(1).max(65535).nullable().default(443), bind: arg.ip.nullable().default(null) }).strict(),
  run: async ({ http: httpPort, https: httpsPort, bind }, ctx) => {
    const apache = requireApache();
    const file = ctx.assertAllowedPath(apache.flavor === 'debian' ? '/etc/apache2/ports.conf' : '/etc/httpd/conf/httpd.conf', 'write');
    const previous = readText(file);
    writeAtomic(file, rewriteListen(previous, { http: httpPort, https: httpsPort, bind }));
    const test = await configtest(apache);
    if (test.ok === false) { restore(file, previous); throw new OpError('config_invalid', `Apache rejected the new ports; the previous file was restored: ${lastLine(test.output)}`, { output: test.output }); }
    return { path: file, http: httpPort, https: httpsPort, bind, validated: test.ok, ...(await reloadUnit(apache.units, 'restart')) };
  },
});

// ---------------------------------------------------------------- php-fpm ---

defineOp('web.phpfpm.detect', { description: 'PHP-FPM versions, pool directories and units on this host', run: async () => { const layout = phpLayout(); for (const v of layout.versions) v.unit = await unitState(await firstUnit(v.units)); return layout; } });

defineOp('web.phpfpm.pool.write', {
  description: 'Write a per-account PHP-FPM pool (whm-<user>.conf) under the detected pool directory, test with php-fpm -t (rolled back on error) and reload',
  schema: poolSchema,
  run: async (p, ctx) => {
    if (p.errorLog) ctx.assertAllowedPath(p.errorLog, 'write');
    if (p.tmpDir) ctx.assertAllowedPath(p.tmpDir, 'write');
    const layout = phpLayout();
    const tree = layout.versions.find((v) => v.version === p.version);
    if (!tree) throw new OpError('capability_missing', `PHP-FPM ${p.version} is not installed on this server (available: ${layout.versions.map((v) => v.version).join(', ') || 'none'})`);
    const user = passwdEntry(p.user);
    if (!user) throw new OpError('not_found', `Linux user "${p.user}" does not exist`);
    const file = ctx.assertAllowedPath(path.join(tree.poolDir, `whm-${p.user}.conf`), 'write');
    const socket = phpSocket(p.version, p.user);
    const content = renderPhpPool(p, { listenOwner: tree.listenOwner, socket, homeDir: user.home });
    const previous = readText(file);
    writeAtomic(file, content);
    let validated = null;
    if (tree.bin) {
      const { code, stdout, stderr } = await exec(tree.bin, ['-t'], { allowFailure: true, timeoutMs: 60_000 });
      validated = code === 0;
      if (!validated) { restore(file, previous); throw new OpError('config_invalid', `PHP-FPM rejected the pool; the previous file was restored: ${lastLine(stderr || stdout)}`, { output: `${stdout}${stderr}`.trim() }); }
    }
    const reload = p.reload ? await reloadUnit(tree.units) : { reloaded: false, unit: null };
    return { user: p.user, version: p.version, path: file, socket, validated, bytes: Buffer.byteLength(content), ...reload };
  },
});

defineOp('web.phpfpm.pool.remove', {
  description: 'Remove a per-account PHP-FPM pool and reload',
  destructive: true,
  schema: z.object({ user: arg.username, version: phpVersion }).strict(),
  run: async ({ user, version }, ctx) => {
    const tree = phpLayout().versions.find((v) => v.version === version);
    if (!tree) return { user, version, removed: false };
    const file = ctx.assertAllowedPath(path.join(tree.poolDir, `whm-${user}.conf`), 'write');
    const existed = exists(file);
    if (existed) fs.unlinkSync(file);
    dropLegacyBackup(file);
    return { user, version, path: file, removed: existed, ...(existed ? await reloadUnit(tree.units) : { reloaded: false, unit: null }) };
  },
});

// -------------------------------------------------------------------- FTP ---

function readPureFtpdDir(confDir) {
  const out = {};
  try { for (const f of fs.readdirSync(path.join(confDir, 'conf'))) out[f] = (readText(path.join(confDir, 'conf', f)) || '').trim(); } catch { /* none */ }
  return out;
}

function parseKeyValue(text, sep = '=') {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = sep === ' ' ? line.match(/^(\S+)\s+(.*)$/) : line.match(new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\s*${sep}\\s*(.*)$`));
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function ftpDaemon(name) {
  const d = ftpLayout().daemons.find((x) => x.name === name);
  if (!d) throw new OpError('capability_missing', `${name} is not installed on this server`);
  return d;
}

export function ftpSettingsFrom(name, raw) {
  const s = {};
  const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
  if (name === 'pure-ftpd') {
    const range = (raw.PassivePortRange || '').split(/\s+/);
    if (range.length === 2) { s.passivePortMin = num(range[0]); s.passivePortMax = num(range[1]); }
    s.passiveAddress = raw.ForcePassiveIP || null;
    s.tls = { 0: 'off', 1: 'optional', 2: 'required', 3: 'required' }[raw.TLS] ?? null;
    s.maxClients = num(raw.MaxClientsNumber); s.maxPerIp = num(raw.MaxClientsPerIP);
    s.anonymous = raw.NoAnonymous != null ? !/^(yes|1|true)$/i.test(raw.NoAnonymous) : null;
    s.idleTimeoutMinutes = num(raw.MaxIdleTime); s.chroot = raw.ChrootEveryone != null ? /^(yes|1|true)$/i.test(raw.ChrootEveryone) : null;
  } else if (name === 'proftpd') {
    const range = (raw.PassivePorts || '').split(/\s+/);
    if (range.length === 2) { s.passivePortMin = num(range[0]); s.passivePortMax = num(range[1]); }
    s.passiveAddress = raw.MasqueradeAddress || null; s.maxClients = num(raw.MaxInstances); s.maxPerIp = num(raw.MaxClientsPerHost);
    s.idleTimeoutMinutes = raw.TimeoutIdle != null ? Math.round(num(raw.TimeoutIdle) / 60) : null; s.chroot = raw.DefaultRoot != null ? true : null;
    s.tls = raw.TLSEngine ? (raw.TLSEngine === 'off' ? 'off' : raw.TLSRequired === 'on' ? 'required' : 'optional') : null;
  } else if (name === 'vsftpd') {
    s.passivePortMin = num(raw.pasv_min_port); s.passivePortMax = num(raw.pasv_max_port); s.passiveAddress = raw.pasv_address || null;
    s.tls = raw.ssl_enable ? (raw.ssl_enable === 'NO' ? 'off' : raw.force_local_logins_ssl === 'YES' ? 'required' : 'optional') : null;
    s.maxClients = num(raw.max_clients); s.maxPerIp = num(raw.max_per_ip); s.anonymous = raw.anonymous_enable != null ? raw.anonymous_enable === 'YES' : null;
    s.idleTimeoutMinutes = raw.idle_session_timeout != null ? Math.round(num(raw.idle_session_timeout) / 60) : null; s.chroot = raw.chroot_local_user != null ? raw.chroot_local_user === 'YES' : null;
  }
  return s;
}

defineOp('web.ftp.config.read', {
  description: 'Read the effective settings of an installed FTP daemon (passive ports, TLS, limits, anonymous, chroot)',
  schema: z.object({ server: z.enum(['pure-ftpd', 'proftpd', 'vsftpd']) }).strict(),
  run: async ({ server }, ctx) => {
    const d = ftpDaemon(server);
    let raw = {};
    let file = null;
    if (server === 'pure-ftpd') {
      if (d.style === 'debian-dir') { ctx.assertAllowedPath(d.confDir, 'read'); raw = readPureFtpdDir(d.confDir); file = `${d.confDir}/conf/`; } else { file = ctx.assertAllowedPath(d.confFile, 'read'); raw = parseKeyValue(readText(file), ' '); }
    } else if (server === 'proftpd') {
      file = ctx.assertAllowedPath(d.managedFile, 'read');
      raw = { ...parseKeyValue(readText(d.confFile), ' '), ...parseKeyValue(readText(file), ' ') };
    } else {
      file = ctx.assertAllowedPath(d.confFile, 'read');
      raw = parseKeyValue(readText(file));
    }
    return { server, path: file, unit: await unitState(await firstUnit(d.units)), settings: ftpSettingsFrom(server, raw), raw };
  },
});

defineOp('web.ftp.config.write', {
  description: 'Write FTP daemon settings (pure-ftpd conf/ files or pure-ftpd.conf, proftpd conf.d/whm.conf, vsftpd.conf merge), validate where the daemon supports it and restart',
  schema: z.object({ server: z.enum(['pure-ftpd', 'proftpd', 'vsftpd']), settings: ftpSettings, restart: z.boolean().default(true) }).strict(),
  run: async ({ server, settings, restart }, ctx) => {
    const d = ftpDaemon(server);
    const written = [];
    const previous = [];
    const keep = (file) => { previous.push({ file, content: readText(file) }); written.push(file); return file; };
    let validated = null;
    let includeHint = null;
    if (server === 'pure-ftpd') {
      const values = pureFtpdSettings(settings);
      if (d.style === 'debian-dir') {
        for (const [k, v] of Object.entries(values)) {
          const file = keep(ctx.assertAllowedPath(path.join(d.confDir, 'conf', k), 'write'));
          if (v == null) { try { fs.unlinkSync(file); } catch { /* none */ } } else writeAtomic(file, `${v}\n`);
          dropLegacyBackup(file);
        }
      } else {
        const file = keep(ctx.assertAllowedPath(d.confFile, 'write'));
        writeAtomic(file, mergeKeyValueFile(previous[0].content, values, { sep: ' ' }));
      }
    } else if (server === 'proftpd') {
      const file = keep(ctx.assertAllowedPath(d.managedFile, 'write'));
      writeAtomic(file, renderProftpd(settings));
      if (d.confFile && !/^\s*Include\s+\/etc\/proftpd\/conf\.d\//m.test(readText(d.confFile) || '')) includeHint = `Add "Include /etc/proftpd/conf.d/" to ${d.confFile} so the panel's settings are loaded.`;
      if (d.bin && d.confFile) {
        const { code, stdout, stderr } = await exec('proftpd', ['-t', '-c', d.confFile], { allowFailure: true, timeoutMs: 60_000 });
        validated = code === 0;
        if (!validated) { restoreAll(previous); throw new OpError('config_invalid', `ProFTPD rejected the settings; the previous file was restored: ${lastLine(stderr || stdout)}`, { output: `${stdout}${stderr}`.trim() }); }
      }
    } else {
      const file = keep(ctx.assertAllowedPath(d.confFile, 'write'));
      writeAtomic(file, mergeKeyValueFile(previous[0].content, vsftpdSettings(settings)));
    }
    // pure-ftpd has no config test and proftpd -t cannot see every runtime
    // failure (e.g. a TLS certificate that is missing), so a daemon that does
    // not come back after the restart gets its previous files back.
    const result = restart ? await reloadUnit(d.units, 'restart') : { reloaded: false, unit: null };
    if (restart && result.unit && !result.reloaded) {
      restoreAll(previous);
      await reloadUnit(d.units, 'restart');
      throw new OpError('config_invalid', `${server} failed to start with the new settings; the previous configuration was restored: ${result.error}`, { server, written });
    }
    if (restart && result.unit) validated = result.reloaded;
    return { server, written, validated, hint: includeHint, ...result };
  },
});

// ------------------------------------------------------- daemon selection ---

async function roleStatus(which) {
  const out = [];
  for (const c of ROLES[which]) {
    const unit = await firstUnit(c.units);
    out.push({ ...c, installed: c.binaries.some(hasBinary), unitName: unit, unit: await unitState(unit) });
  }
  return out;
}

defineOp('web.service.detect', {
  description: 'Which daemons for a role (ftp: pure-ftpd/proftpd/vsftpd, dns: bind/powerdns) are installed, enabled and running, with the package to install each',
  schema: z.object({ role }).strict(),
  run: async ({ role: which }) => {
    const candidates = await roleStatus(which);
    const active = candidates.filter((c) => c.unit.active).map((c) => c.name);
    const enabled = candidates.filter((c) => c.unit.enabled).map((c) => c.name);
    return { role: which, candidates, active, enabled, current: active[0] || enabled[0] || null, packageManager: ['apt-get', 'dnf', 'yum'].find(hasBinary) || null };
  },
});

defineOp('web.service.select', {
  description: 'Make one daemon the active one for a role: enable+start it and disable+stop the alternatives ("disabled" stops them all)',
  destructive: true,
  schema: z.object({ role, server: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }).strict(),
  run: async ({ role: which, server }) => {
    const allowed = [...ROLES[which].map((c) => c.name), 'disabled'];
    if (!allowed.includes(server)) throw new OpError('invalid_args', `server must be one of ${allowed.join(', ')}`);
    if (!hasBinary('systemctl')) throw new OpError('capability_missing', 'systemd is not available on this host');
    const candidates = await roleStatus(which);
    const chosen = candidates.find((c) => c.name === server) || null;
    if (server !== 'disabled' && !chosen.unitName) {
      const pm = ['apt-get', 'dnf', 'yum'].find(hasBinary);
      throw new OpError('capability_missing', `${chosen.label} is not installed on this server${pm ? ` (install the "${chosen.packages[pm.replace('-get', '')] || chosen.packages.apt}" package)` : ''}`, { package: chosen.packages, packageManager: pm || null });
    }
    const steps = [];
    for (const c of candidates) {
      if (!c.unitName || c.name === server) continue;
      const { code, stderr } = await exec('systemctl', ['disable', '--now', `${c.unitName}.service`], { allowFailure: true, timeoutMs: 120_000 });
      steps.push({ unit: c.unitName, action: 'disable --now', ok: code === 0, error: code === 0 ? null : lastLine(stderr) });
    }
    if (chosen?.unitName) {
      const { code, stderr } = await exec('systemctl', ['enable', '--now', `${chosen.unitName}.service`], { allowFailure: true, timeoutMs: 180_000 });
      steps.push({ unit: chosen.unitName, action: 'enable --now', ok: code === 0, error: code === 0 ? null : lastLine(stderr) });
      if (code !== 0) throw new OpError('command_failed', `${chosen.label} could not be started: ${lastLine(stderr)}`, { steps });
    }
    unitCache.at = 0;
    return { role: which, server, steps, candidates: await roleStatus(which) };
  },
});

// -------------------------------------------------------------- logrotate ---

const LOGROTATE_DIR = '/etc/logrotate.d';
const rotateFile = (name) => path.join(LOGROTATE_DIR, `whm-${name}`);

async function logrotateTest(file) {
  if (!hasBinary('logrotate')) return { ok: null, output: 'logrotate is not installed; policy not tested' };
  const { code, stdout, stderr } = await exec('logrotate', ['-d', file], { allowFailure: true, timeoutMs: 60_000 });
  const output = `${stdout}${stderr}`.trim();
  return { ok: code === 0 && !/^error:/m.test(output), output: output.split('\n').slice(0, 60).join('\n') };
}

defineOp('web.logrotate.write', {
  description: `Write a managed logrotate policy to ${LOGROTATE_DIR}/whm-<name>, validated with logrotate -d (rolled back on error)`,
  schema: logrotateSchema,
  run: async (l, ctx) => {
    const file = ctx.assertAllowedPath(rotateFile(l.name), 'write');
    for (const p of [...l.paths, ...(l.stanzas || []).flatMap((s) => s.paths)]) ctx.assertAllowedPath(p.replace(/\*.*$/, ''), 'read');
    const content = renderLogrotate(l);
    const previous = readText(file);
    writeAtomic(file, content);
    const test = await logrotateTest(file);
    if (test.ok === false) { restore(file, previous); throw new OpError('config_invalid', `logrotate rejected the policy; the previous file was restored: ${lastLine(test.output)}`, { output: test.output }); }
    return { name: l.name, path: file, validated: test.ok, output: test.output, content, bytes: Buffer.byteLength(content) };
  },
});

defineOp('web.logrotate.read', {
  description: 'Read a managed logrotate policy file',
  schema: z.object({ name: slug }).strict(),
  run: async ({ name }, ctx) => { const file = ctx.assertAllowedPath(rotateFile(name), 'read'); return { name, path: file, exists: exists(file), content: readText(file), logrotate: hasBinary('logrotate') }; },
});

defineOp('web.logrotate.list', {
  description: 'Managed logrotate policies and the status file summary',
  run: async (_args, ctx) => {
    ctx.assertAllowedPath(LOGROTATE_DIR, 'read');
    let files = [];
    try { files = fs.readdirSync(LOGROTATE_DIR).filter((f) => f.startsWith('whm-') && !f.endsWith('.whm-bak')).map((f) => ({ name: f.slice(4), path: path.join(LOGROTATE_DIR, f), size: fs.statSync(path.join(LOGROTATE_DIR, f)).size, mtime: fs.statSync(path.join(LOGROTATE_DIR, f)).mtime.toISOString() })); } catch { files = []; }
    return { dir: LOGROTATE_DIR, logrotate: hasBinary('logrotate'), policies: files, dirExists: exists(LOGROTATE_DIR) };
  },
});

defineOp('web.logrotate.remove', {
  description: 'Remove a managed logrotate policy',
  destructive: true,
  schema: z.object({ name: slug }).strict(),
  run: async ({ name }, ctx) => { const file = ctx.assertAllowedPath(rotateFile(name), 'write'); const existed = exists(file); if (existed) fs.unlinkSync(file); dropLegacyBackup(file); return { name, path: file, removed: existed }; },
});

defineOp('web.logrotate.run', {
  description: 'Run logrotate on a managed policy now (optionally forcing rotation)',
  schema: z.object({ name: slug, force: z.boolean().default(false) }).strict(),
  run: async ({ name, force }, ctx) => {
    if (!hasBinary('logrotate')) throw new OpError('capability_missing', 'logrotate is not installed on this server');
    const file = ctx.assertAllowedPath(rotateFile(name), 'read');
    if (!exists(file)) throw new OpError('not_found', `No managed policy "${name}"`);
    const { code, stdout, stderr } = await exec('logrotate', [force ? '-fv' : '-v', file], { allowFailure: true, timeoutMs: 600_000 });
    return { name, force, ok: code === 0, output: `${stdout}${stderr}`.trim().split('\n').slice(-80).join('\n') };
  },
});

// ---------------------------------------------------------------- dovecot ---

export function parseDoveconf(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    if (/^\s/.test(raw) || !raw.trim() || raw.startsWith('#')) continue;
    const m = raw.match(/^([a-z_0-9]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

defineOp('web.dovecot.detect', {
  description: 'Dovecot presence, version, effective top-level settings (doveconf -n) and the panel-managed include',
  run: async (_args, ctx) => {
    const dc = dovecotLayout();
    if (!dc) return { installed: false };
    ctx.assertAllowedPath(dc.include, 'read');
    let version = null;
    let effective = {};
    let configOk = null;
    if (dc.installed) { const v = await exec('dovecot', ['--version'], { allowFailure: true, timeoutMs: 30_000 }); version = v.stdout.trim().split(/\s+/)[0] || null; }
    if (dc.doveconf) { const c = await exec('doveconf', ['-n'], { allowFailure: true, timeoutMs: 60_000 }); configOk = c.code === 0; effective = parseDoveconf(c.stdout); }
    return { ...dc, version, configOk, effective: { protocols: effective.protocols ?? null, ssl: effective.ssl ?? null, ssl_min_protocol: effective.ssl_min_protocol ?? null, mail_location: effective.mail_location ?? null, mail_max_userip_connections: effective.mail_max_userip_connections ?? null, default_process_limit: effective.default_process_limit ?? null, default_client_limit: effective.default_client_limit ?? null, disable_plaintext_auth: effective.disable_plaintext_auth ?? null, login_greeting: effective.login_greeting ?? null }, include: { path: dc.include, exists: exists(dc.include), content: readText(dc.include) }, unit: await unitState(await firstUnit(dc.units)) };
  },
});

defineOp('web.dovecot.include.write', {
  description: 'Write the panel-managed Dovecot include (conf.d/97-whm-mailserver.conf), validate with doveconf -n (rolled back on error) and reload',
  schema: z.object({ content: freeText, reload: z.boolean().default(true) }).strict(),
  run: async ({ content, reload }, ctx) => {
    const dc = dovecotLayout();
    if (!dc?.installed) throw new OpError('capability_missing', 'Dovecot is not installed on this server');
    const file = ctx.assertAllowedPath(dc.include, 'write');
    const previous = readText(file);
    writeAtomic(file, ensureNl(content));
    let validated = null;
    if (dc.doveconf) {
      const { code, stderr, stdout } = await exec('doveconf', ['-n'], { allowFailure: true, timeoutMs: 60_000 });
      validated = code === 0;
      if (!validated) { restore(file, previous); throw new OpError('config_invalid', `Dovecot rejected the settings; the previous file was restored: ${lastLine(stderr || stdout)}`, { output: `${stderr}`.trim() }); }
    }
    const result = reload ? await reloadUnit(dc.units) : { reloaded: false, unit: null };
    return { path: file, validated, bytes: Buffer.byteLength(content), ...result };
  },
});

defineOp('web.dovecot.include.remove', {
  description: 'Remove the panel-managed Dovecot include and reload',
  destructive: true,
  run: async (_args, ctx) => {
    const dc = dovecotLayout();
    if (!dc) return { removed: false };
    const file = ctx.assertAllowedPath(dc.include, 'write');
    const existed = exists(file);
    if (existed) fs.unlinkSync(file);
    return { path: file, removed: existed, ...(existed ? await reloadUnit(dc.units) : { reloaded: false, unit: null }) };
  },
});

// ------------------------------------------------------------------- exim ---

const eximSlot = z.enum(['main', 'acl_rcpt', 'acl_data']);

function requireExim() {
  const layout = eximLayout();
  if (!layout?.installed) throw new OpError('capability_missing', 'Exim is not installed on this server (no exim/exim4 binary found)');
  return layout;
}

// Whether a slot is reached by the configuration Exim would actually load.
// Split-config ACL slots are hooked when their macro resolves to our file in
// the generated config (`exim -bP macro`), which also reveals a macro another
// component (the Email category's acl_rcpt.conf) claimed first; without the
// binary the first textual definition wins, as it does for Exim.
async function eximHook(layout, slot) {
  const s = layout.slots[slot];
  if (slot === 'main') return { hooked: s.hookable || (readText(layout.mainConf || '') || '').includes(s.path), claimedBy: null };
  if (s.macro) {
    let value = null;
    if (layout.installed) {
      const { code, stdout } = await exec(layout.bin, ['-bP', 'macro', s.macro], { allowFailure: true, timeoutMs: 30_000 });
      value = code === 0 ? (stdout.trim().split('\n').pop() || '').replace(new RegExp(`^${s.macro}\\s*=\\s*`), '').trim() || null : null;
    } else {
      const text = ['/etc/exim4/exim4.conf.localmacros', '/etc/exim4/conf.d/main/000_localmacros', '/etc/exim4/conf.d/main/000_whm_macros', s.path === layout.slots.main.path ? null : layout.slots.main.path].filter(Boolean).map((f) => readText(f) || '').join('\n');
      value = text.match(new RegExp(`^\\s*${s.macro}\\s*==?\\s*(\\S+)`, 'm'))?.[1] || null;
    }
    return { hooked: value === s.path, claimedBy: value && value !== s.path ? value : null };
  }
  return { hooked: (readText(layout.mainConf || '') || '').includes(s.path), claimedBy: null };
}

// `exim -bV` names the compiled-in features ("Support for: ... DKIM ... SPF");
// Debian's exim4-daemon-light lacks SPF, so an ACL using `spf =` is rejected.
export function parseEximVersion(stdout) {
  const support = String(stdout || '').match(/^Support for:\s*(.+)$/m)?.[1];
  return { version: String(stdout || '').match(/Exim version (\S+)/)?.[1] || null, features: support ? support.trim().split(/\s+/) : null };
}

async function validateExim(layout) {
  let regenerated = null;
  if (layout.splitConfig && layout.updateConf) { const r = await exec('update-exim4.conf', [], { allowFailure: true, timeoutMs: 120_000 }); regenerated = { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() }; }
  const { code, stdout, stderr } = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 60_000 });
  const output = `${stdout}${stderr}`.trim();
  const ok = code === 0 && !/configuration error|main option .* unknown|Exim configuration error|option set for a second time|unknown ACL condition/i.test(output) && (regenerated?.ok ?? true);
  return { ok, output: regenerated && !regenerated.ok ? regenerated.output : output, ...parseEximVersion(stdout), regenerated };
}

defineOp('web.exim.detect', {
  description: 'Exim layout for service configuration: flavor, config mode, version, and the managed slot files (main options, RCPT ACL, DATA ACL) with their hook state',
  run: async (_args, ctx) => {
    const layout = eximLayout();
    if (!layout) return { installed: false };
    const slots = {};
    for (const [k, s] of Object.entries(layout.slots)) {
      ctx.assertAllowedPath(s.path, 'read');
      slots[k] = { ...s, exists: exists(s.path), ...(await eximHook(layout, k)), content: readText(s.path) };
    }
    let info = { version: null, features: null };
    if (layout.installed) { const v = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 30_000 }); info = parseEximVersion(v.stdout); }
    const has = (f) => (info.features ? info.features.includes(f) : null);
    return { ...layout, ...info, support: { spf: has('SPF'), dkim: has('DKIM'), dmarc: has('DMARC') }, slots, unit: await unitState(await firstUnit(layout.units)), hints: hintsFor(layout, slots) };
  },
});

// Only the manual steps this host really needs: nothing for a slot that is
// live, and nothing for a hookable slot the next save hooks by itself.
export function hintsFor(layout, slots) {
  const h = [];
  const aclFile = layout.splitConfig ? '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt' : layout.mainConf;
  if (!slots.main.hooked) h.push(`Add ".include ${slots.main.path}" to the main section of ${layout.mainConf} so the global options take effect.`);
  if (!slots.acl_rcpt.hooked) {
    if (slots.acl_rcpt.claimedBy) h.push(`CHECK_RCPT_LOCAL_ACL_FILE already points at ${slots.acl_rcpt.claimedBy} (the Email category's ACL), so the RCPT protections in ${slots.acl_rcpt.path} are not loaded: add ".include ${slots.acl_rcpt.path}" inside acl_check_rcpt (before the final accept) in ${aclFile}. Until then the RBL, reverse-DNS, HELO and dictionary-attack toggles only tag messages.`);
    else if (!slots.acl_rcpt.hookable) h.push(`Add ".include ${slots.acl_rcpt.path}" inside acl_check_rcpt (after the authenticated/relay accepts, before the final accept) in ${aclFile} for the RCPT protections.`);
  }
  if (!slots.acl_data.hooked) {
    if (slots.acl_data.claimedBy) h.push(`CHECK_DATA_LOCAL_ACL_FILE already points at ${slots.acl_data.claimedBy}; add ".include ${slots.acl_data.path}" inside acl_check_data for DKIM verification handling.`);
    else if (!slots.acl_data.hookable) h.push(`Add ".include ${slots.acl_data.path}" inside acl_check_data in ${layout.mainConf} for DKIM verification handling.`);
  }
  return h;
}

defineOp('web.exim.include.write', {
  description: 'Write a managed Exim fragment into a slot (main options, RCPT ACL, DATA ACL), regenerate (Debian), validate with exim -bV (rolled back on error) and reload',
  schema: z.object({ slot: eximSlot, content: freeText, reload: z.boolean().default(true) }).strict(),
  run: async ({ slot, content, reload }, ctx) => {
    const layout = requireExim();
    const file = ctx.assertAllowedPath(layout.slots[slot].path, 'write');
    const previous = readText(file);
    writeAtomic(file, ensureNl(content));
    const test = await validateExim(layout);
    if (!test.ok) {
      restore(file, previous);
      await validateExim(layout);
      throw new OpError('config_invalid', `Exim rejected the new configuration; the previous file was restored: ${lastLine(test.output)}`, { output: test.output, slot });
    }
    const result = reload ? await reloadUnit(layout.units) : { reloaded: false, unit: null };
    return { slot, path: file, validated: true, ...(await eximHook(layout, slot)), bytes: Buffer.byteLength(content), version: test.version, ...result };
  },
});

defineOp('web.exim.include.remove', {
  description: 'Remove a managed Exim slot file, regenerate/validate and reload',
  destructive: true,
  schema: z.object({ slot: eximSlot }).strict(),
  run: async ({ slot }, ctx) => {
    const layout = requireExim();
    const file = ctx.assertAllowedPath(layout.slots[slot].path, 'write');
    const existed = exists(file);
    if (existed) fs.unlinkSync(file);
    await validateExim(layout);
    return { slot, path: file, removed: existed, ...(existed ? await reloadUnit(layout.units) : { reloaded: false, unit: null }) };
  },
});

export { ROLES as SERVICE_ROLES, LOGROTATE_DIR, ensureRootLogDir };
