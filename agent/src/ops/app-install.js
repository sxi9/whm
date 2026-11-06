import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';
import { accountPath, assertManaged, asUser, failureOf, lstatOrNull, privilegeTool } from './as-user.js';
import { parseZipListing, parseTarListing, checkArchiveMembers, diskLinkReader, stagedWrite } from './files.js';
import { regularFileStat, readSiteFile } from './web.js';

// One-click installers beyond WordPress (Phase 8 P5-2): Joomla and Drupal from
// the account panel. The release pins live here, not in the panel process, so
// the only archives root ever downloads are the ones this file names (https,
// SHA-256 from the publisher's release metadata, size bound). As with the
// WordPress path (wp-install.js): root downloads into its scratch directory
// and hashes; everything inside the home — listing, unpacking, moving into
// place, writing the configuration, running Joomla's CLI installer, removing —
// runs as the account through as-user.js.

export const APP_RELEASES = Object.freeze({
  joomla: Object.freeze({
    name: 'Joomla', version: '6.2.0',
    url: 'https://github.com/joomla/joomla-cms/releases/download/6.2.0/Joomla_6.2.0-Stable-Full_Package.zip',
    sha256: 'eaafc68b5990d7b9dd9156656d4c3c3547743d1d7a85682a92e2f9121b58f018',
    bytes: 34921686, format: 'zip', root: null, requires: { php: '8.3' },
    // What the archive puts at the top of the tree, plus what the installer
    // writes there: a removal inside a shared document root deletes only these.
    // Joomla ships htaccess.txt/robots.txt.dist only; a .htaccess or robots.txt
    // next to it belongs to the site (panel-managed rules) and is never removed.
    topLevel: Object.freeze(['LICENSE.txt', 'README.txt', 'administrator', 'api', 'cache', 'cli', 'components', 'files', 'htaccess.txt', 'images', 'includes', 'index.php', 'installation', 'language', 'layouts', 'libraries', 'media', 'modules', 'plugins', 'robots.txt.dist', 'templates', 'tmp', 'web.config.txt', 'configuration.php']),
    signature: Object.freeze(['installation/joomla.php', 'libraries/src/Version.php', 'administrator/index.php']),
  }),
  drupal: Object.freeze({
    name: 'Drupal', version: '11.4.11',
    url: 'https://ftp.drupal.org/files/projects/drupal-11.4.11.tar.gz',
    sha256: 'f6935da6ddfb2b3bf5c79c5118018be91021f7d5e12901eed1a71de140708e13',
    bytes: 23215761, format: 'tar', root: 'drupal-11.4.11', requires: { php: '8.3' },
    topLevel: Object.freeze(['.csslintrc', '.editorconfig', '.eslintignore', '.eslintrc.json', '.gitattributes', '.ht.router.php', '.htaccess', 'INSTALL.txt', 'LICENSE.txt', 'README.md', 'autoload.php', 'autoload_runtime.php', 'composer.json', 'composer.lock', 'core', 'example.gitignore', 'index.php', 'modules', 'profiles', 'recipes', 'robots.txt', 'sites', 'themes', 'update.php', 'vendor']),
    signature: Object.freeze(['core/lib/Drupal.php', 'index.php', 'sites/default/default.settings.php']),
  }),
});
export const APP_IDS = Object.freeze(Object.keys(APP_RELEASES));
export const APP_DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const APP_DOWNLOAD_TIMEOUT_MS = 180_000;
const SCRATCH_DIR = '/tmp/whm';
const MiB = 1024 * 1024;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'cache', 'vendor', 'wp-includes', 'wp-admin', 'wp-content', 'administrator', 'libraries', 'core', 'media', 'tmp', '.trash']);

