import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { exec, hasBinary } from '../exec.js';
import { HOST_VHOST, apacheLayout } from './web.js';

// A webmail client installed from the distribution: where it is, how it is
// published by Apache, and the one Keel-managed block in Roundcube's
// config.inc.php (mail hosts + product name). The client's own secrets
// (database password, DES key) are read into memory only to rewrite the file
// around them and are never returned.

// Debian splits Roundcube: /usr/share/roundcube holds the program, the web root
// is /var/lib/roundcube/public_html (symlinks back into /usr/share). Both are
// the same install, so either may appear as an Alias target.
export const WEBMAIL_CANDIDATES = [
  { flavor: 'roundcube', path: '/var/lib/roundcube', webRoot: 'public_html', config: '/etc/roundcube/config.inc.php', related: ['/usr/share/roundcube'] },
  { flavor: 'roundcube', path: '/usr/share/roundcube', config: '/etc/roundcube/config.inc.php', related: ['/var/lib/roundcube'] },
  // RHEL / EPEL package name.
  { flavor: 'roundcube', path: '/usr/share/roundcubemail', config: '/etc/roundcubemail/config.inc.php', related: [] },
  { flavor: 'roundcube', path: '/usr/share/nginx/html/roundcube', config: null, related: [] },
  { flavor: 'roundcube', path: '/var/www/roundcube', config: null, related: [] },
  { flavor: 'rainloop', path: '/usr/share/rainloop', config: null, related: [] },
  { flavor: 'snappymail', path: '/usr/share/snappymail', config: null, related: [] },
];
export const ROUNDCUBE_CONFIG = '/etc/roundcube/config.inc.php';

// Web-server fragments that commonly publish the client under an alias.
const ALIAS_FILES = [
  '/etc/apache2/conf-enabled/roundcube.conf', '/etc/apache2/conf-available/roundcube.conf', '/etc/apache2/conf.d/roundcube.conf',
  '/etc/httpd/conf.d/roundcubemail.conf', '/etc/httpd/conf.d/roundcube.conf',
  '/etc/apache2/conf-enabled/rainloop.conf', '/etc/apache2/conf-enabled/snappymail.conf',
];
const HOST_APP_MARK = '# keel-host-app ';
const MAX_READ = 256 * 1024;
const MAX_SCAN_FILES = 200;
const BACKUP_ROOT = '/var/lib/whm/backups/config';

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

function readHead(file, max = MAX_READ) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

export function roundcubeVersion(text) {
  const m = String(text || '').match(/RCMAIL_VERSION'\s*,\s*'([0-9][0-9A-Za-z.-]{0,30})'/) || String(text || '').match(/\bVersion\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  return m ? m[1] : null;
}

function versionedDirs(base) {
  try { return fs.readdirSync(path.join(base, 'v')).filter((d) => /^[0-9][0-9A-Za-z.-]{0,30}$/.test(d)).sort().pop() || null; } catch { return null; }
}

export function detectVersion(flavor, root) {
  if (flavor === 'roundcube') return roundcubeVersion(readHead(path.join(root, 'program', 'include', 'iniset.php'), 64 * 1024)) || roundcubeVersion(readHead(path.join(root, 'index.php'), 16 * 1024));
  return versionedDirs(path.join(root, flavor)) || versionedDirs(root);
}

// Every "Alias <url> <dir>" whose target is one of `roots` (symlinks resolved,
// so /var/lib/roundcube/public_html and the /usr/share tree it links to both
// count). Commented lines never match; `global` says the line sits outside any
// <VirtualHost>, i.e. the distro's every-vhost alias.
export function aliasesIn(text, roots) {
  const wanted = new Set([].concat(roots).filter(Boolean).flatMap((r) => [path.resolve(r), realpath(r)]));
  const out = [];
  let depth = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (/^<VirtualHost\b/i.test(line)) depth++;
    else if (/^<\/VirtualHost>/i.test(line)) depth = Math.max(0, depth - 1);
    const m = line.match(/^Alias\s+"?(\/[A-Za-z0-9._\/-]*)"?\s+"?([^\s"]+)"?\s*$/i);
    if (!m) continue;
    const target = m[2].replace(/\/+$/, '') || '/';
    if (wanted.has(path.resolve(target)) || wanted.has(realpath(target))) out.push({ alias: m[1].length > 1 ? m[1].replace(/\/+$/, '') : m[1], global: depth === 0 });
  }
  return out;
}

export function aliasFor(text, roots) {
  return aliasesIn(text, roots)[0]?.alias ?? null;
}

function listConf(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.conf')).sort().map((f) => path.join(dir, f)); } catch { return []; }
}

