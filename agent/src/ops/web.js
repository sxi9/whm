import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError } from './registry.js';
import { eximBaseLayout, includesFile, EXIM_WHM_FILES } from './exim-layout.js';

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

// The main slot starts with this macro so `exim -bP macro` on the generated
// configuration proves the slot is really read (a file Exim never loads passes
// update-exim4.conf and exim -bV trivially).
export const EXIM_SENTINEL_MACRO = 'WHM_SERVICE_CONFIG';
const EXIM_BLOCK = { begin: '# BEGIN WHM panel (Service Configuration: Exim main options) - managed block, edits inside are overwritten', end: '# END WHM panel (Service Configuration: Exim main options)' };

// Where the Exim main options live per layout (shared detection in
// exim-layout.js decides the Debian config mode from dc_use_split_config):
//   Debian split   → a conf.d/main fragment, concatenated into the main section;
//   Debian unsplit → a managed block in exim4.conf.localmacros, which
//                    update-exim4.conf prepends in both modes (conf.d/ is ignored);
//   RHEL           → <confdir>/whm/service_config.conf, .include'd by hand once.
// The RCPT ACL slot is the single local-ACL hook point both mail families agree
// on (acl-rcpt-local.conf): Debian reaches it through CHECK_RCPT_LOCAL_ACL_FILE,
// defined by the main slot, and it ends with an include of the Email category's
// filters file so one macro serves both.
export function eximLayout(io) {
  const base = eximBaseLayout(io);
  if (!base.flavor && !base.installed) return null;
  const flavor = base.flavor;
  const debian = flavor === 'debian';
  const confDir = base.confDir || '/etc/exim';
  const whmDir = base.whmDir || `${confDir}/whm`;
  const mainConf = debian ? base.mainConf : base.mainConf || '/etc/exim/exim.conf';
  const emailAclFile = base.emailAclFile || `${whmDir}/${EXIM_WHM_FILES.emailFilters}`;
  const main = debian
    ? (base.splitConfig ? { path: '/etc/exim4/conf.d/main/001_whm_service_config', hookable: true, block: null } : { path: base.macroFile, hookable: true, block: EXIM_BLOCK.begin })
    : { path: `${whmDir}/service_config.conf`, hookable: false, block: null };
  return {
    installed: base.installed, bin: base.bin, flavor, confDir, whmDir, splitConfig: base.splitConfig, mainConf, updateConf: base.updateConf, macroFile: base.macroFile,
    rcptAclSource: base.rcptAclSource || mainConf, emailAclFile, sentinel: EXIM_SENTINEL_MACRO,
    units: debian ? ['exim4', 'exim'] : ['exim', 'exim4'],
    slots: {
      main,
      acl_rcpt: { path: base.aclChainFile || `${whmDir}/${EXIM_WHM_FILES.aclChain}`, hookable: debian, macro: debian ? 'CHECK_RCPT_LOCAL_ACL_FILE' : null, block: null, includes: emailAclFile },
      acl_data: { path: `${whmDir}/acl_data_whm.conf`, hookable: debian, macro: debian ? 'CHECK_DATA_LOCAL_ACL_FILE' : null, block: null },
    },
  };
}

// The managed block the unsplit-Debian main slot occupies inside localmacros,
// next to the admin's lines and the other categories' blocks.
export function mergeEximBlock(previous, content) {
  const block = `${EXIM_BLOCK.begin}\n${String(content).trimEnd()}\n${EXIM_BLOCK.end}\n`;
  const text = previous || '';
  const start = text.indexOf(EXIM_BLOCK.begin);
  const stop = text.indexOf(EXIM_BLOCK.end);
  if (start !== -1 && stop !== -1 && stop >= start) return `${text.slice(0, start)}${block}${text.slice(stop + EXIM_BLOCK.end.length).replace(/^\n/, '')}`;
  return `${text.length && !text.endsWith('\n') ? `${text}\n` : text}${block}`;
}

