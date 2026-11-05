import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import nodePath from 'node:path';
import { z } from 'zod';
import { defineOp, arg, OpError } from './registry.js';
import { accountPath, assertManaged, asUser, failureOf, lstatOrNull } from './as-user.js';
import { GROUP_NAME, groupId, stagedWrite } from './files.js';

// Every path here is a Linux path, whatever platform renders the block.
const path = nodePath.posix;

// The .htaccess family of the account panel (directory privacy, IP blocker,
// custom error pages, indexes). The panel never sends Apache directives: it
// sends a structured spec, the agent renders the one block it owns between
// "# BEGIN Keel" and "# END Keel" from a closed grammar, checks the rendered
// lines against that grammar again, and merges the block into the directory's
// .htaccess as the account (everything outside the markers is kept byte for
// byte). Apache only evaluates .htaccess on a request, so a write can be
// followed by a loopback probe of the directory: a 500 means the file broke
// the site and the previous content is put back before the op fails.

export const BEGIN = '# BEGIN Keel';
export const END = '# END Keel';
const NOTE = '# Managed by the account panel (Directory privacy, IP blocker, Error pages, Indexes). Edit through the panel; lines outside these markers are left alone.';
export const DOCROOT_PARENT = 'public_html';
export const HTPASSWD_DIR = '.keel/htpasswd';
export const HTPASSWD_ID = /^[a-f0-9]{16}$/;
export const ERROR_CODES = ['400', '401', '403', '404', '500', '503'];
export const ERROR_DOC = /^\/errors\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$/;
// A realm is quoted in AuthName: no quote, backslash or control character can
// appear in it, and it stays short.
export const REALM = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/;
export const HTPASSWD_USER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
// Apache 2.4 validates bcrypt ($2y$) through APR; the panel generates these.
export const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
export const PAGE_TITLE = /^[^\0\r\n]{1,120}$/;
const MAX_FILE = 1024 * 1024;
const MAX_IPS = 500;
const IPS_PER_LINE = 16;
const PROBE_TIMEOUT_MS = 5000;

export function parseCidr(s) {
  const m = String(s).match(/^([^/]+)(?:\/(\d{1,3}))?$/);
  if (!m) return null;
  const v4 = arg.ipv4.safeParse(m[1]).success;
  const v6 = !v4 && arg.ipv6.safeParse(m[1]).success;
  if (!v4 && !v6) return null;
  if (m[1].includes('%')) return null;
  if (m[2] != null) {
    const bits = Number(m[2]);
    if (!/^\d{1,3}$/.test(m[2]) || bits > (v4 ? 32 : 128)) return null;
    return { ip: m[1], bits, family: v4 ? 4 : 6 };
  }
  return { ip: m[1], bits: null, family: v4 ? 4 : 6 };
}
export const ipOrCidr = z.string().max(64).refine((s) => parseCidr(s) !== null, 'An IPv4/IPv6 address or CIDR range');

export const blockSchema = z.object({
  denyIps: z.array(ipOrCidr).max(MAX_IPS).default([]),
  errorDocuments: z.partialRecord(z.enum(ERROR_CODES), z.string().regex(ERROR_DOC)).default({}),
  indexes: z.enum(['inherit', 'off', 'on']).default('inherit'),
  auth: z.object({ realm: z.string().regex(REALM), userFile: arg.absPath }).strict().nullable().default(null),
}).strict();

const base = { username: arg.username };

// The directory a block is written for: inside public_html (every document
// root the panel creates is), never a symlink, and it must already exist.
function docrootDir(username, p, ctx) {
  const r = accountPath(username, p, ctx, 'write', { protectSshDir: true });
  const root = path.join(r.home, DOCROOT_PARENT);
  if (r.target !== root && !r.target.startsWith(`${root}/`)) throw new OpError('path_not_allowed', `${p} is not inside ${DOCROOT_PARENT}`);
  const st = lstatOrNull(r.target);
  if (!st) throw new OpError('not_found', `${path.relative(r.home, r.target)} does not exist`);
  if (st.isSymbolicLink()) throw new OpError('refused', `${path.relative(r.home, r.target)} is a symbolic link`);
  if (!st.isDirectory()) throw new OpError('refused', `${path.relative(r.home, r.target)} is not a directory`);
  return r;
}

