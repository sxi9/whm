import crypto from 'node:crypto';
import nodePath from 'node:path';
import { z } from 'zod';
import { HttpError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

// The .htaccess family of the account panel: IP blocker, directory privacy,
// indexes and custom error pages share one managed block per directory, so
// every write here is read → patch the structured spec → files.htaccess.set
// (host first; nothing is stored in SQLite). Directories are client paths
// relative to the home, resolved the way the file manager does and pinned
// under one of the account's document roots; the agent pins them again under
// public_html and runs every command as the account.
//
//   panelHtaccess.ipBlocker.get / add / remove            (feature ipblocker)
//   panelHtaccess.indexes.get / set                       (feature indexmanager)
//   panelHtaccess.privacy.get / set / addUser / removeUser (feature dirprivacy)
//   panelHtaccess.errorPages.list / set / remove           (feature errpgs)
//   panelHtaccess.optimize.get / set                      (feature optimizews)
//   panelHtaccess.hotlink.get / set                       (feature hotlink)
//   panelHtaccess.probe(scope, { path })

// Home directories and document roots are Linux paths whatever platform runs the tests.
const path = nodePath.posix;

export const WEB_TYPES = ['main', 'addon', 'sub'];
export const ERROR_CODES = ['400', '401', '403', '404', '500', '503'];
export const REALM = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/;
export const HTPASSWD_USER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
export const MAX_DENY_IPS = 500;
export const MAX_PRIVACY_USERS = 200;
export const DEFAULT_REALM = 'Restricted area';
// Mirrors agent/src/ops/htaccess-web.js (the agent refuses anything else).
export const DEFLATE_TYPES = [
  'text/html', 'text/plain', 'text/xml', 'text/css', 'text/javascript',
  'application/javascript', 'application/x-javascript', 'application/json', 'application/xml',
  'application/rss+xml', 'application/atom+xml', 'application/xhtml+xml', 'image/svg+xml',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/vnd.ms-fontobject',
];
export const HOTLINK_EXTENSIONS = [
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff',
  'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'pdf', 'zip', 'rar', '7z',
];
export const DEFAULT_HOTLINK_EXTENSIONS = ['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp'];
export const MAX_HOTLINK_HOSTS = 100;
export const HOTLINK_REDIRECT = /^https?:\/\/(?=.{1,2000}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!*'(),:@&=+;/-]*)?(?:\?[A-Za-z0-9._~!*'(),:@&=+;/-]*)?$/;
export const OPTIMIZE_MODES = ['off', 'all', 'custom'];
// A hostname without a leading "www." (the rule allows both forms of every host).
export const bareHost = (h) => String(h).trim().toLowerCase().replace(/^www\./, '');
export function redirectLoops(redirect, extensions) {
  let pathname;
  try { pathname = new URL(redirect).pathname.toLowerCase(); } catch { return true; }
  return extensions.some((e) => pathname.endsWith(`.${e}`));
}
const REL = /^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]*$/;
const REL_MESSAGE = 'A path relative to the home directory: not absolute, without ".." and not starting with "-"';
export const dirPath = z.string().max(512).regex(REL, REL_MESSAGE).default('');

export function parseCidr(s) {
  const m = String(s).match(/^([^/]+)(?:\/(\d{1,3}))?$/);
  if (!m || m[1].includes('%')) return null;
  const v4 = z.ipv4().safeParse(m[1]).success;
  const v6 = !v4 && z.ipv6().safeParse(m[1]).success;
  if (!v4 && !v6) return null;
  if (m[2] != null && Number(m[2]) > (v4 ? 32 : 128)) return null;
  return { ip: m[1], bits: m[2] == null ? null : Number(m[2]), family: v4 ? 4 : 6 };
}
export const ipOrCidr = z.string().trim().max(64).refine((s) => parseCidr(s) !== null, 'An IPv4/IPv6 address or CIDR range such as 203.0.113.0/24');

// Apache's APR validates "$2y$" bcrypt; bcryptjs emits "$2a$" for the same
// algorithm, so the prefix is rewritten (htpasswd -B writes $2y$ itself).
export const toApacheBcrypt = (hash) => String(hash).replace(/^\$2[ab]\$/, '$2y$');

// One password file per protected directory, named after the directory so a
// directory keeps its users across protect/unprotect.
export const htpasswdId = (rel) => crypto.createHash('sha256').update(rel).digest('hex').slice(0, 16);