export function readEximBlock(text) {
  const t = text || '';
  const start = t.indexOf(EXIM_BLOCK.begin);
  const stop = t.indexOf(EXIM_BLOCK.end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return t.slice(start + EXIM_BLOCK.begin.length, stop).replace(/^\n/, '');
}

export function stripEximBlock(text) {
  const t = text || '';
  const start = t.indexOf(EXIM_BLOCK.begin);
  const stop = t.indexOf(EXIM_BLOCK.end);
  if (start === -1 || stop === -1 || stop < start) return t;
  return `${t.slice(0, start)}${t.slice(stop + EXIM_BLOCK.end.length).replace(/^\n/, '')}`;
}

// What a slot holds right now: a block slot reads its block, a file slot the file.
function eximSlotContent(s) {
  const text = readText(s.path);
  return s.block ? readEximBlock(text) : text;
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
    // proxy_fcgi drops the Authorization header unless it is re-exported, so
    // PHP applications using HTTP Basic auth get it on both vhosts.
    lines.push('  <IfModule proxy_fcgi_module>', '    SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1', '    <FilesMatch "\\.ph(ar|p|tml)$">', `      SetHandler "proxy:unix:${phpSocket(v.phpVersion, v.user)}|fcgi://localhost"`, '    </FilesMatch>', '  </IfModule>');
  }
  // Application Manager drops per-domain proxy/static blocks into
  // <apache root>/whm-apps/<domain>.conf; the vhost itself never changes.
  lines.push(`  IncludeOptional ${q(`${v.appsDir || path.join(apacheLayout()?.root || '/etc/apache2', 'whm-apps')}/${v.domain}.conf`)}`);
  if (ssl) {
    lines.push('  SSLEngine on');
    if (v.ssl.fullchain) lines.push(`  SSLCertificateFile ${q(v.ssl.fullchain)}`);
    else { lines.push(`  SSLCertificateFile ${q(v.ssl.cert)}`); if (v.ssl.chain) lines.push(`  SSLCertificateChainFile ${q(v.ssl.chain)}`); }
    lines.push(`  SSLCertificateKeyFile ${q(v.ssl.key)}`);
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

// mod_status is asked on the address Apache really listens on: the panel passes
// the ports/bind it set (e.g. 127.0.0.1:8080 behind the nginx proxy).
function fetchServerStatus({ host = '127.0.0.1', port = 80 } = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/server-status?auto', headers: { Host: 'localhost' }, timeout: timeoutMs }, (res) => {
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
  description: 'Apache runtime status: unit state, version, MPM, loaded modules and mod_status counters when enabled (probed on the given port/bind address)',
  schema: z.object({ port: z.number().int().min(1).max(65535).default(80), bind: arg.ip.nullable().default(null) }).strict(),
  run: async ({ port, bind }) => {
    const apache = apacheLayout();
    if (!apache || !apache.bin) return { installed: false };
    const info = await apacheInfo(apache);
    const unit = await unitState(await firstUnit(apache.units));
    const serverStatus = unit.active && info.modules.some((m) => m.name === 'status') ? await fetchServerStatus({ host: bind || '127.0.0.1', port }) : null;
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
    const content = renderVhost({ ...v, logDir, appsDir: path.join(apache.root, 'whm-apps') });
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
      // The running MPM comes from parsed `apache2ctl -V` output, so it is
      // checked against the known set before it becomes an a2dismod argument.
      if (info.mpm && !mpmSchema.shape.module.unwrap().safeParse(info.mpm).success) throw new OpError('unexpected_state', `Apache reports an unknown MPM "${info.mpm}"; refusing to switch modules`);
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

// The primary group of a system user from /etc/passwd + /etc/group, so a
// per-account `su` stanza names the real group even when it is not called
// after the user (logrotate rejects the whole file on an unknown group).
export function primaryGroupName(user, { passwd = readText('/etc/passwd'), group = readText('/etc/group') } = {}) {
  const pw = (passwd || '').split('\n').find((l) => l.startsWith(`${user}:`));
  if (!pw) return null;
  const gid = pw.split(':')[3];
  const gr = (group || '').split('\n').find((l) => l.split(':')[2] === gid);
  const name = gr ? gr.split(':')[0] : null;
  return name && groupName.safeParse(name).success ? name : null;
}

function resolveSuGroups(l) {
  const fix = (su) => (su && su.user !== 'root' ? { ...su, group: primaryGroupName(su.user) || su.group } : su);
  return { ...l, su: fix(l.su), stanzas: l.stanzas?.map((s) => ({ ...s, su: fix(s.su) })) };
}

// Distribution-provided policies that already rotate the web server logs; a
// panel policy naming the same files makes logrotate report duplicate entries.
export const DISTRIBUTION_LOGROTATE = { apache2: `${LOGROTATE_DIR}/apache2`, httpd: `${LOGROTATE_DIR}/httpd`, nginx: `${LOGROTATE_DIR}/nginx` };

defineOp('web.logrotate.write', {
  description: `Write a managed logrotate policy to ${LOGROTATE_DIR}/whm-<name>, validated with logrotate -d (rolled back on error)`,
  schema: logrotateSchema,
  run: async (input, ctx) => {
    const l = resolveSuGroups(input);
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
    const distribution = Object.fromEntries(Object.entries(DISTRIBUTION_LOGROTATE).filter(([, f]) => exists(f)));
    return { dir: LOGROTATE_DIR, logrotate: hasBinary('logrotate'), policies: files, dirExists: exists(LOGROTATE_DIR), distribution };
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

// The value of a macro in the configuration Exim would actually load (`exim -bP
// macro`): null when it is not defined there, undefined without the binary.
async function eximMacro(layout, name) {
  if (!layout.installed) return undefined;
  const { code, stdout } = await exec(layout.bin, ['-bP', 'macro', name], { allowFailure: true, timeoutMs: 30_000 });
  if (code !== 0) return null;
  return (stdout.trim().split('\n').pop() || '').replace(new RegExp(`^${name}\\s*==?\\s*`), '').trim() || null;
}

// Whether a slot is reached by the configuration Exim would actually load. The
// main slot is proven by its sentinel macro (a conf.d fragment on an unsplit
// host, or an un-included RHEL file, passes exim -bV without being read); the
// ACL slots by their CHECK_*_LOCAL_ACL_FILE macro resolving to our file, which
// also reveals a definition another component (the Email category's fallback
// macro, or the admin) made first. Manual layouts are hooked when the main
// configuration .include's the file, directly or through one level.
async function eximHook(layout, slot) {
  const s = layout.slots[slot];
  const includedByMain = () => includesFile(readText(layout.mainConf || '') || '', s.path, (f) => (/^\/etc\/exim/.test(f) ? readText(f) : null)).hooked;
  if (slot === 'main') {
    const value = await eximMacro(layout, layout.sentinel || EXIM_SENTINEL_MACRO);
    if (value !== undefined) return { hooked: value != null, claimedBy: null };
    return { hooked: s.hookable ? (eximSlotContent(s) || '').includes(`${EXIM_SENTINEL_MACRO} =`) : includedByMain(), claimedBy: null };
  }
  if (s.macro) {
    let value = await eximMacro(layout, s.macro);
    if (value === undefined) {
      const text = [layout.macroFile, '/etc/exim4/conf.d/main/000_localmacros', s.path === layout.slots.main.path ? null : layout.slots.main.path].filter(Boolean).map((f) => readText(f) || '').join('\n');
      value = text.match(new RegExp(`^\\s*${s.macro}\\s*==?\\s*(\\S+)`, 'm'))?.[1] || null;
    }
    return { hooked: value === s.path, claimedBy: value && value !== s.path ? value : null };
  }
  return { hooked: includedByMain(), claimedBy: null };
}

// `exim -bV` names the compiled-in features ("Support for: ... DKIM ... SPF");
// Debian's exim4-daemon-light lacks SPF, so an ACL using `spf =` is rejected.
export function parseEximVersion(stdout) {
  const support = String(stdout || '').match(/^Support for:\s*(.+)$/m)?.[1];
  return { version: String(stdout || '').match(/Exim version (\S+)/)?.[1] || null, features: support ? support.trim().split(/\s+/) : null };
}

// Debian regenerates config.autogenerated from the template or conf.d plus
// localmacros in both modes, so update-exim4.conf runs whenever it exists.
async function validateExim(layout) {
  let regenerated = null;
  if (layout.flavor === 'debian' && layout.updateConf) { const r = await exec('update-exim4.conf', [], { allowFailure: true, timeoutMs: 120_000 }); regenerated = { ok: r.code === 0, output: `${r.stdout}${r.stderr}`.trim() }; }
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
      const content = eximSlotContent(s);
      slots[k] = { ...s, exists: content != null, ...(await eximHook(layout, k)), content, ...(s.includes ? { includesEmailFilters: content != null && content.includes(`.include_if_exists ${s.includes}`) } : {}) };
    }
    let info = { version: null, features: null };
    if (layout.installed) { const v = await exec(layout.bin, ['-bV'], { allowFailure: true, timeoutMs: 30_000 }); info = parseEximVersion(v.stdout); }
    const has = (f) => (info.features ? info.features.includes(f) : null);
    return { ...layout, ...info, support: { spf: has('SPF'), dkim: has('DKIM'), dmarc: has('DMARC'), tls: eximTlsLibrary(info.features) }, slots, unit: await unitState(await firstUnit(layout.units)), hints: hintsFor(layout, slots) };
  },
});

// `exim -bV` names the TLS library among the compiled-in features ("GnuTLS" or
// "TLS=GnuTLS" / "OpenSSL"); a GnuTLS build takes a priority string instead of
// an OpenSSL cipher list for tls_require_ciphers.
export function eximTlsLibrary(features) {
  if (!Array.isArray(features)) return null;
  if (features.some((f) => /\bGnuTLS\b/.test(f))) return 'gnutls';
  if (features.some((f) => /\bOpenSSL\b/.test(f))) return 'openssl';
  return null;
}

// Only the manual steps this host really needs: nothing for a slot that is
// live, and nothing for a hookable slot the next save hooks by itself.
export function hintsFor(layout, slots) {
  const h = [];
  const aclFile = layout.rcptAclSource || (layout.splitConfig ? '/etc/exim4/conf.d/acl/30_exim4-config_check_rcpt' : layout.mainConf);
  if (!slots.main.hooked) {
    if (!slots.main.hookable) h.push(`Add ".include ${slots.main.path}" to the main section of ${layout.mainConf} so the global options take effect.`);
    else if (slots.main.exists) h.push(`Exim's generated configuration does not contain the panel's main options from ${slots.main.path}: run update-exim4.conf and reload Exim, and check that dc_use_split_config in /etc/exim4/update-exim4.conf.conf matches the layout detected here (${layout.splitConfig ? 'split' : 'unsplit'}).`);
  }
  if (!slots.acl_rcpt.hooked) {
    if (slots.acl_rcpt.claimedBy) h.push(`CHECK_RCPT_LOCAL_ACL_FILE already points at ${slots.acl_rcpt.claimedBy}, so the RCPT ACL chain in ${slots.acl_rcpt.path} (the panel's protections plus the Email filters) is not loaded. Save "Filter Incoming Emails by Country" (Email) once so it hands the hook over to this chain, or remove that definition from ${layout.macroFile || 'the Exim configuration'}; alternatively add ".include ${slots.acl_rcpt.path}" inside acl_check_rcpt (before the final accept) in ${aclFile}. Until then the RBL, reverse-DNS, HELO and dictionary-attack toggles only tag messages.`);
    else if (!slots.acl_rcpt.hookable) h.push(`Add ".include ${slots.acl_rcpt.path}" inside acl_check_rcpt (after the authenticated/relay accepts, before the final accept) in ${aclFile} for the RCPT protections and the Email filters.`);
  }
  if (!slots.acl_data.hooked) {
    if (slots.acl_data.claimedBy) h.push(`CHECK_DATA_LOCAL_ACL_FILE already points at ${slots.acl_data.claimedBy}; remove that definition from ${layout.macroFile || 'the Exim configuration'} or add ".include ${slots.acl_data.path}" inside acl_check_data for DKIM verification handling.`);
    else if (!slots.acl_data.hookable) h.push(`Add ".include ${slots.acl_data.path}" inside acl_check_data in ${layout.mainConf} for DKIM verification handling.`);
  }
  return h;
}

// A whole-file slot is written as is; a block slot replaces its managed block
// inside the shared file (unsplit Debian's localmacros) and restores the whole
// previous file on rejection.
defineOp('web.exim.include.write', {
  description: 'Write a managed Exim fragment into a slot (main options, RCPT ACL chain, DATA ACL), regenerate (Debian), validate with exim -bV (rolled back on error), verify it is live and reload',
  schema: z.object({ slot: eximSlot, content: freeText, reload: z.boolean().default(true) }).strict(),
  run: async ({ slot, content, reload }, ctx) => {
    const layout = requireExim();
    const s = layout.slots[slot];
    const file = ctx.assertAllowedPath(s.path, 'write');
    const previous = readText(file);
    writeAtomic(file, s.block ? mergeEximBlock(previous, content) : ensureNl(content));
    const test = await validateExim(layout);
    if (!test.ok) {
      restore(file, previous);
      await validateExim(layout);
      throw new OpError('config_invalid', `Exim rejected the new configuration; the previous file was restored: ${lastLine(test.output)}`, { output: test.output, slot });
    }
    const result = reload ? await reloadUnit(layout.units) : { reloaded: false, unit: null };
    return { slot, path: file, block: s.block || null, splitConfig: layout.splitConfig, validated: true, ...(await eximHook(layout, slot)), bytes: Buffer.byteLength(content), version: test.version, features: test.features, ...result };
  },
});

defineOp('web.exim.include.remove', {
  description: 'Remove a managed Exim slot (file, or managed block in localmacros), regenerate/validate and reload',
  destructive: true,
  schema: z.object({ slot: eximSlot }).strict(),
  run: async ({ slot }, ctx) => {
    const layout = requireExim();
    const s = layout.slots[slot];
    const file = ctx.assertAllowedPath(s.path, 'write');
    const previous = readText(file);
    const existed = s.block ? readEximBlock(previous) != null : previous != null;
    if (existed) { if (s.block) writeAtomic(file, stripEximBlock(previous)); else fs.unlinkSync(file); }
    const test = await validateExim(layout);
    if (!test.ok) { restore(file, previous); await validateExim(layout); throw new OpError('config_invalid', `Exim rejected the configuration without the panel's ${slot} fragment; it was restored: ${lastLine(test.output)}`, { output: test.output, slot }); }
    return { slot, path: file, block: s.block || null, removed: existed, ...(existed ? await reloadUnit(layout.units) : { reloaded: false, unit: null }) };
  },
});

export { ROLES as SERVICE_ROLES, LOGROTATE_DIR, ensureRootLogDir };

// ------------------------------------------------------------- WordPress ---
// Used by the bundled WP Toolkit plugin. Every WP-CLI command runs as the
// account user through runuser (never as root), inside a directory that sits
// under that user's home from /etc/passwd. Passwords travel over WP-CLI's
// --prompt stdin mechanism, never as argv.

const WP_TIMEOUT_MS = 300_000;
const WP_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'cache', 'wp-includes', 'wp-admin', 'wp-content', 'vendor', '.trash', 'tmp']);
const wpName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'Plugin/theme slug');
const wpUser = z.string().regex(/^[a-z0-9][a-z0-9._@-]{0,59}$/i, 'WordPress user name');
const wpUrl = z.string().max(300).regex(/^https?:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{2,5})?(\/[A-Za-z0-9._~\-/]*)?$/i, 'http(s) site URL');
const wpTitle = z.string().min(1).max(120).regex(/^[^\0\r\n]+$/, 'Single-line title');
const wpSecret = z.string().min(8).max(128).regex(/^[^\0\r\n]+$/);
const wpLocale = z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?(_[a-z]+)?$/).default('en_US');
const wpSiteArgs = { username: arg.username, path: arg.absPath };