const base = { username: arg.username, path: arg.absPath };
const appId = z.enum(APP_IDS);
const siteUrl = z.string().max(300).regex(/^https?:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{2,5})?(\/[A-Za-z0-9._~\-/]*)?$/i, 'http(s) site URL');
const siteTitle = z.string().min(1).max(120).regex(/^[^\0\r\n]+$/, 'Single-line title');
const adminName = z.string().regex(/^[a-z0-9][a-z0-9._@-]{1,59}$/i, 'Administrator user name');
const secret = z.string().min(8).max(128).regex(/^[^\0\r\n]+$/);
const joomlaSecret = z.string().min(12).max(128).regex(/^[^\0\r\n]+$/);
const dbIdent = (max) => z.string().regex(new RegExp(`^[A-Za-z0-9_]{1,${max}}$`));
const dbPrefix = z.string().regex(/^[a-z][a-z0-9]{0,13}_$/, 'a table prefix such as j5x2a_');
const hostPattern = z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i, 'host name');

const lexists = (p) => lstatOrNull(p) !== null;
const relOf = (home, p) => path.relative(home, p) || '.';

// --------------------------------------------------------------- download ---

function scratchFile(ctx, ext) {
  ctx.assertAllowedPath(SCRATCH_DIR, 'write');
  const dir = ensurePrivateDir(SCRATCH_DIR);
  const file = path.join(dir, `app-${process.pid}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  return { file, fd };
}

async function withScratchFd(file, fn) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  try { return await fn(fd); } finally { fs.closeSync(fd); }
}

async function fetchFollowing(url, { timeoutMs }) {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!current.startsWith('https://')) throw new OpError('refused', `Refusing to download from a non-https URL (${current})`);
    let res;
    try { res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/octet-stream', 'User-Agent': 'keel-panel' } }); } catch (err) {
      throw new OpError('download_failed', `Download of ${current} failed: ${err.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : err.message}`);
    }
    if (res.status < 300 || res.status >= 400) {
      if (!res.ok) throw new OpError('download_failed', `Download failed: HTTP ${res.status} for ${current}`);
      return res;
    }
    const location = res.headers.get('location');
    if (!location) throw new OpError('download_failed', `Download failed: HTTP ${res.status} without a Location header for ${current}`);
    if (hop >= 5) throw new OpError('download_failed', `Too many redirects while downloading ${url}`);
    current = new URL(location, current).toString();
  }
}

export function magicMatches(format, head) {
  if (!head || head.length < 4) return false;
  if (format === 'zip') return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  return head[0] === 0x1f && head[1] === 0x8b;
}

// Streams the pinned archive onto root's scratch descriptor while hashing it;
// the size is bounded by Content-Length when present and by the bytes written
// regardless, and the whole transfer shares one deadline.
async function downloadArchive(release, fd, { maxBytes, timeoutMs }) {
  const res = await fetchFollowing(release.url, { timeoutMs });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new OpError('too_large', `The archive is ${declared} bytes, more than the ${maxBytes} allowed`);
  const hash = crypto.createHash('sha256');
  let total = 0;
  let head = null;
  const deadline = setTimeout(() => res.body?.cancel?.('timeout').catch(() => {}), timeoutMs);
  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new OpError('too_large', `The archive exceeds the ${maxBytes} bytes allowed`);
      if (!head) head = Buffer.from(chunk.subarray(0, 4));
      hash.update(chunk);
      fs.writeSync(fd, chunk);
    }
  } catch (err) {
    if (err instanceof OpError) throw err;
    throw new OpError('download_failed', `Download of ${release.url} was interrupted: ${err.message}`);
  } finally { clearTimeout(deadline); }
  if (!magicMatches(release.format, head)) throw new OpError('download_failed', `The download is not a ${release.format === 'zip' ? 'zip' : 'gzip'} archive`);
  const sha256 = hash.digest('hex');
  if (sha256 !== release.sha256) throw new OpError('checksum_mismatch', `The downloaded ${release.name} ${release.version} archive does not match its published SHA-256 (${sha256} vs ${release.sha256})`);
  return { bytes: total, sha256 };
}

// ---------------------------------------------------------- archive check ---

// A release archive holds plain files and directories only, all under its
// root directory when it has one (Drupal) or at the top when it is flat
// (Joomla); the general archive check refuses ".." names, links out of the
// destination and .ssh. The signature files prove it is the app it claims.
export function checkAppMembers(app, members, { dest, home }) {
  const release = APP_RELEASES[app];
  if (!release) throw new OpError('invalid_args', `Unknown application "${app}"`);
  if (!members.length) throw new OpError('refused', 'The archive is empty');
  const top = new Set();
  const names = new Set();
  for (const m of members) {
    const name = m.name.replace(/\/+$/, '');
    if (!name || name === '.') continue;
    const parts = name.split('/');
    if (parts.includes('..') || parts.includes('') || parts.includes('.')) throw new OpError('refused', `the archive member "${m.name}" is not a plain relative path`);
    if (m.type !== 'file' && m.type !== 'dir') throw new OpError('refused', `the archive member "${m.name}" is a ${m.type}; a ${release.name} release contains only files and directories`);
    if (release.root) {
      if (parts[0] !== release.root) throw new OpError('refused', `the archive member "${m.name}" is outside ${release.root}/`);
      if (parts.length > 1) top.add(parts[1]);
      names.add(parts.slice(1).join('/'));
    } else {
      top.add(parts[0]);
      names.add(name);
    }
  }
  checkArchiveMembers(members, { home, dest, allowSshDir: false, readLink: diskLinkReader() });
  for (const sig of release.signature) if (!names.has(sig)) throw new OpError('refused', `The archive does not look like a ${release.name} release (no ${sig})`);
  return [...top].sort();
}

// ---------------------------------------------------------------- parsing ---

export function parseJoomlaVersion(text) {
  const s = String(text || '');
  const grab = (k) => { const m = new RegExp(`const\\s+${k}\\s*=\\s*(?:'([^']*)'|(\\d+))`).exec(s); return m ? (m[1] ?? m[2]) : null; };
  const major = grab('MAJOR_VERSION');
  const minor = grab('MINOR_VERSION');
  const patch = grab('PATCH_VERSION');
  if (major == null || minor == null || patch == null) return null;
  const extra = grab('EXTRA_VERSION');
  return `${major}.${minor}.${patch}${extra ? `-${extra}` : ''}`;
}

