import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HttpError, CapabilityError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// cPanel category. Attached as ctx.cpanel; other categories may call:
//   cpanel.branding.get()                -> what the browser applies (company name, colours, links, logo descriptor);
//                                           the same object is served unauthenticated from GET /api/branding
//   cpanel.news.active(user)             -> news items the given principal should see right now
//   cpanel.changelog.get(user)           -> parsed CHANGELOG.md
//   cpanel.upgrade.status()              -> last upgrade state + the release Software last saw (async, read-only)
// The release feed is Software's: ctx.software.panel.check()/status() answer
// "what is the latest version"; cpanel never fetches the feed and only keeps
// the upgrade-run record (cpanel.upgrade.last). Files: branding images under
// $WHM_DATA_DIR/branding/; release downloads under $WHM_DATA_DIR/upgrades/ (removed
// once the agent holds its copy). Trusted release-signing keys, the verified
// staging copy and the installer log belong to the root agent (cpanel.upgrade.*
// ops), never to this process: the panel only hands the agent the archive path
// and the feed's checksum/signature, and the agent decides whether to unpack
// and run anything.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const UPGRADE_JOB = 'cpanel.upgrade';
// `own` = the accounts owned by the item's author (a reseller with the `news`
// ACL, or root for the accounts it owns directly).
export const AUDIENCES = ['root', 'resellers', 'all', 'own'];
export const SEVERITIES = ['info', 'warning', 'critical'];
export const IMAGE_KINDS = { logo: { maxBytes: 512 * 1024 }, favicon: { maxBytes: 128 * 1024 } };
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const UPGRADE_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_MS = 3000;
const LOG_TAIL_BYTES = 64 * 1024;
const KEYS_CACHE_MS = 10_000;

export const BRANDING_KEYS = {
  companyName: 'branding.company_name',
  tagline: 'branding.tagline',
  primaryColor: 'branding.primary_color',
  chromeColor: 'branding.chrome_color',
  helpUrl: 'branding.help_url',
  docsUrl: 'branding.docs_url',
  supportUrl: 'branding.support_url',
  loginNotice: 'branding.login_notice',
  footerText: 'branding.footer_text',
};

// ------------------------------------------------------------ helpers -------

// Stored as 'YYYY-MM-DD HH:MM:SS' in UTC; that form must round-trip unchanged
// whatever the process time zone is, so it is never handed to Date's local parser.
const SQL_DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const sqlDate = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && SQL_DATE.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw unprocessable('Invalid date', { date: ['Must be an ISO 8601 date-time'] });
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// Only PNG, JPEG, GIF, WebP, ICO and (script-free) SVG may be stored and served back
// to every browser that loads the panel. The declared content type is ignored:
// the bytes decide.
export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { mime: 'image/png', ext: 'png' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0) return { mime: 'image/x-icon', ext: 'ico' };
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8').replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    const text = buffer.toString('utf8');
    if (/<\s*(script|iframe|embed|object|foreignObject|use)\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text)) return { mime: 'image/svg+xml', ext: 'svg', unsafe: true };
    if (/\b(xlink:)?href\s*=\s*["'](?!#)/i.test(text)) return { mime: 'image/svg+xml', ext: 'svg', unsafe: true };
    return { mime: 'image/svg+xml', ext: 'svg' };
  }
  return null;
}

// CHANGELOG.md in "Keep a Changelog" form: "## [1.2.0] - 2026-10-26" (or "## 1.2.0 (2026-10-26)")
// followed by "### Added/Changed/Fixed/..." lists.
export function parseChangelog(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const releases = [];
  let intro = [];
  let current = null;
  let section = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      const title = h2[1].trim();
      const m = /^\[?(unreleased|v?\d+(?:\.\d+){0,3}(?:[.-][0-9A-Za-z.]+)?)\]?(?:\s*[-–(]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\)?)?/i.exec(title);
      current = { version: m ? (/^unreleased$/i.test(m[1]) ? 'unreleased' : m[1].replace(/^v/, '')) : title, date: m?.[2] ?? null, unreleased: !m || /^unreleased$/i.test(m[1]), title, sections: [], body: [] };
      releases.push(current);
      section = null;
      continue;
    }
    if (!current) { intro.push(line); continue; }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) { section = { name: h3[1].trim(), items: [] }; current.sections.push(section); current.body.push(line); continue; }
    current.body.push(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item && section) section.items.push(item[1]);
    else if (section && section.items.length && /^\s{2,}\S/.test(line)) section.items[section.items.length - 1] += ` ${line.trim()}`;
  }
  for (const r of releases) r.body = r.body.join('\n').trim();
  return { intro: intro.join('\n').trim(), releases };
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return typeof y === 'string' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' ? -1 : 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// The release feed: { version, url, sha256?, signature?, keyId?, notes?, publishedAt? }
// at the top level or under tiers.<tier>. `signature` is a base64 Ed25519 signature
// over the raw SHA-256 digest of the archive, made with the key named by keyId.
// Software fetches the feed and stores its record; this shapes that record (or
// a raw feed) and keeps the verification fields only in the strict forms the
// agent accepts.
export function parseRelease(body, tier) {
  const release = body?.tiers?.[tier] ?? body?.[tier] ?? body;
  if (!release || typeof release.version !== 'string' || !/^v?\d+(\.\d+){0,3}([.-][0-9A-Za-z.]+)?$/.test(release.version)) throw new Error('update feed has no usable "version" field');
  const str = (v, re, max = 4000) => (typeof v === 'string' && (!re || re.test(v)) ? v.slice(0, max) : null);
  return {
    version: release.version.replace(/^v/, ''),
    url: str(release.url, /^https:\/\/[^\s]+$/, 2000),
    sha256: str(release.sha256, /^[0-9a-f]{64}$/i, 64)?.toLowerCase() ?? null,
    signature: str(release.signature, /^[A-Za-z0-9+/=]{80,120}$/, 120),
    keyId: str(release.keyId ?? release.kid, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 64),
    notes: str(release.notes),
    publishedAt: str(release.publishedAt, /^\d{4}-\d{2}-\d{2}/, 40),
    tier,
  };
}