// Root only ever reads a file inside an account's tree when lstat says it is a
// small regular file: a FIFO would block the agent (the whole panel in
// monolithic mode), a symlink would leak another tree and a huge sparse file
// would be read into root's memory. The open uses O_NOFOLLOW | O_NONBLOCK and
// fstat re-checks the descriptor, so a file the account swaps between the two
// calls is still never followed or waited on.
export const WP_READ_MAX_BYTES = 512 * 1024;

export function regularFileStat(file, max = WP_READ_MAX_BYTES) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  return st.isFile() && !st.isSymbolicLink() && st.size <= max ? st : null;
}

export function readSiteFile(file, max = WP_READ_MAX_BYTES) {
  if (!regularFileStat(file, max)) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
  }
}

function lexists(file) {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

export function passwdHome(username) {
  const line = (readText('/etc/passwd') || '').split('\n').find((l) => l.startsWith(`${username}:`));
  if (!line) throw new OpError('not_found', `Unknown user "${username}"`);
  const home = line.split(':')[5];
  if (!home || !path.isAbsolute(home)) throw new OpError('not_found', `User "${username}" has no home directory`);
  return home;
}

// A site directory must resolve (symlinks included) under the account's home,
// so a crafted path or a planted link never makes root touch another tree.
export function assertUnderHome(home, p) {
  const resolved = path.resolve(p);
  const homeResolved = path.resolve(home);
  if (resolved !== homeResolved && !resolved.startsWith(`${homeResolved}/`)) throw new OpError('path_not_allowed', `${p} is not inside the home directory ${home}`);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* not created yet: check the nearest existing parent */
    let cur = path.dirname(resolved);
    while (!exists(cur) && cur !== '/') cur = path.dirname(cur);
    real = path.join(fs.realpathSync(cur), path.relative(cur, resolved));
  }
  let realHome = homeResolved;
  try { realHome = fs.realpathSync(homeResolved); } catch { /* keep */ }
  if (real !== realHome && !real.startsWith(`${realHome}/`)) throw new OpError('path_not_allowed', `${p} escapes the home directory through a symbolic link`);
  return resolved;
}