export function parseJoomlaConfig(text) {
  const grab = (name) => { const m = new RegExp(`public\\s+\\$${name}\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(String(text || '')); return m ? m[1].replace(/\\(.)/g, '$1') : null; };
  return { dbName: grab('db'), dbUser: grab('user'), dbHost: grab('host'), dbPrefix: grab('dbprefix'), sitename: grab('sitename') };
}

export function parseDrupalVersion(text) {
  const m = /const\s+VERSION\s*=\s*'([^']+)'/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function parseDrupalSettings(text) {
  const s = String(text || '');
  const block = /\$databases\['default'\]\['default'\]\s*=\s*(?:\[|array\()([\s\S]*?)(?:\]|\))\s*;/.exec(s);
  if (!block) return { dbName: null, dbUser: null, dbHost: null, dbPrefix: null };
  const grab = (k) => { const m = new RegExp(`'${k}'\\s*=>\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(block[1]); return m ? m[1].replace(/\\(.)/g, '$1') : null; };
  return { dbName: grab('database'), dbUser: grab('username'), dbHost: grab('host'), dbPrefix: grab('prefix') };
}

const phpString = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const regexHost = (h) => `^${String(h).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

export function renderDrupalSettings({ dbName, dbUser, dbPassword, dbHost, dbPrefix, hashSalt, syncDir, trustedHosts }) {
  const lines = [
    '<?php',
    '// Written by the account panel; finish the installation at core/install.php.',
    "$databases['default']['default'] = [",
    `  'database' => ${phpString(dbName)},`,
    `  'username' => ${phpString(dbUser)},`,
    `  'password' => ${phpString(dbPassword)},`,
    `  'prefix' => ${phpString(dbPrefix)},`,
    `  'host' => ${phpString(dbHost)},`,
    "  'port' => '3306',",
    "  'driver' => 'mysql',",
    "  'namespace' => 'Drupal\\\\mysql\\\\Driver\\\\Database\\\\mysql',",
    "  'autoload' => 'core/modules/mysql/src/Driver/Database/mysql/',",
    "  'collation' => 'utf8mb4_general_ci',",
    '];',
    `$settings['hash_salt'] = ${phpString(hashSalt)};`,
    `$settings['config_sync_directory'] = ${phpString(syncDir)};`,
    `$settings['trusted_host_patterns'] = [${trustedHosts.map((h) => phpString(regexHost(h))).join(', ')}];`,
    "$settings['update_free_access'] = FALSE;",
    "$settings['file_scan_ignore_directories'] = ['node_modules', 'bower_components'];",
    "$settings['entity_update_batch_size'] = 50;",
    "$settings['entity_update_backup'] = TRUE;",
    "$settings['migrate_node_migrate_type_classic'] = FALSE;",
    "if (file_exists($app_root . '/' . $site_path . '/settings.local.php')) {",
    "  include $app_root . '/' . $site_path . '/settings.local.php';",
    '}',
    '',
  ];
  return lines.join('\n');
}

export function randomToken(length = 64) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// The argv of Joomla's CLI installer. Both passwords are deliberately absent:
// the command asks for them (admin password first, then the database
// password) and reads the answers from stdin, so neither shows in the
// process list. Every other option is given explicitly so nothing else is
// asked (an option that is not on the command line is prompted for).
export function joomlaInstallArgv({ title, adminUser, adminEmail, dbHost, dbUser, dbName, dbPrefix }) {
  return ['installation/joomla.php', 'install', `--site-name=${title}`, `--admin-user=${adminUser}`, `--admin-username=${adminUser}`, `--admin-email=${adminEmail}`,
    '--db-type=mysqli', `--db-host=${dbHost}`, `--db-user=${dbUser}`, `--db-name=${dbName}`, `--db-prefix=${dbPrefix}`, '--db-encryption=0', '--public-folder='];
}

export function joomlaInstallVerdict(r) {
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code === 0 && /Joomla has been installed/i.test(text)) return { ok: true, message: null };
  const line = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[?OK\]?$/i.test(l)).filter((l) => /error|wrong|fail|unable|denied|refused|not given|exception/i.test(l)).pop()
    || text.trim().split('\n').pop() || `exit ${r.code}`;
  return { ok: false, message: `Joomla's installer did not finish: ${line.replace(/^\[ERROR\]\s*/i, '').slice(0, 300)}` };
}