export function createPanelHtaccessService(ctx) {
  const agent = () => ctx.agent;
  const domains = () => { if (!ctx.panelDomains) throw new HttpError(503, 'service_unavailable', 'The panel domains service is not loaded'); return ctx.panelDomains; };
  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args) };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const op = (name, args, req) => agent().op(name, args, { req });

  function requireScopeShape(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
  }
  function home(scope) {
    const dir = scope.account?.home_dir;
    if (!dir || !path.isAbsolute(dir)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
    return path.resolve(dir);
  }
  function webDomains(scope) {
    return domains().allDomains(scope).filter((r) => WEB_TYPES.includes(r.type) && r.docroot).map((r) => ({ domain: r.domain, type: r.type, docroot: path.resolve(r.docroot) }));
  }

  // A client path pinned under the home and under the document root that
  // contains it (the deepest one, which is the domain the directory is
  // served as). The main docroot is public_html itself.
  function resolveDir(scope, rel) {
    const base = home(scope);
    const clean = String(rel ?? '');
    if (clean && !REL.test(clean)) throw unprocessable('Request validation failed', { path: [REL_MESSAGE] });
    const abs = path.resolve(base, clean);
    if (abs !== base && !abs.startsWith(`${base}/`)) throw unprocessable('Request validation failed', { path: ['Path is outside the home directory'] });
    const roots = webDomains(scope).filter((d) => abs === d.docroot || abs.startsWith(`${d.docroot}/`)).sort((a, b) => b.docroot.length - a.docroot.length);
    if (!roots.length) throw unprocessable('Request validation failed', { path: ['The folder must be inside one of your document roots (public_html or an addon/subdomain folder)'] });
    const site = roots[0];
    const under = path.relative(site.docroot, abs);
    return { home: base, abs, rel: path.relative(base, abs) || '.', docroot: site.docroot, domain: site.domain, type: site.type, urlPath: under ? `/${under.split(/[\\/]/).map(encodeURIComponent).join('/')}/` : '/' };
  }

  function probeFor(dir) {
    const tls = typeof ctx.ssl?.certForDomain === 'function' && ctx.ssl.certForDomain(dir.domain)?.state === 'installed';
    return { url: `${tls ? 'https' : 'http'}://${dir.domain}${dir.urlPath}` };
  }

  async function webGroup(req) {
    try { return (await op('web.detect', {}, req))?.apache?.runUser || null; } catch { return null; }
  }

  const emptySpec = () => ({ denyIps: [], errorDocuments: {}, indexes: 'inherit', auth: null, deflate: null, hotlink: null });
  const isEmpty = (spec) => !spec.denyIps.length && !Object.keys(spec.errorDocuments).length && spec.indexes === 'inherit' && !spec.auth && !spec.deflate && !spec.hotlink;

  async function read(scope, dir, req) {
    const r = await op('files.htaccess.get', { username: scope.username, path: dir.abs }, req);
    return { ...r, spec: { ...emptySpec(), ...(r.spec ?? {}) } };
  }

  // Host first: the patched spec is written with a loopback probe so a block
  // that makes Apache answer 500 is rolled back by the agent before this
  // returns (422 config_invalid with the probe result).
  async function write(scope, dir, spec, req) {
    const block = isEmpty(spec) ? null : spec;
    return op('files.htaccess.set', { username: scope.username, path: dir.abs, block, probe: probeFor(dir) }, req);
  }

  async function patch(scope, dir, fn, req) {
    const current = await read(scope, dir, req);
    const next = fn({ ...current.spec, denyIps: [...current.spec.denyIps], errorDocuments: { ...current.spec.errorDocuments } }, current);
    const r = await write(scope, dir, next, req);
    return { spec: next, result: r, before: current };
  }

  const shapeProbe = (p) => (p ? { status: p.status ?? null, error: p.error ?? null } : null);

  const service = {
    dirPath,
    resolveDir,
    constants: { OPTIMIZE_MODES, DEFLATE_TYPES, HOTLINK_EXTENSIONS, DEFAULT_HOTLINK_EXTENSIONS, MAX_HOTLINK_HOSTS, HOTLINK_REDIRECT },

    async get(scope, { path: rel = '' } = {}, req) {
      requireScopeShape(scope);
      const dir = resolveDir(scope, rel);
      const r = await read(scope, dir, req);
      return { path: dir.rel, domain: dir.domain, docroot: path.relative(dir.home, dir.docroot) || '.', exists: r.exists, managed: r.managed, foreign: r.foreign ?? 0, spec: r.spec };
    },

    async probe(scope, { path: rel = '' } = {}, req) {
      requireScopeShape(scope);
      const dir = resolveDir(scope, rel);
      const { url } = probeFor(dir);
      const r = await op('files.htaccess.probe', { username: scope.username, url }, req);
      return { path: dir.rel, url, ...shapeProbe(r) };
    },

    ipBlocker: {
      async get(scope, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'ipblocker');
        const dir = resolveDir(scope, 'public_html');
        const r = await read(scope, dir, req);
        return { path: dir.rel, domain: dir.domain, denyIps: r.spec.denyIps, max: MAX_DENY_IPS };
      },
      async add(scope, { ip }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'ipblocker');
        const dir = resolveDir(scope, 'public_html');
        const entry = String(ip).trim();
        const { spec, result } = await patch(scope, dir, (s) => {
          if (s.denyIps.includes(entry)) throw conflict(`${entry} is already blocked`);
          if (s.denyIps.length >= MAX_DENY_IPS) throw conflict(`At most ${MAX_DENY_IPS} addresses or ranges can be blocked`);
          s.denyIps.push(entry);
          return s;
        }, req);
        audit(req, scope, 'panel.ipblocker.add', { ip: entry, path: dir.rel, count: spec.denyIps.length });
        return { ip: entry, denyIps: spec.denyIps, probe: shapeProbe(result.probe) };
      },
      async remove(scope, { ip }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'ipblocker');
        const dir = resolveDir(scope, 'public_html');
        const entry = String(ip).trim();
        const { spec, result } = await patch(scope, dir, (s) => {
          if (!s.denyIps.includes(entry)) throw notFound(`Blocked address ${entry}`);
          s.denyIps = s.denyIps.filter((x) => x !== entry);
          return s;
        }, req);
        audit(req, scope, 'panel.ipblocker.remove', { ip: entry, path: dir.rel, count: spec.denyIps.length });
        return { ip: entry, removed: true, denyIps: spec.denyIps, probe: shapeProbe(result.probe) };
      },
    },

    indexes: {
      async get(scope, { path: rel = '' } = {}, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'indexmanager');
        const dir = resolveDir(scope, rel || 'public_html');
        const r = await read(scope, dir, req);
        return { path: dir.rel, domain: dir.domain, indexes: r.spec.indexes, managed: r.managed };
      },
      async set(scope, { path: rel, indexes }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'indexmanager');
        const dir = resolveDir(scope, rel || 'public_html');
        const { result } = await patch(scope, dir, (s) => ({ ...s, indexes }), req);
        audit(req, scope, 'panel.indexes.set', { path: dir.rel, indexes });
        return { path: dir.rel, indexes, probe: shapeProbe(result.probe) };
      },
    },

    privacy: {
      async get(scope, { path: rel = '' } = {}, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'dirprivacy');
        const dir = resolveDir(scope, rel || 'public_html');
        const r = await read(scope, dir, req);
        const id = htpasswdId(dir.rel);
        const users = await op('files.htpasswd.get', { username: scope.username, id }, req);
        return { path: dir.rel, domain: dir.domain, protected: Boolean(r.spec.auth), realm: r.spec.auth?.realm ?? DEFAULT_REALM, users: users.entries.map((e) => e.user), max: MAX_PRIVACY_USERS, managed: r.managed };
      },
      async set(scope, { path: rel, enabled, realm }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'dirprivacy');
        const dir = resolveDir(scope, rel || 'public_html');
        const id = htpasswdId(dir.rel);
        const userFile = `${dir.home}/.keel/htpasswd/${id}`;
        // Apache answers 500 for a missing AuthUserFile, so the file exists
        // (possibly empty) before the block names it.
        if (enabled) {
          const existing = await op('files.htpasswd.get', { username: scope.username, id }, req);
          if (!existing.exists) await op('files.htpasswd.set', { username: scope.username, id, entries: [], ...(await groupArg(req)) }, req);
        }
        const { spec, result } = await patch(scope, dir, (s) => ({ ...s, auth: enabled ? { realm: realm ?? s.auth?.realm ?? DEFAULT_REALM, userFile } : null }), req);
        audit(req, scope, 'panel.dirprivacy.set', { path: dir.rel, enabled, realm: spec.auth?.realm ?? null });
        return { path: dir.rel, protected: Boolean(spec.auth), realm: spec.auth?.realm ?? realm ?? DEFAULT_REALM, probe: shapeProbe(result.probe) };
      },
      async addUser(scope, { path: rel, user, password }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'dirprivacy');
        const dir = resolveDir(scope, rel || 'public_html');
        const id = htpasswdId(dir.rel);
        const existing = await op('files.htpasswd.get', { username: scope.username, id }, req);
        const entries = existing.entries.filter((e) => e.user !== user);
        if (!existing.entries.some((e) => e.user === user) && entries.length >= MAX_PRIVACY_USERS) throw conflict(`At most ${MAX_PRIVACY_USERS} users per protected folder`);
        const hash = toApacheBcrypt(await ctx.crypto.hashPassword(password));
        entries.push({ user, hash });
        const r = await op('files.htpasswd.set', { username: scope.username, id, entries, ...(await groupArg(req)) }, req);
        audit(req, scope, 'panel.dirprivacy.user.add', { path: dir.rel, user, replaced: existing.entries.some((e) => e.user === user) });
        return { path: dir.rel, user, users: r.users, replaced: existing.entries.some((e) => e.user === user) };
      },
      async removeUser(scope, { path: rel, user }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'dirprivacy');
        const dir = resolveDir(scope, rel || 'public_html');
        const id = htpasswdId(dir.rel);
        const existing = await op('files.htpasswd.get', { username: scope.username, id }, req);
        if (!existing.entries.some((e) => e.user === user)) throw notFound(`User ${user}`);
        const r = await op('files.htpasswd.set', { username: scope.username, id, entries: existing.entries.filter((e) => e.user !== user), ...(await groupArg(req)) }, req);
        audit(req, scope, 'panel.dirprivacy.user.remove', { path: dir.rel, user });
        return { path: dir.rel, user, removed: true, users: r.users };
      },
    },

    errorPages: {
      async list(scope, { domain }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'errpgs');
        const site = siteOf(scope, domain);
        const dir = resolveDir(scope, path.relative(site.home, site.docroot));
        const [block, files] = await Promise.all([read(scope, dir, req), op('files.errorpages.list', { username: scope.username, docroot: dir.abs }, req)]);
        const pages = ERROR_CODES.map((code) => {
          const f = files.pages.find((p) => p.code === code) ?? { exists: false, managed: false, title: '', message: '', size: 0 };
          return { code, label: LABELS[code], exists: f.exists, managed: f.managed, title: f.title, message: f.message, size: f.size, active: block.spec.errorDocuments[code] === `/errors/${code}.html`, url: `/errors/${code}.html` };
        });
        return { domain: dir.domain, docroot: dir.rel, pages };
      },
      async set(scope, { domain, code, title, message }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'errpgs');
        const site = siteOf(scope, domain);
        const dir = resolveDir(scope, path.relative(site.home, site.docroot));
        const file = await op('files.errorpages.write', { username: scope.username, docroot: dir.abs, code, title, message }, req);
        const { result } = await patch(scope, dir, (s) => ({ ...s, errorDocuments: { ...s.errorDocuments, [code]: file.url } }), req);
        audit(req, scope, 'panel.errorpages.set', { domain: dir.domain, code, path: file.rel });
        return { domain: dir.domain, code, path: file.rel, url: file.url, active: true, probe: shapeProbe(result.probe) };
      },
      async remove(scope, { domain, code, deleteFile = true }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'errpgs');
        const site = siteOf(scope, domain);
        const dir = resolveDir(scope, path.relative(site.home, site.docroot));
        const { result, before } = await patch(scope, dir, (s) => { const docs = { ...s.errorDocuments }; delete docs[code]; return { ...s, errorDocuments: docs }; }, req);
        let deleted = false;
        if (deleteFile) {
          const file = `${dir.abs}/errors/${code}.html`;
          try { await op('files.remove', { username: scope.username, paths: [file] }, req); deleted = true; } catch (err) { if (!(err?.agentError && err.code === 'not_found')) throw err; }
        }
        audit(req, scope, 'panel.errorpages.remove', { domain: dir.domain, code, deleteFile, wasActive: Boolean(before.spec.errorDocuments[code]) });
        return { domain: dir.domain, code, active: false, deleted, probe: shapeProbe(result.probe) };
      },
    },

    // Optimize website (feature optimizews): mod_deflate for a pinned MIME
    // list in the managed block of one folder (public_html by default).
    optimize: {
      async get(scope, { path: rel = '' } = {}, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'optimizews');
        const dir = resolveDir(scope, rel || 'public_html');
        const r = await read(scope, dir, req);
        return { path: dir.rel, domain: dir.domain, ...optimizeOf(r.spec), available: DEFLATE_TYPES, managed: r.managed };
      },
      async set(scope, { path: rel, mode, types = [] }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'optimizews');
        const dir = resolveDir(scope, rel || 'public_html');
        const chosen = mode === 'all' ? DEFLATE_TYPES : mode === 'custom' ? DEFLATE_TYPES.filter((t) => types.includes(t)) : [];
        if (mode === 'custom' && !chosen.length) throw unprocessable('Request validation failed', { types: ['Choose at least one content type to compress'] });
        const deflate = chosen.length ? { types: chosen } : null;
        const { result } = await patch(scope, dir, (s) => ({ ...s, deflate }), req);
        audit(req, scope, 'panel.optimize.set', { path: dir.rel, mode, types: chosen.length });
        return { path: dir.rel, domain: dir.domain, ...optimizeOf({ deflate }), probe: shapeProbe(result.probe) };
      },
    },

    // Hotlink protection (feature hotlink): referer rules in public_html, so
    // every site of the account (addon and subdomain folders inherit the file)
    // is covered. The account's own domains are always allowed; `hosts` are
    // the extra ones the customer adds.
    hotlink: {
      async get(scope, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'hotlink');
        const dir = resolveDir(scope, 'public_html');
        const r = await read(scope, dir, req);
        const own = ownHosts(scope);
        return { path: dir.rel, domain: dir.domain, ...hotlinkOf(r.spec, own), domains: own, available: HOTLINK_EXTENSIONS, defaults: DEFAULT_HOTLINK_EXTENSIONS, max: MAX_HOTLINK_HOSTS, managed: r.managed };
      },
      async set(scope, { enabled, hosts = [], extensions = DEFAULT_HOTLINK_EXTENSIONS, allowBlank = true, redirect = null }, req) {
        requireScopeShape(scope);
        assertFeature(scope, 'hotlink');
        const dir = resolveDir(scope, 'public_html');
        const own = ownHosts(scope);
        const extra = [...new Set(hosts.map(bareHost))].filter((h) => !own.includes(h));
        const all = [...own, ...extra];
        if (all.length > MAX_HOTLINK_HOSTS) throw unprocessable('Request validation failed', { hosts: [`At most ${MAX_HOTLINK_HOSTS} hosts including your own domains`] });
        const exts = HOTLINK_EXTENSIONS.filter((e) => extensions.includes(e));
        if (enabled && !exts.length) throw unprocessable('Request validation failed', { extensions: ['Choose at least one file type to protect'] });
        if (enabled && redirect && redirectLoops(redirect, exts)) throw unprocessable('Request validation failed', { redirect: ['The redirect target must not be one of the protected file types'] });
        const hotlink = enabled ? { hosts: all, extensions: exts, allowBlank: Boolean(allowBlank), redirect: redirect || null } : null;
        const { result } = await patch(scope, dir, (s) => ({ ...s, hotlink }), req);
        audit(req, scope, 'panel.hotlink.set', { enabled, hosts: all.length, extensions: exts.length, allowBlank: Boolean(allowBlank), redirect: hotlink?.redirect ?? null });
        return { path: dir.rel, domain: dir.domain, ...hotlinkOf({ hotlink }, own), domains: own, probe: shapeProbe(result.probe) };
      },
    },
  };

  function optimizeOf(spec) {
    const types = spec.deflate?.types ?? [];
    const mode = !types.length ? 'off' : DEFLATE_TYPES.every((t) => types.includes(t)) ? 'all' : 'custom';
    return { mode, types };
  }
  function hotlinkOf(spec, own) {
    const h = spec.hotlink;
    if (!h) return { enabled: false, hosts: [], extensions: DEFAULT_HOTLINK_EXTENSIONS, allowBlank: true, redirect: null };
    return { enabled: true, hosts: h.hosts.filter((x) => !own.includes(x)), extensions: h.extensions, allowBlank: h.allowBlank, redirect: h.redirect };
  }
  // Every hostname of the account (main, addon, sub, parked), without "www.".
  function ownHosts(scope) {
    const main = bareHost(scope.account.domain);
    const rest = domains().allDomains(scope).map((r) => bareHost(r.domain)).filter((h) => h !== main).sort();
    return [...new Set([main, ...rest])];
  }

  function siteOf(scope, domain) {
    const site = webDomains(scope).find((d) => d.domain === domain);
    if (!site) throw notFound(`Domain "${domain}"`);
    return { ...site, home: home(scope) };
  }
  async function groupArg(req) {
    const group = await webGroup(req);
    return group ? { group } : {};
  }

  return service;
}

export const LABELS = { 400: 'Bad request', 401: 'Authorisation required', 403: 'Forbidden', 404: 'Not found', 500: 'Internal server error', 503: 'Service unavailable' };