function wpSite(username, p, ctx, mode = 'read') {
  const home = passwdHome(username);
  ctx.assertAllowedPath(home, mode);
  const site = assertUnderHome(home, p);
  ctx.assertAllowedPath(site, mode);
  return { home, site };
}

function requireWpCli() {
  if (!hasBinary('wp')) throw new OpError('capability_missing', 'WP-CLI (wp) is not installed on this server');
  if (!hasBinary('runuser')) throw new OpError('capability_missing', 'runuser is required to run WP-CLI as the account user');
}

async function wp(username, home, site, argv, { input, timeoutMs = WP_TIMEOUT_MS, skip = true } = {}) {
  requireWpCli();
  const base = ['-u', username, '--', 'wp', `--path=${site}`, '--no-color'];
  if (skip) base.push('--skip-plugins', '--skip-themes');
  return exec('runuser', [...base, ...argv], { input, timeoutMs, allowFailure: true, env: { HOME: home, WP_CLI_CACHE_DIR: `${home}/.wp-cli/cache`, WP_CLI_DISABLE_AUTO_CHECK_UPDATE: '1' } });
}

// Root never changes permissions inside an account's tree: the account user
// may swap any file for a symbolic link between a check and the chmod, so the
// chmod runs as that user and can only ever affect files the user owns.
async function chmodAsUser(username, home, file, mode) {
  const r = await exec('runuser', ['-u', username, '--', 'chmod', mode, '--', file], { allowFailure: true, timeoutMs: 30_000, env: { HOME: home } });
  if (r.code !== 0) throw new OpError('command_failed', `chmod ${mode} ${file} as ${username} failed: ${lastLineOf(r)}`);
  return true;
}

