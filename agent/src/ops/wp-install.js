import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { z } from 'zod';
import { exec, hasBinary } from '../exec.js';
import { defineOp, arg, OpError, ensurePrivateDir } from './registry.js';
import { accountPath, asUser, failureOf, lstatOrNull, privilegeTool } from './as-user.js';
import { parseZipListing, checkArchiveMembers, diskLinkReader, stagedWrite } from './files.js';
import { regularFileStat, readSiteFile, parseWpVersion } from './web.js';

// WordPress installs from the account panel on a host without WP-CLI (the
// web.wp.* ops in web.js stay the WP-CLI path and are reused when `wp` is
// present). Root does three things only: it downloads the release archive
// into its own scratch directory and checks it against the published hash,
// it answers the installer's one HTTP request over loopback, and it looks at
// metadata (lstat) inside the account's tree. Everything that touches files
// in the home — listing and unpacking the archive, moving the tree into
// place, writing wp-config.php, removing a site — runs as the account through
// as-user.js, so the kernel's ownership and quota rules decide, and a link the
// account planted can only ever point the account at what it may already reach.

export const WP_DOWNLOAD_URL = 'https://wordpress.org/latest.zip';
export const WP_CHECKSUM_URL = 'https://wordpress.org/latest.zip.sha1';
export const WP_DOWNLOAD_MAX_BYTES = 96 * 1024 * 1024;
export const WP_DOWNLOAD_TIMEOUT_MS = 120_000;
export const WP_ARCHIVE_ROOT = 'wordpress';
// The files a release archive puts at the top of the tree: what a removal
// inside a document root may delete (everything else there is the account's).
export const WP_TOP_LEVEL = Object.freeze([
  'wp-admin', 'wp-includes', 'wp-content', 'index.php', 'license.txt', 'readme.html', 'wp-activate.php', 'wp-blog-header.php',
  'wp-comments-post.php', 'wp-config.php', 'wp-config-sample.php', 'wp-cron.php', 'wp-links-opml.php', 'wp-load.php', 'wp-login.php',
  'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php',
]);
export const WP_SALT_KEYS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
const SALT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_[]{}<>~+=,.;:/?|';
const SCRATCH_DIR = '/tmp/whm';
const MiB = 1024 * 1024;
const RESPONSE_MAX_BYTES = MiB;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

const base = { username: arg.username, path: arg.absPath };
const wpUrl = z.string().max(300).regex(/^https?:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{2,5})?(\/[A-Za-z0-9._~\-/]*)?$/i, 'http(s) site URL');
const wpTitle = z.string().min(1).max(120).regex(/^[^\0\r\n]+$/, 'Single-line title');
const wpUser = z.string().regex(/^[a-z0-9][a-z0-9._@-]{0,59}$/i, 'WordPress user name');
const wpSecret = z.string().min(8).max(128).regex(/^[^\0\r\n]+$/);
const wpLocale = z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?(_[a-z]+)?$/).default('en_US');
const dbIdent = (max) => z.string().regex(new RegExp(`^[A-Za-z0-9_]{1,${max}}$`));

const lexists = (p) => lstatOrNull(p) !== null;

// --------------------------------------------------------------- helpers ---

function scratchFile(ctx) {
  ctx.assertAllowedPath(SCRATCH_DIR, 'write');
  const dir = ensurePrivateDir(SCRATCH_DIR);
  const file = path.join(dir, `wp-${process.pid}-${crypto.randomBytes(8).toString('hex')}.zip`);
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  return { file, fd };
}

async function withScratchFd(file, fn) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  try { return await fn(fd); } finally { fs.closeSync(fd); }
}

async function fetchFollowing(url, { timeoutMs, accept }) {
  let current = url;
  for (let hop = 0; ; hop++) {
    let res;
    try { res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: accept, 'User-Agent': 'keel-panel' } }); } catch (err) {
      throw new OpError('download_failed', `Download of ${current} failed: ${err.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : err.message}`);
    }
    if (res.status < 300 || res.status >= 400) {
      if (!res.ok) throw new OpError('download_failed', `Download failed: HTTP ${res.status} for ${current}`);
      return res;
    }
    const location = res.headers.get('location');
    if (!location) throw new OpError('download_failed', `Download failed: HTTP ${res.status} without a Location header for ${current}`);
    const next = new URL(location, current).toString();
    if (!next.startsWith('https://')) throw new OpError('refused', `Refusing to follow a redirect to a non-https URL (${next})`);
    if (hop >= 5) throw new OpError('download_failed', `Too many redirects while downloading ${url}`);
    current = next;
  }
}