// Files that may publish the client, managed drop-ins first so the panel's own
// publication wins over a distro fragment that happens to be enabled too.
function aliasSources(apache) {
  const managed = apache ? listConf(path.join(apache.root, HOST_VHOST.appsDirName)).map((file) => ({ file, kind: 'keel-host' })) : [];
  const distro = ALIAS_FILES.map((file) => ({ file, kind: 'distro' }));
  const enabled = apache ? (apache.flavor === 'debian' ? [...listConf(apache.confEnabled), ...listConf(apache.sitesEnabled)] : listConf(apache.confD)).map((file) => ({ file, kind: 'distro' })) : [];
  const seen = new Set();
  return [...managed, ...distro, ...enabled].filter((s) => { const k = realpath(s.file); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_SCAN_FILES);
}

// ------------------------------------------------- Roundcube config block ---

export const CONFIG_BLOCK = { begin: '// BEGIN Keel (Webmail) - managed block, edits inside are overwritten', end: '// END Keel (Webmail)' };

const phpString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const hostUri = (scheme, host, port) => (scheme === 'plain' ? `${host}:${port}` : `${scheme}://${host}:${port}`);

export function renderRoundcubeBlock(a) {
  return [
    `$config['imap_host'] = ${phpString(hostUri(a.imapScheme, a.hostname, a.imapPort))};`,
    `$config['smtp_host'] = ${phpString(hostUri(a.smtpScheme, a.hostname, a.smtpPort))};`,
    `$config['product_name'] = ${phpString(a.productName)};`,
  ].join('\n');
}

function findBlock(text) {
  const start = text.indexOf(CONFIG_BLOCK.begin);
  const stop = text.indexOf(CONFIG_BLOCK.end);
  return start !== -1 && stop !== -1 && stop >= start ? { start, stop } : null;
}

// The block is appended at the end of the file; a closing "?>" there would turn
// everything after it into page output, so the block goes in front of it.
export function mergeConfigBlock(previous, content) {
  const block = `${CONFIG_BLOCK.begin}\n${String(content).trimEnd()}\n${CONFIG_BLOCK.end}\n`;
  const text = previous || '';
  const found = findBlock(text);
  if (found) return `${text.slice(0, found.start)}${block}${text.slice(found.stop + CONFIG_BLOCK.end.length).replace(/^\n/, '')}`;
  const tail = text.match(/\?>\s*$/);
  if (tail) { const head = text.slice(0, tail.index).replace(/\s*$/, ''); return `${head}\n\n${block}${tail[0].trim()}\n`; }
  return `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${block}`;
}

export function stripConfigBlock(text) {
  const t = text || '';
  const found = findBlock(t);
  if (!found) return t;
  return `${t.slice(0, found.start).replace(/\n+$/, '\n')}${t.slice(found.stop + CONFIG_BLOCK.end.length).replace(/^\n/, '')}`;
}

export function readConfigBlock(text) {
  const t = text || '';
  const found = findBlock(t);
  if (!found) return null;
  const body = t.slice(found.start + CONFIG_BLOCK.begin.length, found.stop);
  const value = (key) => { const m = body.match(new RegExp(`\\$config\\['${key}'\\]\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)';`)); return m ? m[1].replace(/\\(.)/g, '$1') : null; };
  return { imapHost: value('imap_host'), smtpHost: value('smtp_host'), productName: value('product_name') };
}

function statConfig(file) {
  let st = null;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile()) throw new OpError('refused', `${file} is not a regular file`);
  return st;
}

function writeBackup(file, previous, st) {
  try {
    const backup = path.join(BACKUP_ROOT, file);
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.writeFileSync(backup, previous, { mode: 0o600 });
    fs.chmodSync(backup, 0o600);
    fs.chownSync(backup, st.uid, st.gid);
  } catch { /* best effort */ }
}