const lastLineOf = (r) => (r.stderr.trim().split('\n').pop() || r.stdout.trim().split('\n').pop() || 'no output').replace(/^(Error|Warning):\s*/, '');
const jsonOf = (r) => { if (r.code !== 0) return null; const t = r.stdout.trim(); if (!t) return null; try { return JSON.parse(t.slice(t.search(/[[{]/))); } catch { return null; } };

export function parseWpVersion(text) {
  const m = /\$wp_version\s*=\s*'([^']+)'/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function parseWpConfig(text) {
  const grab = (name) => { const m = new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*['"]([^'"]*)['"]`).exec(String(text || '')); return m ? m[1] : null; };
  const prefix = /\$table_prefix\s*=\s*['"]([^'"]*)['"]/.exec(String(text || ''));
  return { dbName: grab('DB_NAME'), dbUser: grab('DB_USER'), dbHost: grab('DB_HOST'), tablePrefix: prefix ? prefix[1] : null };
}

export function findWordPress(root, maxDepth, budget, out) {
  const walk = (dir, depth) => {
    if (budget.dirs-- <= 0 || depth > maxDepth) return;
    let st;
    try { st = fs.lstatSync(dir); } catch { return; }
    if (!st.isDirectory()) return;
    const config = path.join(dir, 'wp-config.php');
    const versionFile = path.join(dir, 'wp-includes', 'version.php');
    if (regularFileStat(config) && regularFileStat(versionFile)) {
      out.push({ path: dir, version: parseWpVersion(readSiteFile(versionFile)), ...parseWpConfig(readSiteFile(config)) });
      return;
    }
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || WP_SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
}

defineOp('web.wp.detect', {
  description: 'Whether WP-CLI is installed and its version',
  run: async () => {
    if (!hasBinary('wp')) return { installed: false, version: null, php: hasBinary('php'), runuser: hasBinary('runuser') };
    // WP-CLI refuses every command under euid 0 unless told otherwise; this
    // probe loads no site, so running it as root is harmless.
    const r = await exec('wp', ['cli', 'version', '--no-color', '--allow-root'], { allowFailure: true, timeoutMs: 60_000 });
    const m = /WP-CLI\s+([0-9][0-9.]*)/.exec(r.stdout);
    return { installed: true, version: m ? m[1] : null, php: hasBinary('php'), runuser: hasBinary('runuser') };
  },
});

defineOp('web.wp.discover', {
  description: 'Find WordPress installations (wp-config.php + wp-includes/version.php) under account web roots',
  schema: z.object({ usernames: z.array(arg.username).min(1).max(500), maxDepth: z.number().int().min(0).max(4).default(3), maxDirs: z.number().int().min(100).max(50_000).default(5000) }).strict(),
  run: async ({ usernames, maxDepth, maxDirs }, ctx) => {
    const installs = [];
    const missing = [];
    for (const username of usernames) {
      let home;
      try { home = passwdHome(username); } catch { missing.push(username); continue; }
      ctx.assertAllowedPath(home, 'read');
      const found = [];
      for (const sub of ['public_html', 'www', 'domains']) {
        const root = path.join(home, sub);
        if (!exists(root)) continue;
        findWordPress(root, sub === 'domains' ? maxDepth + 2 : maxDepth, { dirs: maxDirs }, found);
      }
      for (const f of found) installs.push({ username, home, ...f, relative: path.relative(home, f.path) });
    }
    return { installs, missing };
  },
});

defineOp('web.wp.inspect', {
  description: 'Core version, site URL, available updates, plugins, themes, maintenance mode and administrators of one WordPress site (WP-CLI as the account user)',
  schema: z.object(wpSiteArgs).strict(),
  run: async ({ username, path: p }, ctx) => {
    const { home, site } = wpSite(username, p, ctx);
    if (!regularFileStat(path.join(site, 'wp-config.php'))) throw new OpError('not_found', `${site} does not contain a WordPress installation (wp-config.php is missing or not a regular file)`);
    const errors = {};
    const run = async (key, argv, parse = jsonOf) => {
      const r = await wp(username, home, site, argv);
      if (r.code !== 0) { errors[key] = lastLineOf(r); return null; }
      return parse(r);
    };
    const text = (r) => r.stdout.trim();
    const version = await run('version', ['core', 'version'], text) || parseWpVersion(readSiteFile(path.join(site, 'wp-includes', 'version.php')));
    const siteUrl = await run('siteUrl', ['option', 'get', 'siteurl'], text);
    const coreUpdates = (await run('coreUpdates', ['core', 'check-update', '--format=json'])) || [];
    const plugins = (await run('plugins', ['plugin', 'list', '--format=json', '--fields=name,status,version,update,update_version'])) || [];
    const themes = (await run('themes', ['theme', 'list', '--format=json', '--fields=name,status,version,update,update_version'])) || [];
    const maintenance = await run('maintenance', ['maintenance-mode', 'status'], (r) => /is active/i.test(r.stdout));
    const admins = (await run('admins', ['user', 'list', '--role=administrator', '--format=json', '--fields=ID,user_login,user_email'])) || [];
    return {
      username, path: site, version, siteUrl, coreUpdates: Array.isArray(coreUpdates) ? coreUpdates : [], plugins: Array.isArray(plugins) ? plugins : [], themes: Array.isArray(themes) ? themes : [],
      maintenance: maintenance === null ? null : Boolean(maintenance), admins: Array.isArray(admins) ? admins : [], errors, inspectedAt: Date.now(),
    };
  },
});

defineOp('web.wp.update', {
  description: 'Update WordPress core, one plugin/theme or all of them (WP-CLI as the account user)',
  destructive: true,
  timeoutMs: 1_800_000,
  schema: z.object({ ...wpSiteArgs, kind: z.enum(['core', 'plugin', 'theme']), name: wpName.optional(), all: z.boolean().default(false) }).strict()
    .refine((v) => v.kind === 'core' || v.name || v.all, 'name or all is required for plugin/theme updates'),
  run: async ({ username, path: p, kind, name, all }, ctx) => {
    const { home, site } = wpSite(username, p, ctx, 'write');
    const argv = kind === 'core' ? ['core', 'update'] : [kind, 'update', ...(all ? ['--all'] : [name])];
    const r = await wp(username, home, site, argv, { timeoutMs: 1_500_000, skip: kind === 'core' });
    if (r.code !== 0) throw new OpError('command_failed', `wp ${argv.join(' ')} failed: ${lastLineOf(r)}`, { output: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
    const db = kind === 'core' ? await wp(username, home, site, ['core', 'update-db']) : null;
    return { kind, name: name ?? null, all, output: r.stdout.trim().slice(-4000), databaseUpdated: db ? db.code === 0 : null };
  },
});

defineOp('web.wp.maintenance', {
  description: 'Activate or deactivate WordPress maintenance mode',
  destructive: true,
  schema: z.object({ ...wpSiteArgs, enabled: z.boolean() }).strict(),
  run: async ({ username, path: p, enabled }, ctx) => {
    const { home, site } = wpSite(username, p, ctx, 'write');
    const r = await wp(username, home, site, ['maintenance-mode', enabled ? 'activate' : 'deactivate']);
    if (r.code !== 0 && !/already/i.test(r.stderr + r.stdout)) throw new OpError('command_failed', `maintenance mode could not be ${enabled ? 'activated' : 'deactivated'}: ${lastLineOf(r)}`);
    return { enabled };
  },
});

export const WP_HARDENING_FIXES = ['config-perms', 'disallow-file-edit', 'debug-off', 'auto-update-core'];

defineOp('web.wp.harden', {
  description: 'Hardening checks for one WordPress site (config permissions, file editor, debug mode, admin user name, table prefix, core updates)',
  schema: z.object(wpSiteArgs).strict(),
  run: async ({ username, path: p }, ctx) => {
    const { home, site } = wpSite(username, p, ctx);
    const config = path.join(site, 'wp-config.php');
    const configStat = regularFileStat(config);
    if (!configStat) throw new OpError('not_found', `${site} does not contain a WordPress installation (wp-config.php is missing or not a regular file)`);
    const checks = [];
    const mode = configStat.mode & 0o777;
    checks.push({ id: 'config-perms', label: 'wp-config.php is private', ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8).padStart(4, '0')}`, fix: 'config-perms' });
    const get = async (name) => { const r = await wp(username, home, site, ['config', 'get', name]); return r.code === 0 ? r.stdout.trim() : null; };
    const truthy = (v) => v != null && /^(1|true|on)$/i.test(v);
    const fileEdit = await get('DISALLOW_FILE_EDIT');
    checks.push({ id: 'disallow-file-edit', label: 'Theme and plugin editor disabled (DISALLOW_FILE_EDIT)', ok: truthy(fileEdit), detail: fileEdit ?? 'not set', fix: 'disallow-file-edit' });
    const debug = await get('WP_DEBUG');
    checks.push({ id: 'debug-off', label: 'Debug mode off (WP_DEBUG)', ok: !truthy(debug), detail: debug ?? 'not set', fix: 'debug-off' });
    const auto = await get('WP_AUTO_UPDATE_CORE');
    checks.push({ id: 'auto-update-core', label: 'Automatic core updates enabled', ok: auto == null || truthy(auto) || /minor/i.test(auto), detail: auto ?? 'default (minor)', fix: 'auto-update-core' });
    const prefix = parseWpConfig(readSiteFile(config)).tablePrefix;
    checks.push({ id: 'table-prefix', label: 'Non-default table prefix', ok: prefix != null && prefix !== 'wp_', detail: prefix ?? 'unknown', fix: null });
    const admins = await wp(username, home, site, ['user', 'list', '--role=administrator', '--format=json', '--fields=user_login']);
    const logins = (jsonOf(admins) || []).map((u) => String(u.user_login).toLowerCase());
    checks.push({ id: 'admin-name', label: 'No administrator named "admin"', ok: admins.code !== 0 ? null : !logins.includes('admin'), detail: admins.code !== 0 ? lastLineOf(admins) : logins.join(', ') || 'none', fix: null });
    const updates = await wp(username, home, site, ['core', 'check-update', '--format=json']);
    const pending = jsonOf(updates);
    checks.push({ id: 'core-current', label: 'WordPress core is up to date', ok: updates.code !== 0 ? null : !(Array.isArray(pending) && pending.length), detail: updates.code !== 0 ? lastLineOf(updates) : Array.isArray(pending) && pending.length ? `${pending[0].version} available` : 'current', fix: null });
    const score = checks.filter((c) => c.ok === true).length;
    return { username, path: site, checks, score, total: checks.length };
  },
});