// Streams the archive onto root's scratch descriptor, hashing as it goes; the
// size is bounded by Content-Length when present and by the bytes written
// regardless, and the whole transfer shares one deadline.
async function downloadArchive(url, fd, { maxBytes, timeoutMs }) {
  const res = await fetchFollowing(url, { timeoutMs, accept: 'application/zip' });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new OpError('too_large', `The archive is ${declared} bytes, more than the ${maxBytes} allowed`);
  const hash = crypto.createHash('sha1');
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
    throw new OpError('download_failed', `Download of ${url} was interrupted: ${err.message}`);
  } finally { clearTimeout(deadline); }
  if (!head || !(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) throw new OpError('download_failed', 'The download is not a zip archive');
  return { bytes: total, sha1: hash.digest('hex') };
}

async function publishedChecksum(url, timeoutMs) {
  const res = await fetchFollowing(url, { timeoutMs, accept: 'text/plain' });
  const text = (await res.text()).trim().slice(0, 200);
  const m = /^[a-f0-9]{40}/i.exec(text);
  if (!m) throw new OpError('download_failed', `The checksum file at ${url} did not contain a SHA-1 digest`);
  return m[0].toLowerCase();
}

// A release archive holds exactly one top-level directory, `wordpress/`, with
// plain files and directories inside it: a member anywhere else, a link, or
// anything the general archive check refuses (".." names, links out of the
// destination, .ssh) fails the whole install before a byte is unpacked.
export function checkWordPressMembers(members, { dest, home }) {
  if (!members.length) throw new OpError('refused', 'The archive is empty');
  const top = new Set();
  for (const m of members) {
    const name = m.name.replace(/\/+$/, '');
    if (!name || name === '.') continue;
    const parts = name.split('/');
    if (parts[0] !== WP_ARCHIVE_ROOT || parts.includes('..') || parts.includes('') ) throw new OpError('refused', `the archive member "${m.name}" is outside ${WP_ARCHIVE_ROOT}/`);
    if (m.type !== 'file' && m.type !== 'dir') throw new OpError('refused', `the archive member "${m.name}" is a ${m.type}; a WordPress release contains only files and directories`);
    if (parts.length > 1) top.add(parts[1]);
  }
  checkArchiveMembers(members, { home, dest, allowSshDir: false, readLink: diskLinkReader() });
  if (!top.has('wp-settings.php') || !top.has('wp-includes')) throw new OpError('refused', 'The archive does not look like a WordPress release (no wp-settings.php / wp-includes)');
  return [...top].sort();
}

const phpString = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function randomSalt(length = 64) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += SALT_ALPHABET[bytes[i] % SALT_ALPHABET.length];
  return out;
}

export function renderWpConfig({ dbName, dbUser, dbPassword, dbHost, tablePrefix, salts = {} }) {
  const lines = [
    '<?php',
    '// Written by the account panel; the database password is also stored in the panel.',
    `define( 'DB_NAME', ${phpString(dbName)} );`,
    `define( 'DB_USER', ${phpString(dbUser)} );`,
    `define( 'DB_PASSWORD', ${phpString(dbPassword)} );`,
    `define( 'DB_HOST', ${phpString(dbHost)} );`,
    "define( 'DB_CHARSET', 'utf8mb4' );",
    "define( 'DB_COLLATE', '' );",
    '',
  ];
  for (const key of WP_SALT_KEYS) lines.push(`define( '${key}', ${phpString(salts[key] || randomSalt())} );`);
  lines.push('', `$table_prefix = ${phpString(tablePrefix)};`, '', "define( 'WP_DEBUG', false );", "define( 'FS_METHOD', 'direct' );", '',
    "if ( ! defined( 'ABSPATH' ) ) {", "\tdefine( 'ABSPATH', __DIR__ . '/' );", '}', '', "require_once ABSPATH . 'wp-settings.php';", '');
  return lines.join('\n');
}