// Writes the new content next to the file, lints it with php -l, and only then
// renames it into place with the original owner and mode; a rejected file never
// replaces the one Roundcube is running with.
async function replaceConfig(ctx, file, previous, content) {
  const st = statConfig(file);
  if (!hasBinary('php')) throw new OpError('capability_missing', 'php (php-cli) is not installed, so config.inc.php cannot be validated before it is written');
  ctx.assertAllowedPath(BACKUP_ROOT, 'write');
  const tmp = `${file}.whm-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    const lint = await exec('php', ['-n', '-l', tmp], { allowFailure: true, timeoutMs: 30_000 });
    if (lint.code !== 0) throw new OpError('config_invalid', `php -l rejected the new config.inc.php; the previous file was kept: ${`${lint.stdout}${lint.stderr}`.trim().split('\n').filter(Boolean).pop() || `exit ${lint.code}`}`, { output: `${lint.stdout}${lint.stderr}`.slice(-4000), path: file });
    fs.chownSync(tmp, st.uid, st.gid);
    fs.chmodSync(tmp, st.mode & 0o7777);
    writeBackup(file, previous, st);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed */ }
  }
  return { validated: true };
}

function loadConfig(ctx, file) {
  const st = statConfig(file);
  if (!st) throw new OpError('not_found', `${file} does not exist; Roundcube is not configured on this server`);
  const previous = fs.readFileSync(file, 'utf8');
  if (!/^\s*<\?php\b/.test(previous)) throw new OpError('refused', `${file} does not look like a PHP configuration file; refusing to edit it`);
  return previous;
}

// ---------------------------------------------------------------- detect ---

function findInstall() {
  const hit = WEBMAIL_CANDIDATES.find((c) => isDir(c.path));
  if (!hit) return null;
  const webRoot = hit.webRoot && isDir(path.join(hit.path, hit.webRoot)) ? path.join(hit.path, hit.webRoot) : hit.path;
  const roots = [...new Set([webRoot, hit.path, ...hit.related.filter(isDir)])];
  return { ...hit, root: webRoot, roots };
}

defineOp('web.webmail.detect', {
  description: 'Detect a distribution-installed webmail client (Roundcube, RainLoop, SnappyMail): flavor, install path, web root, version, the Apache alias publishing it (managed drop-in or distro fragment) and the state of the Keel block in Roundcube config.inc.php',
  schema: z.object({ lint: z.boolean().default(false) }).strict(),
  run: async ({ lint }, ctx) => {
    const hit = findInstall();
    const none = { installed: false, flavor: null, path: null, root: null, version: null, configured: null, apacheAlias: null, published: null, globalAlias: null, config: null };
    if (!hit) return none;
    const apache = apacheLayout();
    let published = null;
    let globalAlias = null;
    for (const source of aliasSources(apache)) {
      try { ctx.assertAllowedPath(source.file, 'read'); } catch { continue; }
      if (!isFile(source.file)) continue;
      const text = readHead(source.file);
      const matches = aliasesIn(text, hit.roots);
      if (!matches.length) continue;
      const managed = source.kind === 'keel-host' && String(text).includes(HOST_APP_MARK);
      if (!published) published = { alias: matches[0].alias, file: source.file, managed, source: source.kind };
      if (!globalAlias && source.kind === 'distro' && matches.some((m) => m.global) && /\/(?:conf-enabled|conf\.d)\//.test(source.file)) globalAlias = { alias: matches.find((m) => m.global).alias, file: source.file };
    }
    let config = null;
    if (hit.config) {
      let text = null;
      try { ctx.assertAllowedPath(hit.config, 'read'); text = isFile(hit.config) ? readHead(hit.config) : null; } catch { text = null; }
      let ok = null;
      if (lint && text != null && hasBinary('php')) { const r = await exec('php', ['-n', '-l', hit.config], { allowFailure: true, timeoutMs: 30_000 }); ok = r.code === 0; }
      config = { path: hit.config, exists: text != null, ok, managed: text != null ? readConfigBlock(text) : null };
    }
    return {
      installed: true,
      flavor: hit.flavor,
      path: hit.path,
      root: hit.root,
      version: detectVersion(hit.flavor, hit.path),
      configured: hit.config ? Boolean(config?.exists) : null,
      apacheAlias: published?.alias ?? null,
      published,
      globalAlias,
      config,
    };
  },
});

// ---------------------------------------------------------------- config ---

const productName = z.string().min(1).max(80).regex(/^[^\0-\x1f\x7f]*$/, 'single line');
const port = z.number().int().min(1).max(65535);
const configSchema = z.object({
  hostname: arg.domain,
  imapScheme: z.enum(['ssl', 'tls', 'plain']).default('ssl'), imapPort: port.default(993),
  smtpScheme: z.enum(['ssl', 'tls', 'plain']).default('tls'), smtpPort: port.default(587),
  productName,
}).strict();

// The detected install's config (Debian /etc/roundcube, RHEL /etc/roundcubemail); the
// Debian path when nothing is installed, so the caller gets not_found rather than a guess.
const roundcubeConfigFile = () => findInstall()?.config || ROUNDCUBE_CONFIG;

defineOp('web.webmail.config.write', {
  description: 'Write the Keel-managed block at the end of Roundcube config.inc.php (/etc/roundcube or /etc/roundcubemail: imap_host, smtp_host, product_name), validated with php -l on a copy before the file is replaced; everything else in the file is kept',
  schema: configSchema,
  run: async (a, ctx) => {
    const file = ctx.assertAllowedPath(roundcubeConfigFile(), 'write');
    const previous = loadConfig(ctx, file);
    const content = mergeConfigBlock(previous, renderRoundcubeBlock(a));
    const values = readConfigBlock(content);
    if (content === previous) return { path: file, changed: false, validated: null, values };
    const r = await replaceConfig(ctx, file, previous, content);
    return { path: file, changed: true, validated: r.validated, values };
  },
});

defineOp('web.webmail.config.remove', {
  description: 'Remove the Keel-managed block from Roundcube config.inc.php (the distribution defaults apply again), validated with php -l before the file is replaced',
  destructive: true,
  schema: z.object({}).strict(),
  run: async (_args, ctx) => {
    const file = ctx.assertAllowedPath(roundcubeConfigFile(), 'write');
    const previous = loadConfig(ctx, file);
    const content = stripConfigBlock(previous);
    if (content === previous) return { path: file, changed: false, validated: null };
    const r = await replaceConfig(ctx, file, previous, content);
    return { path: file, changed: true, validated: r.validated };
  },
});