defineOp('web.wp.hardenfix', {
  description: 'Apply hardening fixes: private wp-config.php, DISALLOW_FILE_EDIT, WP_DEBUG off, automatic core updates',
  destructive: true,
  schema: z.object({ ...wpSiteArgs, fixes: z.array(z.enum(WP_HARDENING_FIXES)).min(1).max(WP_HARDENING_FIXES.length) }).strict(),
  run: async ({ username, path: p, fixes }, ctx) => {
    const { home, site } = wpSite(username, p, ctx, 'write');
    const config = path.join(site, 'wp-config.php');
    if (!regularFileStat(config)) throw new OpError('not_found', `${site} does not contain a WordPress installation (wp-config.php is missing or not a regular file)`);
    const applied = [];
    const failed = {};
    const set = async (id, name, value) => {
      const r = await wp(username, home, site, ['config', 'set', name, value, '--raw', '--type=constant']);
      if (r.code === 0) applied.push(id); else failed[id] = lastLineOf(r);
    };
    for (const fix of fixes) {
      if (fix === 'config-perms') { try { await chmodAsUser(username, home, config, '600'); applied.push(fix); } catch (err) { failed[fix] = err.message; } }
      else if (fix === 'disallow-file-edit') await set(fix, 'DISALLOW_FILE_EDIT', 'true');
      else if (fix === 'debug-off') await set(fix, 'WP_DEBUG', 'false');
      else if (fix === 'auto-update-core') await set(fix, 'WP_AUTO_UPDATE_CORE', 'true');
    }
    return { applied, failed };
  },
});