// ------------------------------------------------------------- discovery ---

function isJoomlaTree(dir) {
  return Boolean(regularFileStat(path.join(dir, 'libraries', 'src', 'Version.php'))) && Boolean(lstatOrNull(path.join(dir, 'administrator'))?.isDirectory());
}
function isDrupalTree(dir) {
  return Boolean(regularFileStat(path.join(dir, 'core', 'lib', 'Drupal.php'))) && Boolean(lstatOrNull(path.join(dir, 'sites'))?.isDirectory());
}
export const appTreeCheck = { joomla: isJoomlaTree, drupal: isDrupalTree };

export function inspectAppTree(dir) {
  if (isJoomlaTree(dir)) {
    const config = readSiteFile(path.join(dir, 'configuration.php'));
    return { app: 'joomla', version: parseJoomlaVersion(readSiteFile(path.join(dir, 'libraries', 'src', 'Version.php'))), ...parseJoomlaConfig(config), configured: config !== null, pendingInstaller: lstatOrNull(path.join(dir, 'installation'))?.isDirectory() === true };
  }
  if (isDrupalTree(dir)) {
    const settings = readSiteFile(path.join(dir, 'sites', 'default', 'settings.php'));
    return { app: 'drupal', version: parseDrupalVersion(readSiteFile(path.join(dir, 'core', 'lib', 'Drupal.php'))), ...parseDrupalSettings(settings), configured: settings !== null, pendingInstaller: regularFileStat(path.join(dir, 'core', 'install.php')) !== null };
  }
  return null;
}