export function createCpanelService(ctx) {
  const { db, settings, config, logger } = ctx;
  const dataDir = config.dataDir;
  const dirs = {
    branding: path.join(dataDir, 'branding'),
    keys: path.join(dataDir, 'release-keys'),
    upgrades: path.join(dataDir, 'upgrades'),
  };
  const S = (key, fallback) => { const v = settings.get(key, fallback); return v === undefined || v === null ? fallback : v; };
  const agentError = (err, capability) => {
    if (err?.agentError && (err.code === 'capability_missing' || err.code === 'binary_not_found')) return new CapabilityError(capability, err.message);
    return err;
  };
  // Mailman's tools take the password in argv; an exec failure's details would
  // carry that argv into the HTTP error body, so they are dropped here as well.
  const redacted = (err, capability) => {
    const mapped = agentError(err, capability);
    if (mapped?.agentError) mapped.details = {};
    return mapped;
  };

  // ---------------------------------------------------------- changelog ----
  const changelog = {
    path: path.join(REPO_ROOT, 'CHANGELOG.md'),
    // The install path is root's business; resellers get the notes only.
    get(user) {
      const exists = fs.existsSync(changelog.path);
      const markdown = exists ? fs.readFileSync(changelog.path, 'utf8') : '';
      const parsed = parseChangelog(markdown);
      const current = parsed.releases.find((r) => !r.unreleased && compareVersions(r.version, ctx.version) === 0) ?? null;
      return { version: ctx.version, path: isRoot(user) ? changelog.path : null, exists, markdown, intro: parsed.intro, releases: parsed.releases, currentRelease: current?.version ?? null };
    },
  };

  // ----------------------------------------------------------- branding ----
  const imageMeta = (kind) => { const m = S(`branding.${kind}`, null); return m && typeof m === 'object' && m.file ? m : null; };
  const imageFile = (kind, meta) => path.join(dirs.branding, path.basename(meta.file));
  const branding = {
    // Served to anyone (the login page reads it before a session exists), so
    // this is text an operator chose to show the public plus image descriptors;
    // the bytes themselves come from the public image routes.
    get() {
      const out = {};
      for (const [k, key] of Object.entries(BRANDING_KEYS)) out[k] = S(key, '') ?? '';
      out.companyName ||= 'WHM';
      for (const kind of Object.keys(IMAGE_KINDS)) {
        const meta = imageMeta(kind);
        if (!meta || !fs.existsSync(imageFile(kind, meta))) { out[kind] = null; continue; }
        out[kind] = { url: `/api/branding/${kind}?v=${meta.sha256.slice(0, 12)}`, mime: meta.mime, size: meta.size, updatedAt: meta.updatedAt };
      }
      out.links = { help: out.helpUrl, docs: out.docsUrl, support: out.supportUrl };
      return out;
    },
    update(values, req) {
      const changes = {};
      for (const [k, key] of Object.entries(BRANDING_KEYS)) if (values[k] !== undefined) changes[key] = values[k];
      if (Object.keys(changes).length === 0) throw unprocessable('Nothing to change', { companyName: ['Provide at least one field'] });
      settings.setMany(changes);
      req?.audit?.({ action: 'branding.update', args: changes });
      return branding.get();
    },
    image(kind) {
      const meta = imageMeta(kind);
      if (!meta) throw notFound(`Branding ${kind}`);
      const file = imageFile(kind, meta);
      if (!fs.existsSync(file)) throw notFound(`Branding ${kind}`);
      return { file, mime: meta.mime, size: meta.size, sha256: meta.sha256, updatedAt: meta.updatedAt };
    },
    setImage(kind, buffer, req) {
      const spec = IMAGE_KINDS[kind];
      if (!spec) throw notFound('Image kind');
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw unprocessable('Send the image bytes as the request body', { body: ['empty'] });
      if (buffer.length > spec.maxBytes) throw new HttpError(413, 'too_large', `The ${kind} may be at most ${Math.round(spec.maxBytes / 1024)} KB`);
      const type = sniffImage(buffer);
      if (!type) throw unprocessable('Unsupported image', { body: ['Use a PNG, JPEG, GIF, WebP, ICO or SVG file'] });
      if (type.unsafe) throw unprocessable('SVG files may not contain scripts, event handlers, external references or embedded documents', { body: ['unsafe SVG'] });
      if (kind === 'favicon' && !['image/x-icon', 'image/png', 'image/svg+xml'].includes(type.mime)) throw unprocessable('Favicons must be ICO, PNG or SVG', { body: ['unsupported favicon type'] });
      fs.mkdirSync(dirs.branding, { recursive: true, mode: 0o750 });
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const file = `${kind}.${type.ext}`;
      const tmp = path.join(dirs.branding, `.${file}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, buffer, { mode: 0o640 });
      fs.renameSync(tmp, path.join(dirs.branding, file));
      const previous = imageMeta(kind);
      if (previous && previous.file !== file) { try { fs.unlinkSync(imageFile(kind, previous)); } catch { /* already gone */ } }
      const meta = { file, mime: type.mime, size: buffer.length, sha256, updatedAt: new Date().toISOString() };
      settings.set(`branding.${kind}`, meta);
      req?.audit?.({ action: `branding.${kind}.upload`, args: { mime: meta.mime, size: meta.size, sha256 } });
      return branding.get()[kind];
    },
    removeImage(kind, req) {
      if (!IMAGE_KINDS[kind]) throw notFound('Image kind');
      const meta = imageMeta(kind);
      if (!meta) throw notFound(`Branding ${kind}`);
      try { fs.unlinkSync(imageFile(kind, meta)); } catch { /* already gone */ }
      settings.set(`branding.${kind}`, null);
      req?.audit?.({ action: `branding.${kind}.remove` });
      return { removed: true };
    },
  };

  // --------------------------------------------------------------- news ----
  // Status is derived in SQL so the list can filter and page there.
  const STATUS_SQL = `CASE WHEN enabled = 0 THEN 'disabled' WHEN starts_at IS NOT NULL AND starts_at > @now THEN 'scheduled' WHEN ends_at IS NOT NULL AND ends_at <= @now THEN 'expired' ELSE 'active' END`;
  const newsStmts = {
    insert: db.prepare(`INSERT INTO news (title, body_md, audience, severity, enabled, starts_at, ends_at, owner_id, created_by) VALUES (@title, @body, @audience, @severity, @enabled, @starts_at, @ends_at, @owner_id, @created_by)`),
    get: db.prepare(`SELECT *, ${STATUS_SQL} AS status FROM news WHERE id = @id`),
    update: db.prepare(`UPDATE news SET title = @title, body_md = @body, audience = @audience, severity = @severity, enabled = @enabled, starts_at = @starts_at, ends_at = @ends_at, updated_at = datetime('now') WHERE id = @id`),
    remove: db.prepare('DELETE FROM news WHERE id = ?'),
    active: db.prepare(`SELECT *, 'active' AS status FROM news WHERE enabled = 1 AND (starts_at IS NULL OR starts_at <= @now) AND (ends_at IS NULL OR ends_at > @now) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, id DESC`),
    accountOwner: db.prepare('SELECT owner_id FROM accounts WHERE username = ?'),
  };
  const shapeNews = (row) => row && ({
    id: row.id, title: row.title, body: row.body_md, audience: row.audience, severity: row.severity, enabled: Boolean(row.enabled),
    startsAt: row.starts_at, endsAt: row.ends_at, ownerId: row.owner_id, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status,
  });
  const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  // Root manages every item; a reseller holding the `news` ACL manages only the
  // items it published to its own accounts (audience `own`).
  const requireNewsAcl = (user) => { if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, 'news'); };
  const ownsItem = (user, row) => isRoot(user) || (row.owner_id != null && row.owner_id === user?.id);
  const news = {
    list({ page = 1, pageSize = 50, q, status } = {}, user) {
      requireNewsAcl(user);
      const where = [];
      const params = { now: nowSql() };
      if (q) { where.push(`(title LIKE @q ESCAPE '\\' OR body_md LIKE @q ESCAPE '\\')`); params.q = `%${likeEscape(q)}%`; }
      if (status) { where.push(`${STATUS_SQL} = @status`); params.status = status; }
      if (!isRoot(user)) { where.push('owner_id = @owner'); params.owner = user.id; }
      const sql = `FROM news ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
      const total = db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(params).n;
      const rows = db.prepare(`SELECT *, ${STATUS_SQL} AS status ${sql} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }).map(shapeNews);
      return { data: rows, meta: { page, pageSize, total } };
    },
    get(id, user) {
      requireNewsAcl(user);
      const row = newsStmts.get.get({ id, now: nowSql() });
      if (!row || !ownsItem(user, row)) throw notFound('News item');
      return shapeNews(row);
    },
    create(body, user, req) {
      requireNewsAcl(user);
      const values = news.normalise(body, user);
      const { lastInsertRowid } = newsStmts.insert.run({ ...values, owner_id: user?.id ?? null, created_by: user?.username ?? null });
      req?.audit?.({ action: 'news.create', target: String(lastInsertRowid), args: { title: values.title, audience: values.audience } });
      return news.get(Number(lastInsertRowid), user);
    },
    update(id, body, user, req) {
      const existing = news.get(id, user);
      const values = news.normalise({ title: existing.title, body: existing.body, audience: existing.audience, severity: existing.severity, enabled: existing.enabled, startsAt: existing.startsAt, endsAt: existing.endsAt, ...body }, user);
      newsStmts.update.run({ ...values, id });
      req?.audit?.({ action: 'news.update', target: String(id), args: { title: values.title, audience: values.audience, enabled: Boolean(values.enabled) } });
      return news.get(id, user);
    },
    remove(id, user, req) {
      news.get(id, user);
      newsStmts.remove.run(id);
      req?.audit?.({ action: 'news.delete', target: String(id) });
      return { deleted: true };
    },
    normalise(body, user) {
      const starts = sqlDate(body.startsAt);
      const ends = sqlDate(body.endsAt);
      if (starts && ends && ends <= starts) throw unprocessable('The end date must be after the start date', { endsAt: ['must be after startsAt'] });
      const audience = body.audience ?? (isRoot(user) ? 'all' : 'own');
      if (!isRoot(user) && audience !== 'own') throw unprocessable('Resellers publish news to their own accounts only', { audience: ['must be "own"'] });
      return { title: body.title, body: body.body ?? '', audience, severity: body.severity ?? 'info', enabled: body.enabled === false ? 0 : 1, starts_at: starts, ends_at: ends };
    },
    // What a principal's dashboard shows: the server-wide audiences for its
    // role plus `own` items from whoever owns its account (resellers also see
    // the ones they published themselves).
    active(user) {
      const allowed = isRoot(user) ? ['root', 'resellers', 'all'] : user?.role === 'reseller' ? ['resellers', 'all'] : ['all'];
      let ownerId = null;
      if (user?.role === 'reseller') ownerId = user.id;
      else if (user?.role === 'user') ownerId = newsStmts.accountOwner.get(user.username)?.owner_id ?? null;
      return newsStmts.active.all({ now: nowSql() })
        .filter((n) => (n.audience === 'own' ? ownerId != null && n.owner_id === ownerId : allowed.includes(n.audience)))
        .map(shapeNews);
    },
  };

  // ------------------------------------------------------------ mailman ----
  const mailman = {
    async detect() {
      try { return await ctx.agent.op('cpanel.mailman.detect'); } catch (err) { throw agentError(err, 'mailman'); }
    },
    async lists() {
      try {
        const res = await ctx.agent.op('cpanel.mailman.lists');
        return { flavor: res.flavor, lists: res.lists || [], canResetPassword: res.flavor === 'mailman2' };
      } catch (err) { throw agentError(err, 'mailman'); }
    },
    async resetPassword(list, password, req) {
      try {
        const res = await ctx.agent.op('cpanel.mailman.change_pw', { list, password });
        req?.audit?.({ action: 'mailman.password.reset', target: list });
        return res;
      } catch (err) {
        req?.audit?.({ action: 'mailman.password.reset', target: list, result: `error:${err.code || 'failed'}` });
        throw redacted(err, 'mailman');
      }
    },
    async setSitePassword(password, creator, req) {
      try {
        const res = await ctx.agent.op('cpanel.mailman.site_password', { password, creator });
        req?.audit?.({ action: 'mailman.site_password.set', args: { scope: res.scope } });
        return res;
      } catch (err) {
        req?.audit?.({ action: 'mailman.site_password.set', args: { scope: creator ? 'creator' : 'site' }, result: `error:${err.code || 'failed'}` });
        throw redacted(err, 'mailman');
      }
    },
  };

  // ------------------------------------------------------------ upgrade ----
  // Keys live on the host under the agent's control; the panel only relays
  // them. The same op reports the host policy: whether root lets the panel
  // manage keys and whether unverified releases may run at all. Both are root's
  // decisions (agent environment or agent.conf); nothing here can override them.
  const DEFAULT_POLICY = { allowUnverified: false, panelManagedKeys: false, configFile: null };
  const shapePolicy = (p) => ({ allowUnverified: p?.allowUnverified === true, panelManagedKeys: p?.panelManagedKeys === true, configFile: typeof p?.configFile === 'string' ? p.configFile : null });
  // The key listing is an agent round-trip; status polls reuse it briefly, and
  // every change through the panel drops the copy.
  let keysCache = null;
  const readKeys = async () => {
    if (keysCache && keysCache.until > Date.now()) return keysCache.res;
    const res = await ctx.agent.op('cpanel.upgrade.keys');
    keysCache = { res, until: Date.now() + KEYS_CACHE_MS };
    return res;
  };
  const releaseKeys = {
    async list() {
      const res = await readKeys();
      return { dir: res.dir, readOnly: Boolean(res.readOnly), policy: shapePolicy(res.policy), keys: (res.keys || []).map(({ pem, ...k }) => k) };
    },
    async pems() {
      keysCache = null;
      const res = await readKeys();
      return (res.keys || []).filter((k) => k.valid && k.pem);
    },
    async add(kid, pem, req) {
      let key;
      try { key = crypto.createPublicKey(pem); } catch (err) { throw unprocessable('Not a valid public key', { pem: [err.message] }); }
      if (key.asymmetricKeyType !== 'ed25519') throw unprocessable('Release keys must be Ed25519 public keys', { pem: [`got ${key.asymmetricKeyType}`] });
      keysCache = null;
      const added = await ctx.agent.op('cpanel.upgrade.key_add', { kid, pem: key.export({ type: 'spki', format: 'pem' }) });
      req?.audit?.({ action: 'upgrade.key.add', target: kid, args: { fingerprint: added?.fingerprint ?? null } });
      const { pem: _pem, ...rest } = added || {};
      return rest;
    },
    async remove(kid, req) {
      keysCache = null;
      await ctx.agent.op('cpanel.upgrade.key_remove', { kid });
      req?.audit?.({ action: 'upgrade.key.remove', target: kid });
      return { removed: true };
    },
    // Early, non-authoritative check so a tampered download fails before the
    // agent is asked to stage it. Same contract as the agent's verifySignature:
    // kid | null (keys exist, none verifies) | undefined (no usable key at all).
    async verify(digest, signature, keyId) {
      const keys = await releaseKeys.pems();
      if (keys.length === 0) return undefined;
      const sig = Buffer.from(signature, 'base64');
      for (const k of keys.filter((k) => !keyId || k.kid === keyId)) {
        if (crypto.verify(null, digest, crypto.createPublicKey(k.pem), sig)) return k.kid;
      }
      return null;
    },
  };

  const installMethod = () => {
    const sw = ctx.software?.panel?.installMethod;
    if (typeof sw === 'function') return sw();
    if (fs.existsSync(path.join(REPO_ROOT, '.git'))) return 'git';
    if (fs.existsSync(path.join(REPO_ROOT, 'scripts', 'install.sh'))) return 'install-script';
    return 'manual';
  };
  const activeJob = () => ctx.jobs.list({ type: UPGRADE_JOB, limit: 5 }).find((j) => ['queued', 'running'].includes(j.status)) ?? null;
  const tailLog = (file) => {
    try {
      const size = fs.statSync(file).size;
      const fd = fs.openSync(file, 'r');
      try {
        const len = Math.min(size, LOG_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  };
  // The installer prints "==> WHM is running" when done and "error: ..." when it
  // dies; a transient unit that is gone without either is not a success.
  const logOutcome = (log) => (/WHM is running/.test(log || '') ? 'succeeded' : /(^|\n)(\x1b\[[0-9;]*m)?error:/.test(log || '') ? 'failed' : null);
  const unitOutcome = (st, log) => {
    if (!st) return null;
    if (st.installed && st.state === 'failed') return 'failed';
    if (st.installed && st.state === 'inactive') return st.result && st.result !== 'success' ? 'failed' : 'succeeded';
    if (!st.installed) return logOutcome(log) ?? 'unknown';
    return null;
  };
  // Software owns the release feed (Software › System Update checks it and
  // records software.panel.last_check); this reads its answer and, when the
  // feed published them, the verification fields it carried.
  const softwarePanel = () => {
    const sw = ctx.software?.panel;
    if (!sw || typeof sw.status !== 'function') throw new CapabilityError('software', 'The Software category is not available; release checks run there');
    return sw;
  };
  const releaseFromSoftware = () => {
    const st = softwarePanel().status();
    const tier = st.tier ?? S('updates.tier', 'stable');
    let latest = null;
    if (st.latest) { try { latest = parseRelease(st.latest, tier); } catch { latest = null; } }
    return { updateUrl: st.updateUrl ?? '', tier, lastCheck: st.lastCheck ?? null, latest };
  };
  const upgrade = {
    canRun() {
      const method = installMethod();
      if (method === 'git') return { ok: false, reason: `This panel runs from a git checkout (${REPO_ROOT}); upgrade it with git and scripts/install.sh --upgrade instead of a release archive.` };
      if (!fs.existsSync(path.join(REPO_ROOT, 'scripts', 'install.sh'))) return { ok: false, reason: 'scripts/install.sh is missing from this installation; follow the manual steps.' };
      return { ok: true, reason: null };
    },
    // Read-only: the stored record, the release Software last saw, and the
    // (briefly cached) key listing. Post-restart reconciliation is reconcile().
    async status() {
      const { updateUrl, tier, lastCheck, latest } = releaseFromSoftware();
      const last = S('cpanel.upgrade.last', null);
      const method = installMethod();
      const can = upgrade.canRun();
      let keys = { dir: null, readOnly: true, policy: DEFAULT_POLICY, keys: [], error: null };
      try { keys = { ...(await releaseKeys.list()), error: null }; } catch (err) { keys.error = err.message; }
      const trusted = keys.keys.filter((k) => k.valid);
      const lastDetail = last ? { ...last, log: last.logFile ? tailLog(last.logFile) : null } : null;
      let verification = null;
      if (latest) {
        const keyKnown = latest.keyId ? trusted.some((k) => k.kid === latest.keyId) : trusted.length > 0;
        verification = {
          sha256: Boolean(latest.sha256), signature: Boolean(latest.signature), keyId: latest.keyId ?? null,
          trustedKeys: trusted.length, trustedKey: Boolean(latest.signature) && keyKnown,
          // Mirrors the agent's rule: a release is verifiable only with a
          // checksum and a signature from a trusted key. A signature that does
          // not verify is always refused; anything short of verified runs only
          // when the host policy allows unverified upgrades.
          unverifiable: !latest.sha256 || !latest.signature || trusted.length === 0,
          keyMissing: Boolean(latest.signature) && trusted.length > 0 && !keyKnown,
        };
      }
      return {
        currentVersion: ctx.version, updateUrl, updateUrlConfigured: Boolean(updateUrl), tier,
        lastCheck, latest, updateAvailable: latest ? compareVersions(latest.version, ctx.version) > 0 : null,
        installMethod: method, repoRoot: REPO_ROOT, canRun: can.ok, reason: can.reason,
        verification, policy: keys.policy, releaseKeys: keys.keys, releaseKeyDir: keys.dir, releaseKeysReadOnly: keys.readOnly, releaseKeysError: keys.error,
        activeJob: activeJob(), last: lastDetail,
        instructions: [
          method === 'git' ? `cd ${REPO_ROOT} && git fetch --tags && git checkout <release-tag>` : `Download the release archive${latest?.url ? ` from ${latest.url}` : ''} and unpack it (tar -xzf) somewhere root can read`,
          `bash <unpacked>/scripts/install.sh --upgrade   # redeploys to ${method === 'git' ? REPO_ROOT : '/opt/whm'}, keeps /etc/whm and ${dataDir}, restarts whm-agentd and whm-panel`,
          'Verify: Home shows the new version and Server Status › Task Queue Monitor has no failed jobs',
        ],
      };
    },
    // The installer restarts the panel before the job loop can see the result,
    // so a record left at 'started' (or 'unknown') is settled once, at boot: the
    // running version proves success; otherwise the unit's state decides. A
    // unit still active is left alone and settled on the next boot.
    async reconcile() {
      const last = S('cpanel.upgrade.last', null);
      if (!last || !['started', 'unknown'].includes(last.status)) return last;
      let status = last.status;
      let exitStatus = last.exitStatus ?? null;
      if (last.version && compareVersions(ctx.version, last.version) === 0 && last.fromVersion !== ctx.version) status = 'succeeded';
      else if (last.unit && last.status === 'started') {
        try {
          const st = await ctx.agent.op('cpanel.upgrade.unit_status', { unit: last.unit.replace(/\.service$/, '') });
          if (st.installed && st.state === 'active') return last;
          status = unitOutcome(st, last.logFile ? tailLog(last.logFile) : null) ?? 'unknown';
          if (status === 'failed' && st.exitStatus != null) exitStatus = st.exitStatus;
          if (status !== 'succeeded') { try { await ctx.agent.op('cpanel.upgrade.unit_status', { unit: last.unit.replace(/\.service$/, ''), resetFailed: true }); } catch { /* unit already gone */ } }
        } catch (err) {
          // No systemd to ask: nothing will ever settle it. An agent that is
          // merely unreachable right now gets another chance at the next boot.
          if (!['capability_missing', 'binary_not_found', 'unsupported'].includes(err?.code)) return last;
          status = 'unknown';
        }
      }
      if (status === last.status) return last;
      const record = { ...last, status, exitStatus, finishedAt: last.finishedAt ?? new Date().toISOString() };
      settings.set('cpanel.upgrade.last', record);
      logger?.info?.({ version: last.version, status }, 'settled the last panel upgrade');
      return record;
    },
    async check(req) {
      const sw = softwarePanel();
      if (typeof sw.check !== 'function') throw new CapabilityError('software', 'The Software category does not expose a release check');
      if (!S('software.update_url', '')) throw unprocessable('No update URL is configured', { url: ['Set the update URL under Server Configuration › Update Preferences first'] });
      await sw.check(req);
      const { lastCheck, latest } = releaseFromSoftware();
      req?.audit?.({ action: 'upgrade.check', args: { url: lastCheck?.url ?? null, ok: Boolean(lastCheck?.ok), latest: latest?.version ?? null, error: lastCheck?.error ?? null } });
      return upgrade.status();
    },
    async start({ allowUnverified = false, skipNode = false } = {}, user, req) {
      const can = upgrade.canRun();
      if (!can.ok) throw unprocessable(can.reason, { installMethod: [installMethod()] });
      const { latest } = releaseFromSoftware();
      if (!latest) throw unprocessable('Check for updates first', { latest: ['no release known'] });
      if (!latest.url) throw unprocessable('The release feed did not publish a download URL', { url: ['missing'] });
      if (compareVersions(latest.version, ctx.version) <= 0) throw conflict(`Version ${latest.version} is not newer than the running ${ctx.version}`);
      // Early, non-authoritative: the agent re-derives all of this from its
      // own policy and keys. allowUnverified is only the operator's
      // acknowledgement; it is never sent to the agent.
      keysCache = null;
      const { verification, policy } = await upgrade.status();
      if (verification?.keyMissing) throw unprocessable(`The feed's signature names key "${latest.keyId}", which is not trusted on this host; a signature that does not verify is always refused`, { keyId: ['not trusted'] });
      if (verification?.unverifiable) {
        if (!policy.allowUnverified) throw unprocessable('This release cannot be verified (it needs a SHA-256 checksum and a signature from a key trusted on the host) and the host policy refuses unverified upgrades', { policy: ['set upgrade.allowUnverified in the agent configuration or WHM_UPGRADE_ALLOW_UNVERIFIED=1 in the whm-agentd unit'] });
        if (!allowUnverified) throw unprocessable('This release cannot be verified; the host policy permits it but you must acknowledge an unverified upgrade explicitly', { allowUnverified: ['required'] });
      }
      if (activeJob()) throw conflict('An upgrade is already queued or running');
      const job = ctx.jobs.enqueue(UPGRADE_JOB, { version: latest.version, url: latest.url, sha256: latest.sha256, signature: latest.signature, keyId: latest.keyId, allowUnverified: Boolean(allowUnverified), skipNode: Boolean(skipNode), by: user?.username ?? null }, { userId: user?.id ?? null });
      req?.audit?.({ action: 'upgrade.start', target: latest.version, args: { jobId: job.id, url: latest.url, sha256: latest.sha256, allowUnverified: Boolean(allowUnverified) } });
      return { job };
    },
    log() {
      const last = S('cpanel.upgrade.last', null);
      if (!last?.logFile) throw notFound('Upgrade log');
      return { logFile: last.logFile, log: tailLog(last.logFile) ?? '', unit: last.unit, version: last.version, startedAt: last.startedAt };
    },
    // Job handler: download → early checks → agent copies, verifies and unpacks
    // in its own staging area → agent runs the installer detached → follow its log.
    async run(job) {
      const { version, url, sha256, signature, keyId, allowUnverified, skipNode } = job.params;
      fs.mkdirSync(dirs.upgrades, { recursive: true, mode: 0o750 });
      const archive = path.join(dirs.upgrades, `whm-${version}.tar.gz`);
      const part = `${archive}.part`;
      // The archive only exists on disk between a complete download and the
      // agent taking its private copy; nothing partial or stale is left behind.
      const discard = () => { fs.rmSync(part, { force: true }); fs.rmSync(archive, { force: true }); };
      discard();
      job.log(`Downloading ${url}`);
      job.progress(2, 'downloading');
      const res = await fetch(url, { headers: { 'User-Agent': `whm-panel/${ctx.version}`, Accept: 'application/gzip, application/octet-stream' }, signal: AbortSignal.timeout(15 * 60 * 1000), redirect: 'follow' });
      if (!res.ok || !res.body) throw Object.assign(new Error(`download failed: HTTP ${res.status}`), { code: 'DOWNLOAD_FAILED' });
      const total = Number(res.headers.get('content-length')) || null;
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastPct = 2;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          if (received > MAX_ARCHIVE_BYTES) return cb(Object.assign(new Error(`archive exceeds ${MAX_ARCHIVE_BYTES} bytes`), { code: 'TOO_LARGE' }));
          hash.update(chunk);
          if (total) { const pct = 2 + Math.round((received / total) * 38); if (pct !== lastPct) { lastPct = pct; job.progress(pct, `downloading ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`); } }
          cb(null, chunk);
        },
      });
      try {
        // pipeline() owns every stream: on any failure the file handle is
        // destroyed before the partial file is removed.
        await pipeline(res.body, meter, fs.createWriteStream(part, { mode: 0o644 }));
        fs.renameSync(part, archive);
      } catch (err) {
        discard();
        if (!err.code || err.code === 'ABORT_ERR' || err.name === 'TimeoutError') err.code = 'DOWNLOAD_FAILED';
        throw err;
      }
      const digest = hash.digest();
      const digestHex = digest.toString('hex');
      job.log(`Downloaded ${received} bytes, sha256 ${digestHex}`);
      let unpacked;
      try {
        // Early failures only; the agent repeats every check on its own copy
        // and applies the host policy to whatever cannot be verified.
        if (sha256) {
          if (digestHex !== sha256) throw Object.assign(new Error(`SHA-256 mismatch: feed says ${sha256}, archive is ${digestHex}`), { code: 'CHECKSUM_MISMATCH' });
          job.log('SHA-256 checksum matches the feed');
        } else job.log(`No checksum published for this release${allowUnverified ? '; unverified upgrade acknowledged by the operator' : ''}`, 'warn');
        if (signature) {
          const signer = await releaseKeys.verify(digest, signature, keyId);
          if (signer === null) throw Object.assign(new Error(`The release signature does not verify against any trusted key${keyId ? ` (feed names "${keyId}")` : ''}`), { code: 'SIGNATURE_INVALID' });
          if (signer === undefined) job.log('Signature cannot be checked here: no trusted release key is installed on the host', 'warn');
          else job.log(`Signature matches trusted key "${signer}"`);
        } else job.log('No signature published for this release', 'warn');
        job.progress(45, 'verifying and unpacking');
        try {
          unpacked = await ctx.agent.op('cpanel.upgrade.extract', { archive, version, sha256: sha256 ?? null, signature: signature ?? null, keyId: keyId ?? null }, { timeoutMs: 10 * 60 * 1000 });
        } catch (err) {
          const code = { checksum_mismatch: 'CHECKSUM_MISMATCH', invalid_signature: 'SIGNATURE_INVALID', unverified: 'UNVERIFIED', unsigned: 'UNSIGNED', invalid_package: 'INVALID_PACKAGE', refused: 'STAGING_REFUSED', path_not_allowed: 'STAGING_REFUSED' }[err?.code] ?? 'STAGING_FAILED';
          throw Object.assign(new Error(`The agent refused to stage the release: ${err.message}`), { code });
        }
      } finally {
        discard();
      }
      for (const w of unpacked.warnings || []) job.log(w, 'warn');
      job.log(`Agent verified sha256 ${unpacked.sha256}${unpacked.signer ? ` and signature (key "${unpacked.signer}")` : ''}; unpacked ${unpacked.name ?? 'release'} ${unpacked.packageVersion ?? ''} into ${unpacked.sourceDir}`);
      if (unpacked.packageVersion && compareVersions(unpacked.packageVersion, version) !== 0) job.log(`Archive package.json says ${unpacked.packageVersion}, feed said ${version}`, 'warn');
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      const unit = `whm-upgrade-${stamp}`;
      job.progress(50, 'running installer');
      const started = await ctx.agent.op('cpanel.upgrade.run', { version, unit, skipNode: Boolean(skipNode) });
      const logFile = started.logFile;
      const record = { version, fromVersion: ctx.version, startedAt: new Date().toISOString(), unit: `${unit}.service`, logFile, sourceDir: started.sourceDir, sha256: unpacked.sha256, signer: unpacked.signer ?? null, jobId: job.job.id, status: 'started', by: job.params.by ?? null };
      settings.set('cpanel.upgrade.last', record);
      job.log(`Installer started as ${started.unit}; output in ${logFile}. The panel restarts when it finishes, which ends this log stream.`);
      const deadline = Date.now() + UPGRADE_TIMEOUT_MS;
      let offset = 0;
      let outcome = null;
      let exitStatus = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        try {
          const size = fs.statSync(logFile).size;
          if (size > offset) {
            const fd = fs.openSync(logFile, 'r');
            try {
              const buf = Buffer.alloc(size - offset);
              fs.readSync(fd, buf, 0, buf.length, offset);
              offset = size;
              for (const line of buf.toString('utf8').split('\n')) if (line.trim()) job.log(line.replace(/\x1b\[[0-9;]*m/g, ''));
            } finally { fs.closeSync(fd); }
          }
        } catch { /* log not readable yet */ }
        let st = null;
        try { st = await ctx.agent.op('cpanel.upgrade.unit_status', { unit }); } catch { st = null; }
        outcome = unitOutcome(st, tailLog(logFile));
        if (outcome) { exitStatus = st?.exitStatus ?? null; break; }
      }
      if (!outcome) throw Object.assign(new Error(`The installer did not finish within ${UPGRADE_TIMEOUT_MS / 60000} minutes; see ${logFile}`), { code: 'UPGRADE_TIMEOUT' });
      settings.set('cpanel.upgrade.last', { ...record, status: outcome, exitStatus, finishedAt: new Date().toISOString() });
      if (outcome !== 'succeeded') {
        try { await ctx.agent.op('cpanel.upgrade.unit_status', { unit, resetFailed: true }); } catch { /* unit already gone */ }
      }
      if (outcome === 'failed') throw Object.assign(new Error(`The installer failed${exitStatus != null ? ` (exit status ${exitStatus})` : ''}; see ${logFile}`), { code: 'UPGRADE_FAILED' });
      if (outcome === 'unknown') throw Object.assign(new Error(`The installer unit disappeared before reporting a result; check ${logFile} and the running version`), { code: 'UPGRADE_UNKNOWN' });
      job.progress(100, 'done');
      return { version, unit: started.unit, logFile };
    },
  };

  return { changelog, branding, news, mailman, upgrade, releaseKeys, dirs, repoRoot: REPO_ROOT };
}