// What the installer's answer means. WordPress renders "Success!" with the
// login link on a finished install, "already installed" when the tables are
// there, and wp_die() markup for everything it refused.
export function parseInstallResponse(status, body) {
  const plain = String(body || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (/already installed/i.test(plain)) return { ok: false, code: 'exists', message: 'WordPress reports that it is already installed at this address' };
  if (status === 200 && /\bSuccess!|has been installed/i.test(plain)) return { ok: true, code: null, message: null };
  const m = /(Error establishing a database connection|ERROR:\s*[^.]{1,200}\.?|Error:\s*[^.]{1,200}\.?|[^.]{0,120}\b(?:is required|must be|cannot|not valid|not a valid)\b[^.]{0,120}\.)/i.exec(plain);
  const detail = m ? m[0].trim() : plain.slice(0, 200);
  return { ok: false, code: 'command_failed', message: `the WordPress installer answered ${status ?? 'nothing'}${detail ? `: ${detail}` : ''}` };
}

function postLoopback({ url, ip, form, timeoutMs }) {
  const u = new URL(url);
  const tls = u.protocol === 'https:';
  const port = Number(u.port) || (tls ? 443 : 80);
  const body = form.toString();
  const options = {
    host: ip, port, path: `${u.pathname}${u.search}`, method: 'POST', timeout: timeoutMs,
    headers: { Host: u.host, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'keel-panel', Accept: 'text/html' },
    ...(tls ? { servername: u.hostname, rejectUnauthorized: false } : {}),
  };
  return new Promise((resolve) => {
    const req = (tls ? https : http).request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { if (size < RESPONSE_MAX_BYTES) { chunks.push(c); size += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), error: null }));
      res.on('error', (err) => resolve({ status: res.statusCode, body: '', error: err.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => resolve({ status: null, body: '', error: err.message }));
    req.end(body);
  });
}

function requireBins(bins, what) {
  for (const b of bins) if (!hasBinary(b)) throw new OpError('capability_missing', `${b} is not installed on this server; it is required to ${what}`);
}

const relOf = (home, p) => path.relative(home, p) || '.';
const isWordPressTree = (dir) => Boolean(regularFileStat(path.join(dir, 'wp-settings.php'))) && Boolean(lstatOrNull(path.join(dir, 'wp-includes'))?.isDirectory());

async function removeAsUser(info, targets, what = 'remove the WordPress files') {
  if (!targets.length) return;
  const r = await asUser(info, 'rm', ['-rf', '--one-file-system', '--', ...targets], { allowFailure: true, timeoutMs: 300_000 });
  if (r.code !== 0) throw failureOf(r, what);
}

// ------------------------------------------------------------------- ops ---

defineOp('web.wp.requirements', {
  description: 'What a WordPress install from the panel needs on this host: WP-CLI, or php with a MySQL driver plus unzip, and setpriv/runuser',
  run: async () => {
    const php = hasBinary('php');
    let phpMysql = null;
    if (php) {
      const r = await exec('php', ['-m'], { allowFailure: true, timeoutMs: 30_000 });
      if (r.code === 0) phpMysql = /^(mysqli|pdo_mysql)$/mi.test(r.stdout);
    }
    return { wpcli: hasBinary('wp'), php, phpMysql, unzip: hasBinary('unzip'), asUser: privilegeTool() !== null };
  },
});

defineOp('web.wp.fetch', {
  description: 'Download the current WordPress release into a directory of an account home: fetched by root into its scratch directory, checked against the published SHA-1 and a size limit, listed and unpacked as the account (members must all sit under wordpress/, no links, no traversal) and moved into place as the account',
  destructive: true,
  timeoutMs: 1_200_000,
  schema: z.object({ ...base, timeoutMs: z.number().int().min(10_000).max(WP_DOWNLOAD_TIMEOUT_MS).default(WP_DOWNLOAD_TIMEOUT_MS), maxBytes: z.number().int().min(MiB).max(WP_DOWNLOAD_MAX_BYTES).default(WP_DOWNLOAD_MAX_BYTES) }).strict(),
  run: async ({ username, path: p, timeoutMs, maxBytes }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (target === home) throw new OpError('refused', 'WordPress cannot be installed into the home directory itself');
    if (lexists(path.join(target, 'wp-config.php')) || lexists(path.join(target, 'wp-settings.php'))) throw new OpError('exists', `${relOf(home, target)} already contains a WordPress installation`);
    requireBins(['unzip', 'mkdir', 'mv', 'rm'], 'install WordPress');
    const existed = lexists(target);
    const scratch = scratchFile(ctx);
    const unpackRoot = path.join(target, WP_ARCHIVE_ROOT);
    let topLevel = [];
    let moved = false;
    try {
      const { bytes, sha1 } = await downloadArchive(WP_DOWNLOAD_URL, scratch.fd, { maxBytes, timeoutMs });
      const expected = await publishedChecksum(WP_CHECKSUM_URL, 30_000);
      if (sha1 !== expected) throw new OpError('checksum_mismatch', `The downloaded archive does not match the published checksum (${sha1} vs ${expected})`);
      try { fs.fchownSync(scratch.fd, 0, info.gid); fs.fchmodSync(scratch.fd, 0o640); } catch (err) { throw new OpError('refused', `the archive could not be shared with ${username} (${err.code})`); }
      fs.closeSync(scratch.fd);
      scratch.fd = null;
      const listing = await withScratchFd(scratch.file, (fd) => asUser(info, 'unzip', ['-Z', '--', '/dev/fd/0'], { stdinFd: fd, allowFailure: true, timeoutMs: 300_000, maxBuffer: 64 * MiB, nice: true }));
      if (listing.code !== 0 && listing.code !== 1) throw failureOf(listing, 'read the archive');
      const members = parseZipListing(listing.stdout);
      topLevel = checkWordPressMembers(members, { dest: target, home });
      for (const name of topLevel) if (lexists(path.join(target, name))) throw new OpError('exists', `${relOf(home, path.join(target, name))} already exists; move it away before installing WordPress here`);
      if (lexists(unpackRoot)) throw new OpError('exists', `${relOf(home, unpackRoot)} already exists; move it away before installing WordPress here`);
      const mk = await asUser(info, 'mkdir', ['-p', '--', target], { allowFailure: true, timeoutMs: 60_000 });
      if (mk.code !== 0) throw failureOf(mk, `create ${relOf(home, target)}`);
      const r = await withScratchFd(scratch.file, (fd) => asUser(info, 'unzip', ['-o', '-q', '/dev/fd/0', '-d', target], { stdinFd: fd, cwd: target, allowFailure: true, timeoutMs: 900_000, nice: true }));
      if (r.code !== 0 && r.code !== 1) throw failureOf(r, 'unpack the archive');
      const mv = await asUser(info, 'mv', ['-t', target, '--', ...topLevel.map((n) => path.join(unpackRoot, n))], { allowFailure: true, timeoutMs: 300_000 });
      moved = true;
      if (mv.code !== 0) throw failureOf(mv, 'move the WordPress files into place');
      await asUser(info, 'rmdir', ['--', unpackRoot], { allowFailure: true, timeoutMs: 30_000 });
      if (!isWordPressTree(target)) throw new OpError('command_failed', `${relOf(home, target)} does not hold a WordPress tree after unpacking`);
      return { path: target, bytes, sha1, members: members.length, version: parseWpVersion(readSiteFile(path.join(target, 'wp-includes', 'version.php'))) };
    } catch (err) {
      // What this run created goes, as the account; a directory that existed
      // before keeps everything it had.
      let cleanup = null;
      try {
        const leftovers = [unpackRoot, ...(moved ? topLevel.map((n) => path.join(target, n)) : [])].filter((f) => lexists(f));
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

defineOp('web.wp.configure', {
  description: 'Write wp-config.php (database settings, locally generated salts, debug off) into an unpacked WordPress tree as the account, 0600, syntax-checked with php -l when php is present',
  destructive: true,
  schema: z.object({ ...base, dbName: dbIdent(64), dbUser: dbIdent(80), dbPassword: wpSecret, dbHost: arg.mysqlHost.default('localhost'), tablePrefix: z.string().regex(/^[a-z0-9_]{1,20}_$/).default('wp_') }).strict(),
  run: async ({ username, path: p, dbName, dbUser, dbPassword, dbHost, tablePrefix }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (!isWordPressTree(target)) throw new OpError('not_found', `${relOf(home, target)} does not hold an unpacked WordPress tree`);
    const file = path.join(target, 'wp-config.php');
    if (lexists(file)) throw new OpError('exists', `${relOf(home, file)} already exists`);
    const content = renderWpConfig({ dbName, dbUser, dbPassword, dbHost, tablePrefix });
    await stagedWrite(info, home, file, Buffer.from(content, 'utf8'), '0600');
    let linted = false;
    if (hasBinary('php')) {
      const r = await asUser(info, 'php', ['-l', file], { allowFailure: true, timeoutMs: 60_000 });
      if (r.code !== 0) {
        await asUser(info, 'rm', ['-f', '--', file], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {});
        throw new OpError('command_failed', `the generated wp-config.php did not pass php -l: ${(r.stderr || r.stdout).trim().split('\n').pop() || 'no output'}`);
      }
      linted = true;
    }
    return { path: file, mode: '0600', linted, tablePrefix };
  },
});

defineOp('web.wp.webinstall', {
  description: "Finish a WordPress install without WP-CLI: POST the installer's step-2 form to the site over loopback (Host header, SNI, certificates unverified) and read the answer",
  destructive: true,
  timeoutMs: 600_000,
  schema: z.object({ ...base, url: wpUrl, title: wpTitle, adminUser: wpUser, adminEmail: z.email().max(254), adminPassword: wpSecret, locale: wpLocale, ip: arg.ip.default('127.0.0.1'), timeoutMs: z.number().int().min(5000).max(300_000).default(120_000) }).strict(),
  run: async ({ username, path: p, url, title, adminUser, adminEmail, adminPassword, locale, ip, timeoutMs }, ctx) => {
    const { home, target } = accountPath(username, p, ctx, 'read');
    if (!regularFileStat(path.join(target, 'wp-config.php')) || !regularFileStat(path.join(target, 'wp-admin', 'install.php'))) throw new OpError('not_found', `${relOf(home, target)} does not hold a configured WordPress tree`);
    const form = new URLSearchParams({ weblog_title: title, user_name: adminUser, admin_password: adminPassword, admin_password2: adminPassword, pw_weak: 'on', admin_email: adminEmail, language: locale === 'en_US' ? '' : locale, Submit: 'Install WordPress' });
    const endpoint = `${url.replace(/\/+$/, '')}/wp-admin/install.php?step=2`;
    const res = await postLoopback({ url: endpoint, ip, form, timeoutMs });
    if (res.error && res.status == null) throw new OpError('command_failed', `the site at ${url} could not be reached over loopback: ${res.error}`);
    const verdict = parseInstallResponse(res.status, res.body);
    if (!verdict.ok) throw new OpError(verdict.code, verdict.message, { status: res.status });
    return { url, status: res.status, installed: true, adminUrl: `${url.replace(/\/+$/, '')}/wp-admin/`, version: parseWpVersion(readSiteFile(path.join(target, 'wp-includes', 'version.php'))) };
  },
});

defineOp('web.wp.remove', {
  description: "Remove a WordPress installation as the account: the whole directory ('tree'), or only the release's own top-level entries when the site shares a document root ('entries')",
  destructive: true,
  timeoutMs: 600_000,
  schema: z.object({ ...base, mode: z.enum(['tree', 'entries']) }).strict(),
  run: async ({ username, path: p, mode }, ctx) => {
    const { info, home, target } = accountPath(username, p, ctx, 'write');
    if (target === home) throw new OpError('refused', 'the home directory itself is never removed');
    if (!isWordPressTree(target)) throw new OpError('not_found', `${relOf(home, target)} does not hold a WordPress installation`);
    requireBins(['rm'], 'remove WordPress');
    const targets = mode === 'tree' ? [target] : WP_TOP_LEVEL.map((n) => path.join(target, n)).filter((f) => lexists(f));
    await removeAsUser(info, targets);
    return { path: target, mode, removed: targets.map((f) => relOf(home, f)) };
  },
});