export function findApps(root, maxDepth, budget, out) {
  const walk = (dir, depth) => {
    if (budget.dirs-- <= 0 || depth > maxDepth) return;
    let st;
    try { st = fs.lstatSync(dir); } catch { return; }
    if (!st.isDirectory()) return;
    const found = inspectAppTree(dir);
    if (found) { out.push({ path: dir, ...found }); return; }
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
}

function requireBins(bins, what) {
  for (const b of bins) if (!hasBinary(b)) throw new OpError('capability_missing', `${b} is not installed on this server; it is required to ${what}`);
}

async function removeAsUser(info, targets, what = 'remove the application files') {
  if (!targets.length) return;
  const r = await asUser(info, 'rm', ['-rf', '--one-file-system', '--', ...targets], { allowFailure: true, timeoutMs: 300_000 });
  if (r.code !== 0) throw failureOf(r, what);
}

export function parsePhpVersion(stdout) {
  const m = /^PHP\s+(\d+\.\d+\.\d+)/m.exec(String(stdout || ''));
  return m ? m[1] : null;
}

// ------------------------------------------------------------------- ops ---

defineOp('web.app.catalog', {
  description: 'The pinned releases the one-click installers can fetch (name, version, https URL, SHA-256, size, PHP requirement)',
  run: async () => ({ apps: Object.fromEntries(APP_IDS.map((id) => { const r = APP_RELEASES[id]; return [id, { name: r.name, version: r.version, url: r.url, sha256: r.sha256, bytes: r.bytes, format: r.format, requires: r.requires }]; })) }),
});

defineOp('web.app.requirements', {
  description: 'What a one-click install needs on this host: php (version, MySQL driver), unzip, tar and setpriv/runuser',
  run: async () => {
    const php = hasBinary('php');
    let phpMysql = null;
    let phpVersion = null;
    if (php) {
      const m = await exec('php', ['-m'], { allowFailure: true, timeoutMs: 30_000 });
      if (m.code === 0) phpMysql = /^(mysqli|pdo_mysql)$/mi.test(m.stdout);
      const v = await exec('php', ['-v'], { allowFailure: true, timeoutMs: 30_000 });
      if (v.code === 0) phpVersion = parsePhpVersion(v.stdout);
    }
    return { php, phpVersion, phpMysql, unzip: hasBinary('unzip'), tar: hasBinary('tar'), asUser: privilegeTool() !== null };
  },
});

defineOp('web.app.discover', {
  description: 'Find Joomla (libraries/src/Version.php + administrator/) and Drupal (core/lib/Drupal.php + sites/) installations under account web roots',
  schema: z.object({ usernames: z.array(arg.username).min(1).max(500), maxDepth: z.number().int().min(0).max(4).default(3), maxDirs: z.number().int().min(100).max(50_000).default(5000) }).strict(),
  run: async ({ usernames, maxDepth, maxDirs }, ctx) => {
    const installs = [];
    const missing = [];
    for (const username of usernames) {
      let info;
      try { info = assertManaged(username); } catch (err) { if (err instanceof OpError && ['not_found', 'refused'].includes(err.code)) { missing.push(username); continue; } throw err; }
      const home = path.resolve(info.home);
      ctx.assertAllowedPath(home, 'read');
      const found = [];
      for (const sub of ['public_html', 'www', 'domains']) {
        const root = path.join(home, sub);
        if (!lexists(root)) continue;
        findApps(root, sub === 'domains' ? maxDepth + 2 : maxDepth, { dirs: maxDirs }, found);
      }
      for (const f of found) installs.push({ username, home, ...f, relative: path.relative(home, f.path) });
    }
    return { installs, missing };
  },
});

defineOp('web.app.fetch', {
  description: 'Download a pinned Joomla or Drupal release into a directory of an account home: fetched by root into its scratch directory (https only), checked against the pinned SHA-256 and size, listed and unpacked as the account (plain files under the release root only, no links, no traversal) and moved into place as the account',
  destructive: true,
  timeoutMs: 1_500_000,
  schema: z.object({ ...base, app: appId, timeoutMs: z.number().int().min(10_000).max(APP_DOWNLOAD_TIMEOUT_MS).default(APP_DOWNLOAD_TIMEOUT_MS), maxBytes: z.number().int().min(MiB).max(APP_DOWNLOAD_MAX_BYTES).default(APP_DOWNLOAD_MAX_BYTES) }).strict(),
  run: async ({ username, path: p, app, timeoutMs, maxBytes }, ctx) => {
    const release = APP_RELEASES[app];
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (target === home) throw new OpError('refused', `${release.name} cannot be installed into the home directory itself`);
    if (inspectAppTree(target) || lexists(path.join(target, 'wp-settings.php'))) throw new OpError('exists', `${relOf(home, target)} already contains a web application`);
    requireBins([release.format === 'zip' ? 'unzip' : 'tar', 'mkdir', 'mv', 'rm'], `install ${release.name}`);
    const existed = lexists(target);
    const scratch = scratchFile(ctx, release.format === 'zip' ? 'zip' : 'tgz');
    const stage = path.join(target, `.keel-unpack-${crypto.randomBytes(4).toString('hex')}`);
    let topLevel = [];
    let moved = false;
    try {
      const { bytes, sha256 } = await downloadArchive(release, scratch.fd, { maxBytes, timeoutMs });
      try { fs.fchownSync(scratch.fd, 0, info.gid); fs.fchmodSync(scratch.fd, 0o640); } catch (err) { throw new OpError('refused', `the archive could not be shared with ${username} (${err.code})`); }
      fs.closeSync(scratch.fd);
      scratch.fd = null;
      const zip = release.format === 'zip';
      const listing = await withScratchFd(scratch.file, (fd) => asUser(info, zip ? 'unzip' : 'tar', zip ? ['-Z', '--', '/dev/fd/0'] : ['--list', '--verbose', '--file', '/dev/fd/0'], { stdinFd: fd, allowFailure: true, timeoutMs: 300_000, maxBuffer: 64 * MiB, nice: true }));
      if (listing.code !== 0 && !(zip && listing.code === 1)) throw failureOf(listing, 'read the archive');
      const members = zip ? parseZipListing(listing.stdout) : parseTarListing(listing.stdout);
      topLevel = checkAppMembers(app, members, { dest: stage, home });
      for (const name of topLevel) if (lexists(path.join(target, name))) throw new OpError('exists', `${relOf(home, path.join(target, name))} already exists; move it away before installing ${release.name} here`);
      const mk = await asUser(info, 'mkdir', ['-p', '--', stage], { allowFailure: true, timeoutMs: 60_000 });
      if (mk.code !== 0) throw failureOf(mk, `create ${relOf(home, target)}`);
      const r = await withScratchFd(scratch.file, (fd) => (zip
        ? asUser(info, 'unzip', ['-o', '-q', '/dev/fd/0', '-d', stage], { stdinFd: fd, cwd: stage, allowFailure: true, timeoutMs: 900_000, nice: true })
        : asUser(info, 'tar', ['--extract', '--file', '/dev/fd/0', '-C', stage, '--no-same-owner', '--no-same-permissions', '--warning=no-unknown-keyword'], { stdinFd: fd, cwd: stage, allowFailure: true, timeoutMs: 900_000, nice: true })));
      if (r.code !== 0 && !(zip && r.code === 1)) throw failureOf(r, 'unpack the archive');
      const unpacked = release.root ? path.join(stage, release.root) : stage;
      const mv = await asUser(info, 'mv', ['-t', target, '--', ...topLevel.map((n) => path.join(unpacked, n))], { allowFailure: true, timeoutMs: 300_000 });
      moved = true;
      if (mv.code !== 0) throw failureOf(mv, `move the ${release.name} files into place`);
      await removeAsUser(info, [stage], 'remove the unpack directory');
      if (!appTreeCheck[app](target)) throw new OpError('command_failed', `${relOf(home, target)} does not hold a ${release.name} tree after unpacking`);
      const found = inspectAppTree(target);
      return { path: target, app, bytes, sha256, members: members.length, version: found?.version ?? release.version, topLevel };
    } catch (err) {
      let cleanup = null;
      try {
        const leftovers = [stage, ...(moved ? topLevel.map((n) => path.join(target, n)) : [])].filter((f) => lexists(f));
        if (!existed) await removeAsUser(info, [target]);
        else await removeAsUser(info, leftovers);
        cleanup = !existed ? `removed ${relOf(home, target)}` : leftovers.length ? `removed ${leftovers.length} new entr${leftovers.length === 1 ? 'y' : 'ies'} from ${relOf(home, target)}` : 'nothing was left behind';
      } catch (rmErr) { cleanup = `${relOf(home, target)} was left in place (${rmErr.message}); remove it before retrying`; }
      const failure = err instanceof OpError ? err : new OpError('command_failed', err.message);
      failure.details = { ...(failure.details || {}), cleanup };
      throw failure;
    } finally {
      if (scratch.fd != null) { try { fs.closeSync(scratch.fd); } catch { /* closed */ } }
      try { fs.unlinkSync(scratch.file); } catch { /* gone */ }
    }
  },
});

defineOp('web.app.joomla.install', {
  description: "Run Joomla's own CLI installer (installation/joomla.php install) as the account: database schema, administrator, configuration.php (made 0640), installation/ removed; both passwords are fed on stdin",
  destructive: true,
  timeoutMs: 1_200_000,
  schema: z.object({
    ...base, url: siteUrl, title: siteTitle, adminUser: adminName, adminEmail: z.email().max(254), adminPassword: joomlaSecret,
    dbName: dbIdent(64), dbUser: dbIdent(80), dbPassword: secret, dbHost: arg.mysqlHost.default('localhost'), dbPrefix: dbPrefix.default('jos_'),
  }).strict(),
  run: async ({ username, path: p, url, title, adminUser, adminEmail, adminPassword, dbName, dbUser, dbPassword, dbHost, dbPrefix }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (!isJoomlaTree(target)) throw new OpError('not_found', `${relOf(home, target)} does not hold an unpacked Joomla tree`);
    if (!regularFileStat(path.join(target, 'installation', 'joomla.php'))) throw new OpError('not_found', `${relOf(home, target)} has no installation/joomla.php (already installed, or not a full package)`);
    if (lexists(path.join(target, 'configuration.php'))) throw new OpError('exists', `${relOf(home, target)}/configuration.php already exists`);
    requireBins(['php'], 'install Joomla');
    const argv = joomlaInstallArgv({ title, adminUser, adminEmail, dbHost, dbUser, dbName, dbPrefix });
    const r = await asUser(info, 'php', ['-d', 'memory_limit=512M', ...argv], { cwd: target, input: `${adminPassword}\n${dbPassword}\n`, allowFailure: true, timeoutMs: 900_000, env: { SHELL_INTERACTIVE: '1' } });
    const verdict = joomlaInstallVerdict(r);
    if (!verdict.ok) throw new OpError('command_failed', verdict.message, { output: r.stdout.slice(-3000) });
    const config = path.join(target, 'configuration.php');
    if (!regularFileStat(config)) throw new OpError('command_failed', 'Joomla reported success but configuration.php was not written');
    const chmod = await asUser(info, 'chmod', ['--', '0640', config], { allowFailure: true, timeoutMs: 30_000 });
    const warning = chmod.code === 0 ? null : `configuration.php could not be made 0640: ${failureOf(chmod, 'chmod').message}`;
    if (lstatOrNull(path.join(target, 'installation'))?.isDirectory()) await removeAsUser(info, [path.join(target, 'installation')], 'remove the installation directory');
    return { path: target, url, adminUrl: `${url.replace(/\/+$/, '')}/administrator/`, version: parseJoomlaVersion(readSiteFile(path.join(target, 'libraries', 'src', 'Version.php'))), warning };
  },
});

defineOp('web.app.drupal.configure', {
  description: "Write sites/default/settings.php (database, hash salt, config sync directory, trusted hosts) into an unpacked Drupal tree as the account, 0640, and create sites/default/files; the site's own web installer finishes the setup",
  destructive: true,
  schema: z.object({
    ...base, dbName: dbIdent(64), dbUser: dbIdent(80), dbPassword: secret, dbHost: arg.mysqlHost.default('localhost'), dbPrefix: z.union([z.literal(''), dbPrefix]).default(''),
    trustedHosts: z.array(hostPattern).min(1).max(20),
  }).strict(),
  run: async ({ username, path: p, dbName, dbUser, dbPassword, dbHost, dbPrefix, trustedHosts }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (!isDrupalTree(target)) throw new OpError('not_found', `${relOf(home, target)} does not hold an unpacked Drupal tree`);
    const file = path.join(target, 'sites', 'default', 'settings.php');
    if (lexists(file)) throw new OpError('exists', `${relOf(home, file)} already exists`);
    const syncDir = `sites/default/files/config_${randomToken(32)}/sync`;
    const content = renderDrupalSettings({ dbName, dbUser, dbPassword, dbHost, dbPrefix, hashSalt: randomToken(64), syncDir, trustedHosts });
    const mk = await asUser(info, 'mkdir', ['-p', '-m', '0755', '--', path.join(target, 'sites', 'default', 'files')], { allowFailure: true, timeoutMs: 60_000 });
    if (mk.code !== 0) throw failureOf(mk, 'create sites/default/files');
    await stagedWrite(info, home, file, Buffer.from(content, 'utf8'), '0640');
    let linted = false;
    if (hasBinary('php')) {
      const r = await asUser(info, 'php', ['-l', file], { allowFailure: true, timeoutMs: 60_000 });
      if (r.code !== 0) {
        await asUser(info, 'rm', ['-f', '--', file], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
        throw new OpError('command_failed', `the generated settings.php did not pass php -l: ${(r.stderr || r.stdout).trim().split('\n').pop() || 'no output'}`);
      }
      linted = true;
    }
    return { path: file, mode: '0640', linted, syncDir, installPath: 'core/install.php', version: parseDrupalVersion(readSiteFile(path.join(target, 'core', 'lib', 'Drupal.php'))) };
  },
});

defineOp('web.app.remove', {
  description: "Remove a Joomla or Drupal installation as the account: the whole directory ('tree'), or only the release's own top-level entries when the site shares a document root ('entries')",
  destructive: true,
  timeoutMs: 600_000,
  schema: z.object({ ...base, app: appId, mode: z.enum(['tree', 'entries']) }).strict(),
  run: async ({ username, path: p, app, mode }, ctx) => {
    const release = APP_RELEASES[app];
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (target === home) throw new OpError('refused', 'the home directory itself is never removed');
    if (!appTreeCheck[app](target)) throw new OpError('not_found', `${relOf(home, target)} does not hold a ${release.name} installation`);
    requireBins(['rm'], `remove ${release.name}`);
    const targets = mode === 'tree' ? [target] : release.topLevel.map((n) => path.join(target, n)).filter((f) => lexists(f));
    await removeAsUser(info, targets);
    return { path: target, app, mode, removed: targets.map((f) => relOf(home, f)) };
  },
});