function regularOrAbsent(file, what) {
  const st = lstatOrNull(file);
  if (st?.isSymbolicLink()) throw new OpError('refused', `${what} is a symbolic link; refusing to read or write through it`);
  if (st && !st.isFile()) throw new OpError('refused', `${what} exists and is not a regular file`);
  if (st && st.size > MAX_FILE) throw new OpError('refused', `${what} is larger than ${MAX_FILE} bytes; the panel will not manage it`);
  return st;
}

async function readAsUser(info, file, what) {
  const r = await asUser(info, 'cat', ['--', file], { allowFailure: true, timeoutMs: 60_000, maxBuffer: MAX_FILE + 4096 });
  if (r.code !== 0) throw failureOf(r, `read ${what}`);
  if (r.stdout.includes('\0')) throw new OpError('refused', `${what} is not a text file`);
  return r.stdout;
}

export function userFileFor(home, id) {
  if (!HTPASSWD_ID.test(id)) throw new OpError('invalid_args', 'Invalid password-file id');
  return path.join(home, HTPASSWD_DIR, id);
}

// The one accepted shape of AuthUserFile: the account's own password file.
function assertUserFile(home, userFile) {
  const dir = path.join(home, HTPASSWD_DIR);
  const resolved = path.resolve(userFile);
  if (path.dirname(resolved) !== dir || !HTPASSWD_ID.test(path.basename(resolved))) throw new OpError('invalid_args', `AuthUserFile must be a file under ${HTPASSWD_DIR} of the home directory`);
  return resolved;
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export function renderBlock(spec, { home }) {
  const s = blockSchema.parse(spec);
  const lines = [BEGIN, NOTE];
  if (s.indexes === 'off') lines.push('Options -Indexes');
  if (s.indexes === 'on') lines.push('Options +Indexes');
  for (const code of ERROR_CODES) if (s.errorDocuments[code]) lines.push(`ErrorDocument ${code} ${s.errorDocuments[code]}`);
  if (s.auth) {
    lines.push('AuthType Basic', `AuthName "${s.auth.realm}"`, `AuthUserFile "${assertUserFile(home, s.auth.userFile)}"`);
  }
  const deny = [...new Set(s.denyIps)];
  const grant = s.auth ? 'Require valid-user' : 'Require all granted';
  if (deny.length) {
    lines.push('<RequireAll>', `  ${grant}`);
    for (const part of chunk(deny, IPS_PER_LINE)) lines.push(`  Require not ip ${part.join(' ')}`);
    lines.push('</RequireAll>');
  } else if (s.auth) {
    lines.push(grant);
  }
  lines.push(END);
  return lines;
}

// Every rendered line has to match one of these; anything else is a bug in
// the renderer or a value that slipped past the schema, and is never written.
const GRAMMAR = [
  (l) => l === BEGIN || l === END || l === NOTE,
  (l) => /^Options [+-]Indexes$/.test(l),
  (l) => { const m = l.match(/^ErrorDocument (\d{3}) (\S+)$/); return Boolean(m && ERROR_CODES.includes(m[1]) && ERROR_DOC.test(m[2])); },
  (l) => l === 'AuthType Basic',
  (l) => { const m = l.match(/^AuthName "(.*)"$/); return Boolean(m && REALM.test(m[1])); },
  (l) => { const m = l.match(/^AuthUserFile "(.*)"$/); return Boolean(m && /^\/[^"\\\s\0]+$/.test(m[1]) && HTPASSWD_ID.test(path.basename(m[1])) && m[1].endsWith(`/${HTPASSWD_DIR}/${path.basename(m[1])}`)); },
  (l) => l === '<RequireAll>' || l === '</RequireAll>',
  (l) => /^ {0,2}Require (valid-user|all granted)$/.test(l),
  (l) => { const m = l.match(/^ {0,2}Require not ip((?: \S+)+)$/); return Boolean(m && m[1].trim().split(' ').every((ip) => parseCidr(ip) !== null)); },
];

export function validateBlock(lines) {
  if (lines[0] !== BEGIN || lines.at(-1) !== END) throw new OpError('config_invalid', 'The rendered block is not delimited by the Keel markers');
  for (const line of lines) {
    if (!GRAMMAR.some((rule) => rule(line))) throw new OpError('config_invalid', `The rendered .htaccess line "${line.slice(0, 80)}" is outside the panel's grammar`);
  }
  return lines;
}

// Where the managed block sits in a file: [start, end] line indexes, or null.
// A BEGIN without its END is corruption the panel refuses to write over.
const clean = (l) => l.replace(/\r$/, '');
export function locateBlock(lines) {
  const start = lines.findIndex((l) => clean(l) === BEGIN);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && clean(l) === END);
  if (end < 0) throw new OpError('config_invalid', `.htaccess has a "${BEGIN}" marker without "${END}"; fix the file in the file manager first`);
  return { start, end };
}

// Reads the structured spec back out of a block; lines that are not in the
// grammar are counted so the panel can say the block was edited by hand.
export function parseBlock(lines) {
  const spec = { denyIps: [], errorDocuments: {}, indexes: 'inherit', auth: null };
  let realm = null;
  let userFile = null;
  let foreign = 0;
  for (const raw of lines) {
    const line = clean(raw);
    let m;
    if (line === BEGIN || line === END || line === NOTE || line === '<RequireAll>' || line === '</RequireAll>' || line === 'AuthType Basic' || /^ {0,2}Require (valid-user|all granted)$/.test(line)) continue;
    if ((m = line.match(/^Options ([+-])Indexes$/))) spec.indexes = m[1] === '-' ? 'off' : 'on';
    else if ((m = line.match(/^ErrorDocument (\d{3}) (\S+)$/)) && ERROR_CODES.includes(m[1]) && ERROR_DOC.test(m[2])) spec.errorDocuments[m[1]] = m[2];
    else if ((m = line.match(/^AuthName "(.*)"$/)) && REALM.test(m[1])) realm = m[1];
    else if ((m = line.match(/^AuthUserFile "(.*)"$/))) userFile = m[1];
    else if ((m = line.match(/^ {0,2}Require not ip((?: \S+)+)$/))) spec.denyIps.push(...m[1].trim().split(' ').filter((ip) => parseCidr(ip) !== null));
    else foreign += 1;
  }
  if (realm != null && userFile != null) spec.auth = { realm, userFile };
  return { spec, foreign };
}

export function splitLines(content) {
  return String(content ?? '').split('\n');
}

// The file with the block replaced (or removed when `block` is null). The
// text outside the markers is returned as it was (line endings included); a
// new block is appended after a blank line.
export function mergeBlock(content, block) {
  const lines = splitLines(content);
  if (lines.length && lines.at(-1) === '') lines.pop();
  const at = locateBlock(lines);
  if (at) {
    const before = lines.slice(0, at.start);
    const after = lines.slice(at.end + 1);
    if (!block) {
      if (before.length && clean(before.at(-1)) === '' && (after.length === 0 || clean(after[0]) === '')) before.pop();
      const rest = [...before, ...after];
      return rest.some((l) => l.trim() !== '') ? `${rest.join('\n')}\n` : '';
    }
    return `${[...before, ...block, ...after].join('\n')}\n`;
  }
  if (!block) return content;
  const out = lines.some((l) => l.trim() !== '') ? [...lines, '', ...block] : [...block];
  return `${out.join('\n')}\n`;
}

export function parseFile(content) {
  const lines = splitLines(content);
  const at = locateBlock(lines);
  if (!at) return { managed: false, spec: null, foreign: 0 };
  const { spec, foreign } = parseBlock(lines.slice(at.start, at.end + 1));
  return { managed: true, spec, foreign };
}

// GET of one URL against the local web server (Host from the URL, TLS by
// SNI, certificates not verified: the probe asks what Apache answers, not who
// it is). Redirects are not followed; the status is the answer.
export const PROBE_URL = /^https?:\/\/(?=.{1,253}(?::|\/|$))([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?\/[^\s"\\\0]*$/;
export function probeUrl(url, { ip = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const u = new URL(url);
  const tls = u.protocol === 'https:';
  const port = Number(u.port) || (tls ? 443 : 80);
  const options = { host: ip, port, path: `${u.pathname}${u.search}`, method: 'GET', headers: { Host: u.host, 'User-Agent': 'keel-panel-probe', Accept: '*/*' }, timeout: timeoutMs, ...(tls ? { servername: u.hostname, rejectUnauthorized: false } : {}) };
  return new Promise((resolve) => {
    const req = (tls ? https : http).request(options, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null, error: null }));
      res.on('error', (err) => resolve({ status: res.statusCode, location: null, error: err.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (err) => resolve({ status: null, location: null, error: err.message }));
    req.end();
  });
}

export const brokeTheSite = (probe) => probe?.status === 500;

const probeSchema = z.object({ url: z.string().max(2048).regex(PROBE_URL), ip: arg.ip.default('127.0.0.1') }).strict();

defineOp('files.htaccess.get', {
  description: 'Read the panel-managed block of a directory\'s .htaccess inside an account\'s public_html, as the account',
  schema: z.object({ ...base, path: arg.absPath }).strict(),
  run: async ({ username, path: p }, ctx) => {
    const { info, home, target } = docrootDir(username, p, ctx);
    const file = path.join(target, '.htaccess');
    const st = regularOrAbsent(file, '.htaccess');
    const rel = path.relative(home, target) || '.';
    if (!st) return { path: file, rel, exists: false, managed: false, spec: null, foreign: 0, size: 0 };
    const content = await readAsUser(info, file, '.htaccess');
    return { path: file, rel, exists: true, size: st.size, ...parseFile(content) };
  },
});

defineOp('files.htaccess.set', {
  description: 'Render the panel-managed block from a structured spec and merge it into a directory\'s .htaccess as the account (null removes the block); an optional loopback probe rolls the file back when the site answers 500',
  schema: z.object({ ...base, path: arg.absPath, block: blockSchema.nullable(), probe: probeSchema.optional() }).strict(),
  run: async ({ username, path: p, block, probe }, ctx) => {
    const { info, home, target } = docrootDir(username, p, ctx);
    const file = path.join(target, '.htaccess');
    const rel = path.relative(home, target) || '.';
    const st = regularOrAbsent(file, '.htaccess');
    const previous = st ? await readAsUser(info, file, '.htaccess') : null;
    const rendered = block ? validateBlock(renderBlock(block, { home })) : null;
    const next = mergeBlock(previous ?? '', rendered);
    if (previous === next || (previous == null && next === '')) return { path: file, rel, changed: false, removed: false, created: false, bytes: previous?.length ?? 0, probe: null };
    const mode = st ? (st.mode & 0o777).toString(8).padStart(4, '0') : '0644';
    const remove = async () => {
      const r = await asUser(info, 'rm', ['-f', '--', file], { allowFailure: true, timeoutMs: 30_000 });
      if (r.code !== 0) throw failureOf(r, 'remove .htaccess');
    };
    if (next === '') {
      await remove();
      return { path: file, rel, changed: true, removed: true, created: false, bytes: 0, probe: null };
    }
    await stagedWrite(info, home, file, Buffer.from(next, 'utf8'), mode);
    let result = null;
    if (probe) {
      result = await probeUrl(probe.url, { ip: probe.ip });
      if (brokeTheSite(result)) {
        if (previous == null) await remove();
        else await stagedWrite(info, home, file, Buffer.from(previous, 'utf8'), mode);
        throw new OpError('config_invalid', `The web server answered 500 for ${probe.url} with the new .htaccess; the previous content was restored`, { probe: result });
      }
    }
    return { path: file, rel, changed: true, removed: false, created: !st, bytes: Buffer.byteLength(next), probe: result };
  },
});

defineOp('files.htaccess.probe', {
  description: 'GET one URL of the account\'s site against the local web server (5 s, no redirects) and report the status',
  schema: z.object({ ...base, ...probeSchema.shape }).strict(),
  run: async ({ username, url, ip }) => {
    assertManaged(username);
    return { url, ...(await probeUrl(url, { ip })) };
  },
});

// --- htpasswd files ------------------------------------------------------------------

const entrySchema = z.object({ user: z.string().regex(HTPASSWD_USER), hash: z.string().regex(BCRYPT) }).strict();

function htpasswdPath(username, id, ctx, mode) {
  const info = assertManaged(username);
  const home = path.resolve(info.home);
  const file = userFileFor(home, id);
  const r = accountPath(username, file, ctx, mode, { protectSshDir: true });
  return { info, home, file: r.target };
}

export function parseHtpasswd(content) {
  const entries = [];
  let ignored = 0;
  for (const raw of splitLines(content)) {
    const line = clean(raw);
    if (line.trim() === '') continue;
    const at = line.indexOf(':');
    const user = at > 0 ? line.slice(0, at) : null;
    const hash = at > 0 ? line.slice(at + 1) : null;
    if (user && HTPASSWD_USER.test(user) && hash && BCRYPT.test(hash)) entries.push({ user, hash });
    else ignored += 1;
  }
  return { entries, ignored };
}

// The web server's run user reads the file through its group (the home is
// traversable, the file 0640): the account cannot give a file to a group it
// is not in, so that one step is root's, on a descriptor of a regular file
// the account owns.
export function setFileGroup(target, info, gid) {
  let fd;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (err) {
    throw new OpError('refused', `${target} could not be opened (${err.code}); its group was not changed`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== info.uid) throw new OpError('refused', `${target} is not a regular file owned by ${info.username}; its group was not changed`);
    fs.fchownSync(fd, st.uid, gid);
  } finally { fs.closeSync(fd); }
}

defineOp('files.htpasswd.set', {
  description: 'Write an account\'s password file <home>/.keel/htpasswd/<id> (bcrypt entries generated by the panel) as the account, readable by the web server\'s group',
  schema: z.object({ ...base, id: z.string().regex(HTPASSWD_ID), entries: z.array(entrySchema).max(200), group: z.string().regex(GROUP_NAME).optional() }).strict(),
  run: async ({ username, id, entries, group }, ctx) => {
    const { info, home, file } = htpasswdPath(username, id, ctx, 'write');
    const gid = group ? await groupId(group) : null;
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.user)) throw new OpError('invalid_args', `User "${e.user}" is listed twice`);
      seen.add(e.user);
    }
    for (const dir of [path.join(home, '.keel'), path.join(home, HTPASSWD_DIR)]) {
      const st = lstatOrNull(dir);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new OpError('refused', `${path.relative(home, dir)} exists and is not a directory`);
      const r = await asUser(info, 'mkdir', ['-p', '-m', '0711', '--', dir], { allowFailure: true, timeoutMs: 30_000 });
      if (r.code !== 0) throw failureOf(r, `create ${path.relative(home, dir)}`);
    }
    regularOrAbsent(file, path.relative(home, file));
    const content = entries.map((e) => `${e.user}:${e.hash}\n`).join('');
    const mode = gid != null ? '0640' : '0644';
    await stagedWrite(info, home, file, Buffer.from(content, 'utf8'), mode);
    if (gid != null) setFileGroup(file, info, gid);
    return { path: file, users: entries.map((e) => e.user), mode, group: gid != null ? group : null };
  },
});

defineOp('files.htpasswd.get', {
  description: 'Read an account\'s password file <home>/.keel/htpasswd/<id> as the account',
  schema: z.object({ ...base, id: z.string().regex(HTPASSWD_ID) }).strict(),
  run: async ({ username, id }, ctx) => {
    const { info, home, file } = htpasswdPath(username, id, ctx, 'read');
    const st = regularOrAbsent(file, path.relative(home, file));
    if (!st) return { path: file, exists: false, entries: [], ignored: 0 };
    const content = await readAsUser(info, file, path.relative(home, file));
    return { path: file, exists: true, ...parseHtpasswd(content) };
  },
});

// --- custom error pages ---------------------------------------------------------------

export const ERRORS_DIR = 'errors';
const MARK = '<!-- keel-errorpage ';
const TITLES = { 400: 'Bad request', 401: 'Authorisation required', 403: 'Forbidden', 404: 'Page not found', 500: 'Server error', 503: 'Service unavailable' };

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Text only: the title and message are escaped, the page carries no script
// and no external reference, and a JSON comment lets the panel read the
// fields back without parsing HTML.
export function renderErrorPage({ code, title, message }) {
  const heading = title || TITLES[code] || `Error ${code}`;
  const paragraphs = String(message ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `    <p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  const meta = JSON.stringify({ code: String(code), title: title || '', message: String(message ?? '') }).replace(/--/g, '-\\u002d').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return [
    '<!DOCTYPE html>',
    `${MARK}${meta} -->`,
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(code)} ${escapeHtml(heading)}</title>`,
    '  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f7;color:#1d1d1f}main{max-width:36rem;padding:2rem}h1{font-size:1.75rem;margin:0 0 .5rem}p{line-height:1.5;margin:.5rem 0}.code{color:#6e6e73;font-size:.9rem;letter-spacing:.08em;text-transform:uppercase}</style>',
    '</head>',
    '<body>',
    '  <main>',
    `    <div class="code">Error ${escapeHtml(code)}</div>`,
    `    <h1>${escapeHtml(heading)}</h1>`,
    ...(paragraphs.length ? paragraphs : [`    <p>${escapeHtml(TITLES[code] || 'The server could not complete the request.')}</p>`]),
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export function parseErrorPage(content) {
  const line = splitLines(content).map(clean).find((l) => l.startsWith(MARK));
  if (!line) return null;
  try {
    const meta = JSON.parse(line.slice(MARK.length).replace(/ -->$/, ''));
    if (typeof meta?.code !== 'string') return null;
    return { code: meta.code, title: typeof meta.title === 'string' ? meta.title : '', message: typeof meta.message === 'string' ? meta.message : '' };
  } catch { return null; }
}

const pageFile = (docroot, code) => path.join(docroot, ERRORS_DIR, `${code}.html`);

defineOp('files.errorpages.list', {
  description: 'The custom error pages under <docroot>/errors of an account, read as the account (panel-written pages carry their fields back)',
  schema: z.object({ ...base, docroot: arg.absPath }).strict(),
  run: async ({ username, docroot }, ctx) => {
    const { info, home, target } = docrootDir(username, docroot, ctx);
    const dir = path.join(target, ERRORS_DIR);
    const dirStat = lstatOrNull(dir);
    if (dirStat?.isSymbolicLink()) throw new OpError('refused', `${path.relative(home, dir)} is a symbolic link`);
    const pages = [];
    for (const code of ERROR_CODES) {
      const file = pageFile(target, code);
      const st = dirStat?.isDirectory() ? lstatOrNull(file) : null;
      if (!st || !st.isFile() || st.size > MAX_FILE) { pages.push({ code, exists: Boolean(st), managed: false, title: '', message: '', size: st?.size ?? 0 }); continue; }
      const parsed = parseErrorPage(await readAsUser(info, file, `${ERRORS_DIR}/${code}.html`));
      pages.push({ code, exists: true, managed: Boolean(parsed), title: parsed?.title ?? '', message: parsed?.message ?? '', size: st.size });
    }
    return { docroot: target, dir, pages };
  },
});

defineOp('files.errorpages.write', {
  description: 'Write <docroot>/errors/<code>.html from the panel\'s text-only template as the account',
  schema: z.object({ ...base, docroot: arg.absPath, code: z.enum(ERROR_CODES), title: z.string().regex(PAGE_TITLE).or(z.literal('')).default(''), message: z.string().max(4000).regex(/^[^\0]*$/).default('') }).strict(),
  run: async ({ username, docroot, code, title, message }, ctx) => {
    const { info, home, target } = docrootDir(username, docroot, ctx);
    const dir = path.join(target, ERRORS_DIR);
    const dirStat = lstatOrNull(dir);
    if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) throw new OpError('refused', `${path.relative(home, dir)} exists and is not a directory`);
    const mk = await asUser(info, 'mkdir', ['-p', '-m', '0755', '--', dir], { allowFailure: true, timeoutMs: 30_000 });
    if (mk.code !== 0) throw failureOf(mk, `create ${path.relative(home, dir)}`);
    const file = pageFile(target, code);
    regularOrAbsent(file, `${ERRORS_DIR}/${code}.html`);
    const html = renderErrorPage({ code, title, message });
    await stagedWrite(info, home, file, Buffer.from(html, 'utf8'), '0644');
    return { path: file, rel: path.relative(home, file), bytes: Buffer.byteLength(html), url: `/${ERRORS_DIR}/${code}.html` };
  },
});