// A fresh site needs an active theme to render; `wp core download` ships the
// bundled default themes, and this one is fetched when none ends up active.
export const WP_FALLBACK_THEME = 'twentytwentyfive';

async function activeTheme(username, home, site) {
  const r = await wp(username, home, site, ['theme', 'list', '--status=active', '--format=json', '--fields=name,version']);
  const list = jsonOf(r);
  return Array.isArray(list) && list.length ? { name: String(list[0].name), version: list[0].version ?? null } : null;
}

// What a failed install created is removed, so the retry the panel offers is
// not refused with "already contains a WordPress installation". A directory
// that existed before keeps every entry it already had (only the new ones go);
// the removal runs as the account user, so root never deletes inside the tree.
async function removeInstallLeftovers(username, home, site, before) {
  let targets;
  if (before === null) targets = [site];
  else {
    let names = [];
    try { names = fs.readdirSync(site); } catch { names = []; }
    targets = names.filter((n) => !before.has(n)).map((n) => path.join(site, n));
  }
  if (!targets.length) return `nothing was left behind in ${site}`;
  const r = await exec('runuser', ['-u', username, '--', 'rm', '-rf', '--', ...targets], { allowFailure: true, timeoutMs: 300_000, env: { HOME: home } });
  if (r.code !== 0) throw new OpError('command_failed', `rm -rf as ${username} failed: ${lastLineOf(r)}`);
  return before === null ? `removed ${site}` : `removed the ${targets.length} new entr${targets.length === 1 ? 'y' : 'ies'} from ${site}`;
}

defineOp('web.wp.install', {
  description: 'Download WordPress with its default themes, write wp-config.php, run the installer as the account user (credentials via stdin) and verify a theme is active',
  destructive: true,
  timeoutMs: 1_800_000,
  schema: z.object({
    ...wpSiteArgs, url: wpUrl, title: wpTitle, adminUser: wpUser, adminEmail: z.string().email().max(254), adminPassword: wpSecret,
    dbName: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), dbUser: z.string().regex(/^[A-Za-z0-9_]{1,80}$/), dbPassword: wpSecret, dbHost: arg.mysqlHost.default('localhost'), tablePrefix: z.string().regex(/^[a-z0-9_]{1,20}_$/).default('wp_'), locale: wpLocale,
  }).strict(),
  run: async ({ username, path: p, url, title, adminUser, adminEmail, adminPassword, dbName, dbUser, dbPassword, dbHost, tablePrefix, locale }, ctx) => {
    const { home, site } = wpSite(username, p, ctx, 'write');
    requireWpCli();
    if (lexists(path.join(site, 'wp-config.php'))) throw new OpError('exists', `${site} already contains a WordPress installation`);
    let before = null;
    if (lexists(site)) { try { before = new Set(fs.readdirSync(site)); } catch { before = new Set(); } }
    const mk = await exec('runuser', ['-u', username, '--', 'mkdir', '-p', '--', site], { allowFailure: true, env: { HOME: home } });
    if (mk.code !== 0) throw new OpError('command_failed', `could not create ${site} as ${username}: ${lastLineOf(mk)}`);
    const steps = [];
    try {
      const dl = await wp(username, home, site, ['core', 'download', `--locale=${locale}`], { timeoutMs: 900_000, skip: false });
      if (dl.code !== 0 && !/already present/i.test(dl.stderr)) throw new OpError('command_failed', `wp core download failed: ${lastLineOf(dl)}`, { step: 'download' });
      steps.push('download');
      const cfg = await wp(username, home, site, ['config', 'create', `--dbname=${dbName}`, `--dbuser=${dbUser}`, `--dbhost=${dbHost}`, `--dbprefix=${tablePrefix}`, `--locale=${locale}`, '--prompt=dbpass', '--skip-check'], { input: `${dbPassword}\n`, skip: false });
      if (cfg.code !== 0) throw new OpError('command_failed', `wp config create failed: ${lastLineOf(cfg)}`, { step: 'config' });
      steps.push('config');
      const ins = await wp(username, home, site, ['core', 'install', `--url=${url}`, `--title=${title}`, `--admin_user=${adminUser}`, `--admin_email=${adminEmail}`, '--prompt=admin_password', '--skip-email'], { input: `${adminPassword}\n`, timeoutMs: 600_000, skip: false });
      if (ins.code !== 0) throw new OpError('command_failed', `wp core install failed: ${lastLineOf(ins)}`, { step: 'install' });
      steps.push('install');
      let theme = await activeTheme(username, home, site);
      if (!theme) {
        const t = await wp(username, home, site, ['theme', 'install', WP_FALLBACK_THEME, '--activate'], { timeoutMs: 600_000, skip: false });
        if (t.code !== 0) throw new OpError('command_failed', `WordPress is installed but no theme is active and ${WP_FALLBACK_THEME} could not be installed: ${lastLineOf(t)}`, { step: 'theme' });
        theme = await activeTheme(username, home, site);
        if (!theme) throw new OpError('command_failed', 'WordPress is installed but no theme is active; the site would render an error page', { step: 'theme' });
      }
      steps.push('theme');
      let warning = null;
      try { await chmodAsUser(username, home, path.join(site, 'wp-config.php'), '600'); } catch (err) { warning = err.message; }
      const v = await wp(username, home, site, ['core', 'version']);
      return { path: site, url, version: v.code === 0 ? v.stdout.trim() : null, theme, steps, warning };
    } catch (err) {
      const failure = err instanceof OpError ? err : new OpError('command_failed', err.message);
      let cleanup;
      try { cleanup = await removeInstallLeftovers(username, home, site, before); } catch (rmErr) { cleanup = `${site} was left in place (${rmErr.message}); remove it before retrying`; }
      failure.details = { ...(failure.details || {}), steps: steps.slice(), cleanup };
      throw failure;
    }
  },
});
