import { notFound, conflict, forbidden, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// Account Functions. Attached as ctx.accountFunctions; other categories may call:
//   accountFunctions.renderTemplate(name, vars)        -> HTML of a site/error page template ('index' | 'landing' | 'suspended' | 'moved' | 'error-4xx');
//                                                        branding ({{company_name}} {{tagline}} {{logo_url}} {{panel_url}}) is filled in from cPanel › Customization
//   accountFunctions.templatePath(name)                -> /etc/whm/templates/<name>.html, the file a vhost may reference (ErrorDocument, suspended docroot)
//   accountFunctions.TEMPLATE_USAGE                     -> which templates are served today; a category that starts serving one updates its entry
//   accountFunctions.changeIp(username, { ip }, user, req)
//   accountFunctions.setBandwidthLimit / resetBandwidth / unsuspendExceeders
//   accountFunctions.setShell / setQuota / setDemoMode / forcePasswordChange
//   accountFunctions.logRetention.get(username) / logs.list(username, kind, user)
//   accountFunctions.mountpointFor(dir)                -> the filesystem a quota for files under dir must be set on
// Accounts themselves (create/suspend/modify/terminate) stay on ctx.accounts.

export const DOMLOGS_ROOT = '/var/log/whm/domlogs';
export const NGINX_LOG_DIR = '/var/log/nginx';
// Partitions an account home may live on; each is an allowed root of the agent.
export const HOME_ROOTS = ['/home', '/home2', '/home3', '/home4', '/mnt/home', '/srv/home'];
export const TEMPLATE_NAMES = ['index', 'landing', 'suspended', 'moved', 'error-4xx'];
export const TEMPLATE_DIR = '/etc/whm/templates';
export const TEMPLATE_VARS = ['domain', 'username', 'hostname', 'contact_email', 'ip', 'status', 'status_text', 'reason', 'company_name', 'tagline', 'logo_url', 'panel_url'];
export const DEFAULT_COMPANY_NAME = 'Hostingsignal Panel';
// cPanel › Customization seeds the admin side's own name (migration 028); the
// pages visitors see carry the product name unless the operator typed theirs.
const ADMIN_BRANDING_DEFAULTS = { company_name: 'WHM', tagline: 'WebHost Manager' };
// Which part of the panel serves each template today. "index" is written into
// public_html by account creation and "landing" into the hostname's docroot by
// Service Configuration; the other three are kept under TEMPLATE_DIR for the
// web server configuration to reference once it does.
export const TEMPLATE_USAGE = {
  index: { served: true, by: 'account creation: rendered into public_html/index.html of every new account' },
  landing: { served: true, by: 'Service Configuration: rendered into /var/www/whm-default/index.html, the document root of the server hostname\'s own virtual host (re-rendered when this template is saved, at boot and on every hostname change)' },
  suspended: { served: false, by: 'not yet served: account suspension calls ctx.web.setSuspended(username, true, req) when Service Configuration provides it; until then the page is only written to the template directory and the Linux account lock is what stops logins' },
  moved: { served: false, by: 'not yet served: no virtual host references this page yet; it is only written to the template directory' },
  'error-4xx': { served: false, by: 'not yet served: the virtual host renderer does not set ErrorDocument to this page yet; it is only written to the template directory' },
};
export const SHELLS = ['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell'];
const LOG_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}(\.log|\.log\.\d+|\.gz|\.\d+|-access_log|-error_log|_log)$/;
const BANDWIDTH_REASON = /^bandwidth\b/i;
// Server-wide log directories hold every tenant's files, so a domain only
// claims "<domain>-access.log", "<domain>.error.log.1" and the like: the whole
// domain, then a separator, then the stream name. Substring matches would let
// "le.com" see "example.com" and "access.log" see the shared access.log.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const domainLogFile = (domain) => new RegExp(`^${escapeRegExp(domain)}[._-](access|error|ssl_access|ssl_error|bytes)(?![A-Za-z0-9])`, 'i');

const page = (title, body, bg = '#f4f6f8') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:${bg};color:#1f2a37}main{text-align:center;max-width:520px}h1{font-weight:600}</style></head>
<body><main>${body}</main></body></html>
`;
// The two pages every visitor can meet before a site has content: branded with
// the company name, tagline and logo from cPanel › Customization (an empty
// {{logo_url}} renders nothing, per the HTML spec for an empty img src).
const brandedPage = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(160deg,#f6f8fb 0%,#e9eef6 100%);color:#17202b}
main{width:min(640px,calc(100% - 32px));background:#fff;border:1px solid #dfe5ee;border-radius:14px;padding:40px 36px;box-shadow:0 18px 50px rgba(23,32,43,.08)}
header{display:flex;align-items:center;gap:12px;font-weight:600;letter-spacing:.01em;color:#2b3a4e}
header img{max-height:40px;max-width:160px}
.eyebrow{margin:28px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#5b6b80}
h1{margin:0;font-size:38px;font-weight:700;line-height:1.1}
.domain{margin:10px 0 22px;font-size:20px;color:#2563eb;word-break:break-all}
p{line-height:1.55;margin:0 0 12px}
code{background:#f1f4f8;border-radius:5px;padding:2px 6px;font-size:.95em}
.button{display:inline-block;margin-top:6px;padding:10px 18px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600}
footer{margin-top:30px;padding-top:16px;border-top:1px solid #e6ebf2;font-size:13px;color:#6b7a90}
</style></head>
<body><main>
<header><img src="{{logo_url}}" alt=""><span>{{company_name}}</span></header>
${body}
<footer>Hosted on {{hostname}} with {{company_name}}. {{tagline}}</footer>
</main></body></html>
`;
export const DEFAULT_TEMPLATES = {
  index: brandedPage('{{domain}} — Ready to launch', '<p class="eyebrow">New website</p><h1>Ready to launch</h1><p class="domain">{{domain}}</p><p>This site is hosted and waiting for its first files. Upload your website to <code>public_html</code>; this page is replaced as soon as an <code>index.html</code> or <code>index.php</code> is there.</p>'),
  landing: brandedPage('{{company_name}} — {{domain}}', '<p class="eyebrow">Server hostname</p><h1>Ready to launch</h1><p class="domain">{{domain}}</p><p>This server is managed with {{company_name}}. Every hosting account created here publishes its website by uploading to its own <code>public_html</code>; this address serves only the server itself.</p><p><a class="button" href="{{panel_url}}">Open the panel</a></p>'),
  suspended: page('Account suspended', '<h1>This account has been suspended</h1><p>The website for <strong>{{domain}}</strong> is temporarily unavailable.</p><p>Contact the hosting provider at <a href="mailto:{{contact_email}}">{{contact_email}}</a> for assistance.</p>', '#fff7ed'),
  moved: page('Site moved', '<h1>{{domain}} has moved</h1><p>This website is now served from a different address. If you keep seeing this page, the DNS change has not reached you yet.</p><p>Hosted on {{hostname}}.</p>'),
  'error-4xx': page('{{status}} {{status_text}}', '<h1>{{status}} {{status_text}}</h1><p>The page you requested on <strong>{{domain}}</strong> could not be served.</p><p>Hosted on {{hostname}}.</p>'),
};

// Migration 012 seeded every template row with the plain page of that time;
// such a row is the stock page, not a customisation, so the current default
// (the branded one) replaces it until the operator saves their own HTML.
const LEGACY_TEMPLATES = {
  index: [
    page('{{domain}}', '<h1>{{domain}}</h1><p>This site is hosted but has no content yet. Upload your files to <code>public_html</code>.</p>'),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{domain}}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f6f8;color:#1f2a37}main{text-align:center}h1{font-weight:600}</style></head>
<body><main><h1>{{domain}}</h1><p>This site is hosted but has no content yet. Upload your files to <code>public_html</code>.</p></main></body></html>
`,
  ],
};
const normalizeHtml = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export function isStockTemplate(name, body) {
  if (body == null) return true;
  const n = normalizeHtml(body);
  return n === normalizeHtml(DEFAULT_TEMPLATES[name]) || (LEGACY_TEMPLATES[name] || []).some((legacy) => normalizeHtml(legacy) === n);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// HTML pages escape substituted values; plain-text mail (escape: false) must not.
export function renderTemplateBody(body, vars = {}, { escape = true } = {}) {
  return String(body).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (vars[key] == null ? '' : escape ? escapeHtml(vars[key]) : String(vars[key])));
}
// ensureVhost answers these after the vhost files were written and Apache
// reloaded: a PHP-handler warning, not a failed rewrite (integration contract 4).
export const VHOST_WARNINGS = new Set(['php_missing', 'php_pool_failed']);
const vhostWritten = (web) => Boolean(web?.applied || VHOST_WARNINGS.has(web?.reason));

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const previousMonthKey = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

export function createAccountFunctionsService(ctx) {
  const { db, agent, capabilities, settings, config, logger, jobs } = ctx;
  const stmts = {
    byUsername: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.username = ?'),
    all: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id ORDER BY a.username'),
    byOwner: db.prepare('SELECT a.*, u.username AS owner FROM accounts a JOIN users u ON u.id = a.owner_id WHERE a.owner_id = ? ORDER BY a.username'),
    domains: db.prepare('SELECT * FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    setIp: db.prepare("UPDATE accounts SET ip = ?, updated_at = datetime('now') WHERE id = ?"),
    setBandwidthLimit: db.prepare("UPDATE accounts SET bandwidth_limit_mb = ?, updated_at = datetime('now') WHERE id = ?"),
    resetBandwidth: db.prepare("UPDATE accounts SET bandwidth_used_mb = 0, updated_at = datetime('now') WHERE id = ?"),
    setDemo: db.prepare("UPDATE accounts SET demo_mode = ?, updated_at = datetime('now') WHERE id = ?"),
    setForce: db.prepare("UPDATE accounts SET force_password_change = ?, updated_at = datetime('now') WHERE id = ?"),
    setShell: db.prepare("UPDATE accounts SET shell = ?, updated_at = datetime('now') WHERE id = ?"),
    setQuota: db.prepare("UPDATE accounts SET disk_quota_mb = ?, updated_at = datetime('now') WHERE id = ?"),
    setHome: db.prepare("UPDATE accounts SET home_dir = ?, updated_at = datetime('now') WHERE id = ?"),
    docrootsOf: db.prepare('SELECT id, docroot FROM account_domains WHERE account_id = ?'),
    setDocroot: db.prepare('UPDATE account_domains SET docroot = ? WHERE id = ?'),
    zonesOf: db.prepare('SELECT domain FROM dns_zones WHERE account_id = ? ORDER BY domain'),
    retention: db.prepare('SELECT * FROM account_log_retention WHERE account_id = ?'),
    retentionAll: db.prepare('SELECT * FROM account_log_retention'),
    upsertRetention: db.prepare(`INSERT INTO account_log_retention (account_id, archive_logs, remove_old_archives, retain_months) VALUES (@account_id, @archive_logs, @remove_old_archives, @retain_months)
      ON CONFLICT (account_id) DO UPDATE SET archive_logs = excluded.archive_logs, remove_old_archives = excluded.remove_old_archives, retain_months = excluded.retain_months, updated_at = datetime('now')`),
    archived: db.prepare("UPDATE account_log_retention SET last_archived_at = datetime('now') WHERE account_id = ?"),
    templates: db.prepare('SELECT * FROM web_templates ORDER BY name'),
    template: db.prepare('SELECT * FROM web_templates WHERE name = ?'),
    saveTemplate: db.prepare(`INSERT INTO web_templates (name, body) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const op = (name, args, req) => agent.op(name, args, { req });
  const strict = () => config.env === 'production';
  const hostname = () => settings.get('basic.hostname', '') || 'localhost';
  const homeOf = (a) => a.home_dir || `${settings.get('basic.home_root') || '/home'}/${a.username}`;
  const summary = (a) => ({
    username: a.username, domain: a.domain, owner: a.owner, ip: a.ip, package_name: a.package_name, contact_email: a.contact_email,
    suspended: Boolean(a.suspended), suspend_reason: a.suspend_reason, demo_mode: Boolean(a.demo_mode), force_password_change: Boolean(a.force_password_change),
    shell: a.shell, disk_quota_mb: a.disk_quota_mb, disk_used_mb: a.disk_used_mb, bandwidth_limit_mb: a.bandwidth_limit_mb, bandwidth_used_mb: a.bandwidth_used_mb,
    bandwidth_percent: a.bandwidth_limit_mb ? Math.round((a.bandwidth_used_mb / a.bandwidth_limit_mb) * 100) : null,
    over_bandwidth: Boolean(a.bandwidth_limit_mb && a.bandwidth_used_mb >= a.bandwidth_limit_mb),
    home_dir: homeOf(a), uid: a.uid, systemUser: a.uid != null, created_at: a.created_at, updated_at: a.updated_at,
  });

  function load(username, user) {
    const row = stmts.byUsername.get(username);
    if (!row) throw notFound('Account');
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return row;
  }
  const visibleAccounts = (user) => (isRoot(user) ? stmts.all.all() : stmts.byOwner.all(user.id));
  // Resellers act within their delegated ACLs (Reseller Center); without the
  // resellers category no ACLs exist and ownership alone applies, as in accounts.js.
  const requireAcl = (user, key) => { if (!isRoot(user)) ctx.resellers?.assertAcl?.(user, key); };
  const explicitAcl = (user, key) => !isRoot(user) && Boolean(ctx.resellers?.aclsFor?.(user.id)?.has(key));
  const quotaArgs = (username, mb, filesystem) => ({ username, softMb: mb || 0, hardMb: mb ? Math.round(mb * 1.05) : 0, filesystem });
  // Bulk actions take explicit usernames or "all"; unknown or foreign accounts are reported, never silently skipped.
  function selectAccounts({ usernames, all }, user) {
    if (all) return { accounts: visibleAccounts(user), missing: [] };
    const missing = [];
    const accounts = [];
    for (const u of usernames || []) {
      try { accounts.push(load(u, user)); } catch (err) { if (err.status === 404 || err.status === 403) missing.push(u); else throw err; }
    }
    return { accounts, missing };
  }

  // Agent failures that only mean "this dev box has no such tool" are tolerated
  // outside production so the panel stays usable; production always surfaces them.
  async function tolerant(name, args, req) {
    try { return { ok: true, result: await op(name, args, req) }; } catch (err) {
      if (strict() || !['capability_missing', 'binary_not_found', 'path_not_allowed', 'command_failed', 'spawn_failed', 'op_failed'].includes(err.code)) throw err;
      logger.warn({ op: name, code: err.code }, `${err.message} — continuing without applying it to the host (development mode)`);
      return { ok: false, error: err.message, code: err.code };
    }
  }

  const resolveMountpoint = (dir, disks) => disks.filter((d) => dir === d.mountpoint || dir.startsWith(d.mountpoint.endsWith('/') ? d.mountpoint : `${d.mountpoint}/`)).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0]?.mountpoint || '/';
  const diskList = () => op('sys.disk.usage', {}).catch(() => []);
  // Callers resolving many homes pass one fetched disk list instead of paying an agent round-trip per account.
  async function mountpointFor(dir, disks) {
    try { return resolveMountpoint(dir, disks || await diskList()); } catch { return '/'; }
  }

  // ------------------------------------------------------------- templates ---

  // Branding comes from cPanel › Customization when that category is loaded;
  // the raw company-name setting is read directly because branding.get()
  // substitutes "WHM" for an empty one. The logo is only reachable through the
  // panel, so its URL is absolute.
  function brandingVars() {
    let branding = null;
    try { branding = ctx.cpanel?.branding?.get?.() ?? null; } catch { branding = null; }
    const host = hostname();
    const panelUrl = config?.tls ? `https://${host}:${config.tlsPort}` : `http://${host}:${config?.port ?? 2086}`;
    const configured = String(settings.get('branding.company_name', '') ?? '').trim();
    const company = configured && configured !== ADMIN_BRANDING_DEFAULTS.company_name ? configured : DEFAULT_COMPANY_NAME;
    const rawTagline = String(branding?.tagline ?? settings.get('branding.tagline', '') ?? '').trim();
    const tagline = rawTagline === ADMIN_BRANDING_DEFAULTS.tagline ? '' : rawTagline;
    const logo = typeof branding?.logo?.url === 'string' && branding.logo.url.startsWith('/') ? `${panelUrl}${branding.logo.url}` : '';
    return { company_name: company, tagline, logo_url: logo, panel_url: panelUrl };
  }

  // The operator's HTML when they saved some; the current default for a stock row.
  const storedBody = (name) => { const row = stmts.template.get(name); return row && !isStockTemplate(name, row.body) ? row.body : null; };

  function renderTemplate(name, vars = {}) {
    const body = storedBody(name) ?? DEFAULT_TEMPLATES[name];
    if (body == null) throw notFound(`Template "${name}"`);
    return renderTemplateBody(body, { hostname: hostname(), contact_email: settings.get('basic.contact_email', '') || `root@${hostname()}`, ...brandingVars(), ...vars });
  }

  const templates = {
    list() {
      const rows = Object.fromEntries(stmts.templates.all().map((t) => [t.name, t]));
      return { dir: TEMPLATE_DIR, variables: TEMPLATE_VARS, templates: TEMPLATE_NAMES.map((name) => { const custom = rows[name] && !isStockTemplate(name, rows[name].body); return { name, path: `${TEMPLATE_DIR}/${name}.html`, updated_at: rows[name]?.updated_at ?? null, customised: Boolean(custom), bytes: Buffer.byteLength(custom ? rows[name].body : DEFAULT_TEMPLATES[name]), served: TEMPLATE_USAGE[name].served, served_by: TEMPLATE_USAGE[name].by }; }) };
    },
    get(name) {
      if (!TEMPLATE_NAMES.includes(name)) throw notFound(`Template "${name}"`);
      const row = stmts.template.get(name);
      return { name, path: `${TEMPLATE_DIR}/${name}.html`, body: storedBody(name) ?? DEFAULT_TEMPLATES[name], default: DEFAULT_TEMPLATES[name], updated_at: row?.updated_at ?? null, variables: TEMPLATE_VARS, served: TEMPLATE_USAGE[name].served, served_by: TEMPLATE_USAGE[name].by };
    },
    async save(name, body, req) {
      if (!TEMPLATE_NAMES.includes(name)) throw notFound(`Template "${name}"`);
      if (!/<html[\s>]/i.test(body)) throw unprocessable('The template must be a complete HTML document', { body: ['Missing <html> element'] });
      const written = await tolerant('fs.write_file', { path: `${TEMPLATE_DIR}/${name}.html`, content: body, owner: 'root', mode: '0644', backup: true }, req);
      stmts.saveTemplate.run(name, body);
      audit(req, { action: 'account.template.save', target: name, args: { bytes: Buffer.byteLength(body), written: written.ok } });
      const out = { ...templates.get(name), written: written.ok, writeError: written.error ?? null };
      // The landing page is live on the hostname vhost: re-render it now rather
      // than at the next boot or hostname change.
      if (name === 'landing' && typeof ctx.web?.ensureHostnameVhost === 'function') {
        out.rendered = await ctx.web.ensureHostnameVhost(req)
          .then((r) => ({ hostname: r.hostname ?? null, applied: Boolean(r.applied), landingPage: Boolean(r.landingPage), reason: r.reason ?? null, error: r.error ?? null }))
          .catch((err) => ({ hostname: null, applied: false, landingPage: false, reason: err.code || 'error', error: err.message }));
      }
      return out;
    },
    async reset(name, req) { return templates.save(name, DEFAULT_TEMPLATES[name], req); },
    preview(name, vars = {}) {
      if (!TEMPLATE_NAMES.includes(name)) throw notFound(`Template "${name}"`);
      const body = vars.body ?? storedBody(name) ?? DEFAULT_TEMPLATES[name];
      const sample = { domain: name === 'landing' ? hostname() : 'example.com', username: 'example', ip: settings.get('basic.main_ip', '') || '203.0.113.10', status: '404', status_text: 'Not Found', reason: 'Non-payment', hostname: hostname(), contact_email: settings.get('basic.contact_email', '') || `root@${hostname()}`, ...brandingVars() };
      const { body: _b, ...rest } = vars;
      return { name, html: renderTemplateBody(body, { ...sample, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== '' && v != null)) }) };
    },
  };

  // ------------------------------------------------------- change site IP ---

  // The vhost files are rewritten in place by Service Configuration's replaceIp
  // (only the address changes); ensureVhost is the fallback for a web service
  // without that hook or an account that had no address recorded yet.
  async function rewriteVhostIp(username, previous, ip, req) {
    if (!ctx.web) return { applied: false, reason: 'web_category_missing', domains: [] };
    if (ctx.web.replaceIp && previous) {
      const r = await ctx.web.replaceIp(previous, ip, { accounts: [username] }, req);
      return { applied: r.updated > 0, updated: r.updated, reason: r.updated > 0 ? null : 'no_vhost_on_previous_ip', domains: r.domains || [] };
    }
    const web = await ctx.web.ensureVhost(username, req);
    return { applied: vhostWritten(web), reason: web.reason ?? null, domains: (web.vhosts || []).map((v) => v.domain) };
  }

  async function changeIp(username, { ip }, user, req) {
    const account = load(username, user);
    requireAcl(user, 'edit-account');
    const previous = account.ip;
    if (previous === ip) throw conflict(`${username} already uses ${ip}`);
    const ipSvc = ctx.ip;
    // Resellers may only use the shared address or one delegated to them in
    // Reseller Center, the same rule account creation applies.
    if (!isRoot(user)) {
      const allowed = new Set([ipSvc?.sharedIp?.() ?? settings.get('basic.shared_ip') ?? settings.get('basic.main_ip'), ctx.resellers?.sharedIpFor?.(user), ...(ctx.resellers?.delegatedAddresses?.(user.id) ?? []).map((r) => r.address)].filter(Boolean));
      if (!allowed.has(ip)) throw forbidden(`${ip} is not delegated to you; ask the server administrator to delegate it in Reseller Center`);
    }
    if (ipSvc) {
      const known = ipSvc.get(ip);
      if (!known) throw unprocessable(`${ip} is not configured on this server; add it under IP Functions first`, { ip: ['Unknown address'] });
      // IP Functions reports dedicated_to as the account's username.
      if (known.dedicated_to && known.dedicated_to !== account.username) throw conflict(`${ip} is dedicated to another account`);
      if (known.reserved) throw conflict(`${ip} is reserved (${known.reserved_reason || 'no reason given'})`);
    }
    // The vhost and zone renderers read accounts.ip, so the row changes first and
    // is put back when the host refuses.
    const snapshotDedicated = ipSvc ? ipSvc.all().filter((r) => r.dedicated_to === account.username).map((r) => r.address) : [];
    // "Free" is judged before the account row takes the address (an address in use is never free).
    const free = ipSvc ? ipSvc.freeAddresses(ip.includes(':') ? 6 : 4).some((r) => r.address === ip) : false;
    stmts.setIp.run(ip, account.id);
    const result = { username, previousIp: previous, ip, web: null, dns: [], dedicated: null };
    // Set once the IP pool changed, so a later failure puts the pool back too
    // (the previous dedicated addresses re-dedicated, the new one released).
    let poolChanged = false;
    try {
      if (ipSvc) {
        const shared = ipSvc.sharedIp();
        if (ip !== shared && (free || snapshotDedicated.includes(ip))) {
          if (!snapshotDedicated.includes(ip)) { poolChanged = true; ipSvc.releaseDedicated(account.id, req); ipSvc.allocateDedicated(account.id, req, { address: ip }); }
          result.dedicated = ip;
        } else if (snapshotDedicated.length) { poolChanged = true; ipSvc.releaseDedicated(account.id, req); stmts.setIp.run(ip, account.id); }
      }
      result.web = await rewriteVhostIp(username, previous, ip, req);
      if (ctx.dns && previous) {
        for (const { domain } of stmts.zonesOf.all(account.id)) {
          try {
            const zone = await ctx.dns.getZone(domain, user);
            const stale = zone.records.filter((r) => r.type === 'A' && r.value === previous);
            for (const name of new Set(stale.map((r) => r.name))) {
              const values = zone.records.filter((r) => r.type === 'A' && r.name === name).map((r) => ({ value: r.value === previous ? ip : r.value, ttl: r.ttl }));
              const pub = await ctx.dns.upsertRecords(domain, name, 'A', values, req);
              result.dns.push({ domain, name, applied: pub?.applied ?? false, reason: pub?.reason ?? null });
            }
            if (!stale.length) result.dns.push({ domain, name: null, applied: true, reason: 'no A record pointed at the old address' });
          } catch (err) { result.dns.push({ domain, name: null, applied: false, reason: err.message }); }
        }
      }
    } catch (err) {
      if (poolChanged) {
        try {
          ipSvc.releaseDedicated(account.id, req);
          for (const address of snapshotDedicated) ipSvc.allocateDedicated(account.id, req, { address });
        } catch (undoErr) { logger.error({ err: undoErr, username }, 'IP pool could not be restored after a failed IP change'); }
      }
      stmts.setIp.run(previous, account.id);
      throw err;
    }
    audit(req, { action: 'account.ip.change', target: username, args: { from: previous, to: ip, dedicated: result.dedicated, web: result.web?.applied, dns: result.dns.length } });
    return { ...result, account: summary(stmts.byUsername.get(username)) };
  }

  // ------------------------------------------------------ email all users ---

  function recipients({ scope = 'all', owner } = {}, user) {
    let rows = visibleAccounts(user);
    if (scope === 'active') rows = rows.filter((a) => !a.suspended);
    if (scope === 'suspended') rows = rows.filter((a) => a.suspended);
    if (owner && isRoot(user)) rows = rows.filter((a) => a.owner === owner);
    const withEmail = rows.filter((a) => a.contact_email);
    return { total: rows.length, withoutEmail: rows.length - withEmail.length, recipients: withEmail.map((a) => ({ username: a.username, domain: a.domain, email: a.contact_email, owner: a.owner, suspended: Boolean(a.suspended) })) };
  }

  function senderFor() {
    if (ctx.contacts?.sendMail) return { kind: 'contacts', send: (msg, req) => ctx.contacts.sendMail(msg, req) };
    if (ctx.mail?.sendNotification) return { kind: 'mail', send: (msg, req) => ctx.mail.sendNotification(msg, req) };
    return { kind: 'agent', send: (msg, req) => op('mail.sendmail', { from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }, req) };
  }

  const defaultSender = (user) => settings.get('account_functions.email_from', '') || settings.get('mail.notification_from', '') || `${user.username === 'root' ? 'root' : user.username}@${hostname()}`;

  function emailAll({ subject, text, scope, owner, from }, user, req) {
    const sender = senderFor();
    if (sender.kind !== 'contacts') capabilities.require('exim', 'Exim is not installed, so the panel cannot send email. Install exim4 (Debian/Ubuntu) or exim (RHEL) to email account owners.');
    const list = recipients({ scope, owner }, user);
    if (!list.recipients.length) throw unprocessable('No account in the selection has a contact email address', { scope: ['Nothing to send'] });
    // A reseller sends as itself (its own contact address or the server's
    // configured sender); only root may put another sender on the envelope.
    if (from && !isRoot(user)) {
      const own = [user.email, defaultSender(user)].filter(Boolean).map((a) => a.toLowerCase());
      if (!own.includes(from.toLowerCase())) throw forbidden(`Resellers can only send from their own contact address${user.email ? ` (${user.email})` : ''} or the server's notification sender`);
    }
    const sendFrom = from || defaultSender(user);
    const job = jobs.enqueue('accounts.email_all', { subject, text, from: sendFrom, recipients: list.recipients, requestedBy: user.username }, { userId: user.id });
    audit(req, { action: 'account.email_all', target: scope || 'all', args: { subject, recipients: list.recipients.length, from: sendFrom, job: job.id } });
    return { job, recipients: list.recipients.length, from: sendFrom };
  }

  async function runEmailAll(jobCtx) {
    const { subject, text, from, recipients: list = [], requestedBy } = jobCtx.params;
    const sender = senderFor();
    const sent = [];
    const failed = [];
    jobCtx.log(`Sending "${subject}" to ${list.length} account owner(s) as ${from} via ${sender.kind}`);
    for (const [i, r] of list.entries()) {
      const vars = { username: r.username, domain: r.domain, hostname: hostname(), email: r.email };
      const body = renderTemplateBody(text, vars, { escape: false });
      try {
        await sender.send({ to: r.email, from, subject: renderTemplateBody(subject, vars, { escape: false }), text: body }, null);
        sent.push(r.username);
        jobCtx.log(`${r.username} <${r.email}>: accepted`);
      } catch (err) {
        failed.push({ username: r.username, email: r.email, error: err.message });
        jobCtx.log(`${r.username} <${r.email}>: ${err.message}`, 'warn');
        if (err.code === 'capability_missing' || err.code === 'binary_not_found' || err.status === 501) { jobCtx.log('Mail server is not available; stopping', 'error'); break; }
      }
      jobCtx.progress(((i + 1) / list.length) * 100, `${sent.length} sent, ${failed.length} failed`);
    }
    ctx.auditRecord?.(null, { action: 'account.email_all.result', target: requestedBy, args: { subject, sent: sent.length, failed: failed.length } });
    return { subject, from, sent, failed, total: list.length };
  }

  // ---------------------------------------------------------- bulk flags ---

  function bulkFlag({ usernames, all, enabled }, user, req, { stmt, action, column, acl }) {
    requireAcl(user, acl);
    const { accounts, missing } = selectAccounts({ usernames, all }, user);
    const changed = [];
    db.transaction(() => { for (const a of accounts) { if (Boolean(a[column]) !== enabled) { stmt.run(enabled ? 1 : 0, a.id); changed.push(a.username); } } })();
    audit(req, { action, target: all ? 'all' : accounts.map((a) => a.username).join(','), args: { enabled, changed: changed.length } });
    return { enabled, changed, unchanged: accounts.map((a) => a.username).filter((u) => !changed.includes(u)), missing };
  }
  const forcePasswordChange = (input, user, req) => bulkFlag(input, user, req, { stmt: stmts.setForce, action: 'account.force_password_change', column: 'force_password_change', acl: 'passwd' });
  const setDemoMode = (input, user, req) => bulkFlag(input, user, req, { stmt: stmts.setDemo, action: 'account.demo_mode', column: 'demo_mode', acl: 'demo-setup' });

  // ------------------------------------------------------------ bandwidth ---

  function setBandwidthLimit(username, { limitMb }, user, req) {
    const account = load(username, user);
    requireAcl(user, 'limit-bandwidth');
    if (limitMb == null && settings.get('tweak.prevent_unlimited_bandwidth', false)) throw unprocessable('Unlimited bandwidth is disabled in Tweak Settings', { limitMb: ['Enter a limit in MB'] });
    // The reseller's own bandwidth allocation (and the unlimited-bandwidth ACL) still bind.
    if (!isRoot(user)) ctx.resellers?.modifyPolicy?.(user, account, { bandwidthLimitMb: limitMb });
    stmts.setBandwidthLimit.run(limitMb, account.id);
    audit(req, { action: 'account.bandwidth.limit', target: username, args: { from: account.bandwidth_limit_mb, to: limitMb } });
    return summary(stmts.byUsername.get(username));
  }

  // The current period's log totals belong to Account Information
  // (account_bandwidth); it clears them through resetPeriod, and without that
  // hook only the counter on the account row is zeroed (integration contract 2).
  function clearBandwidth(accounts) {
    for (const a of accounts) stmts.resetBandwidth.run(a.id);
    if (accounts.length && ctx.accountInfo?.resetPeriod) ctx.accountInfo.resetPeriod(accounts.map((a) => a.username));
  }

  async function resetBandwidth({ usernames, all, unsuspend = true }, user, req) {
    requireAcl(user, 'limit-bandwidth');
    const { accounts, missing } = selectAccounts({ usernames, all }, user);
    const reset = [];
    const unsuspended = [];
    clearBandwidth(accounts);
    for (const a of accounts) {
      reset.push(a.username);
      if (unsuspend && a.suspended && BANDWIDTH_REASON.test(a.suspend_reason || '')) {
        await ctx.accounts.unsuspend(a.username, user, req);
        unsuspended.push(a.username);
      }
    }
    audit(req, { action: 'account.bandwidth.reset', target: all ? 'all' : reset.join(','), args: { reset: reset.length, unsuspended } });
    return { reset, unsuspended, missing, period: monthKey() };
  }

  function exceeders(user) {
    return visibleAccounts(user).map(summary).filter((a) => a.over_bandwidth || (a.suspended && BANDWIDTH_REASON.test(a.suspend_reason || '')))
      .map((a) => ({ ...a, suspended_for_bandwidth: a.suspended && BANDWIDTH_REASON.test(a.suspend_reason || '') }));
  }

  async function unsuspendExceeders({ usernames, all = false, resetCounters = false }, user, req) {
    requireAcl(user, 'limit-bandwidth');
    const candidates = exceeders(user).filter((a) => a.suspended_for_bandwidth);
    const wanted = all ? candidates : candidates.filter((a) => (usernames || []).includes(a.username));
    const unsuspended = [];
    const failed = [];
    for (const a of wanted) {
      try {
        if (resetCounters) clearBandwidth([stmts.byUsername.get(a.username)]);
        await ctx.accounts.unsuspend(a.username, user, req);
        unsuspended.push(a.username);
      } catch (err) { failed.push({ username: a.username, error: err.message }); }
    }
    audit(req, { action: 'account.bandwidth.unsuspend_exceeders', target: wanted.map((a) => a.username).join(',') || 'none', args: { unsuspended: unsuspended.length, failed: failed.length, resetCounters } });
    return { unsuspended, failed, skipped: candidates.length - wanted.length };
  }

  const ENFORCE_SCHEDULE = 'account-bandwidth-enforce';
  const bandwidthEnforcement = () => ({ enabled: Boolean(settings.get('account_functions.bandwidth_enforce', false)), reason: settings.get('account_functions.bandwidth_suspend_reason', 'bandwidth: monthly transfer limit exceeded'), schedule: ENFORCE_SCHEDULE });
  // The setting is the source of truth; the schedule row follows it and is only
  // written when they disagree (Configure cPanel Cron Jobs may edit the row too).
  function syncEnforcementSchedule() {
    const row = ctx.scheduler.list().find((s) => s.name === ENFORCE_SCHEDULE);
    const enabled = bandwidthEnforcement().enabled;
    if (row && Boolean(row.enabled) !== enabled) ctx.scheduler.update(ENFORCE_SCHEDULE, { enabled });
    return enabled;
  }
  function setBandwidthEnforcement({ enabled, reason }, req) {
    settings.set('account_functions.bandwidth_enforce', enabled);
    if (reason) settings.set('account_functions.bandwidth_suspend_reason', BANDWIDTH_REASON.test(reason) ? reason : `bandwidth: ${reason}`);
    syncEnforcementSchedule();
    audit(req, { action: 'account.bandwidth.enforcement', args: { enabled, reason: reason ?? null } });
    return bandwidthEnforcement();
  }

  async function runBandwidthEnforce(jobCtx) {
    if (!settings.get('account_functions.bandwidth_enforce', false)) { jobCtx.log('Bandwidth enforcement is disabled (account_functions.bandwidth_enforce)'); return { suspended: [], enabled: false }; }
    const reason = settings.get('account_functions.bandwidth_suspend_reason', 'bandwidth: monthly transfer limit exceeded');
    const root = { id: null, username: 'scheduler', role: 'root' };
    const suspended = [];
    const failed = [];
    for (const a of stmts.all.all()) {
      if (a.suspended || !a.bandwidth_limit_mb || a.bandwidth_used_mb < a.bandwidth_limit_mb) continue;
      try {
        // accounts.suspend writes the per-account account.suspend audit row itself (principal-less, by: scheduler).
        const r = await ctx.accounts.suspend(a.username, reason, root, null);
        suspended.push(a.username);
        jobCtx.log(`${a.username}: suspended (${a.bandwidth_used_mb} MB of ${a.bandwidth_limit_mb} MB)${r.web?.applied ? '; web sites switched to the suspended page' : r.web?.reason ? `; web: ${r.web.reason}` : ''}`);
      } catch (err) { failed.push({ username: a.username, error: err.message }); jobCtx.log(`${a.username}: ${err.message}`, 'warn'); }
    }
    ctx.auditRecord?.(null, { action: 'account.bandwidth.enforce', target: suspended.join(',') || 'none', args: { job: jobCtx.job?.id ?? null, reason, suspended, failed: failed.length, by: 'scheduler' } });
    return { suspended, failed, enabled: true };
  }

  async function runMonthlyBandwidthReset(jobCtx) {
    const root = { id: null, username: 'scheduler', role: 'root' };
    const result = await resetBandwidth({ all: true, unsuspend: true }, root, null);
    jobCtx.log(`Reset bandwidth counters of ${result.reset.length} account(s); unsuspended ${result.unsuspended.length}`);
    return result;
  }

  // ---------------------------------------------------------------- shell ---

  async function setShell(username, { shell }, user, req) {
    const account = load(username, user);
    if (shell !== '/usr/sbin/nologin') {
      requireAcl(user, 'add-pkg-shell');
      if (explicitAcl(user, 'disallow-shell')) throw forbidden('Your reseller privileges forbid granting shell access (Disallow Shell Access); only /usr/sbin/nologin can be set');
    }
    if (shell === '/usr/local/bin/jailshell') {
      const bins = await op('sys.binaries', { names: ['jailshell'] });
      if (!bins.jailshell) throw new CapabilityError('jailshell', 'The jailed shell (/usr/local/bin/jailshell) is not installed on this server. Install a jailshell/CageFS-style wrapper or choose a normal shell.');
    }
    if (account.uid != null) await op('user.set_shell', { username, shell }, req);
    stmts.setShell.run(shell, account.id);
    audit(req, { action: 'account.shell', target: username, args: { from: account.shell, to: shell, applied: account.uid != null } });
    return { ...summary(stmts.byUsername.get(username)), applied: account.uid != null };
  }

  // ---------------------------------------------------------------- quota ---

  async function setQuota(username, { diskQuotaMb }, user, req) {
    const account = load(username, user);
    requireAcl(user, 'quota');
    // The reseller's disk allocation (and the unlimited-disk ACL) still bind.
    if (!isRoot(user)) ctx.resellers?.modifyPolicy?.(user, account, { diskQuotaMb });
    const filesystem = await mountpointFor(homeOf(account));
    let applied = false;
    if (account.uid != null) {
      if (!capabilities.has('quota')) {
        stmts.setQuota.run(diskQuotaMb, account.id);
        audit(req, { action: 'account.quota', target: username, args: { from: account.disk_quota_mb, to: diskQuotaMb, applied: false } });
        throw new CapabilityError('quota', `Disk quotas are not installed on this server; ${username}'s quota of ${diskQuotaMb == null ? 'unlimited' : `${diskQuotaMb} MB`} is saved and is applied once the quota tools exist (see Initial Quota Setup).`);
      }
      await op('user.set_quota', quotaArgs(username, diskQuotaMb, filesystem), req);
      applied = true;
    }
    stmts.setQuota.run(diskQuotaMb, account.id);
    audit(req, { action: 'account.quota', target: username, args: { from: account.disk_quota_mb, to: diskQuotaMb, filesystem, applied } });
    return { ...summary(stmts.byUsername.get(username)), applied, filesystem };
  }

  async function quotaReport(user) {
    const accounts = visibleAccounts(user);
    if (!capabilities.has('quota')) throw new CapabilityError('quota', 'Disk quotas are not installed on this server (setquota/repquota missing). Run Initial Quota Setup after installing the quota package.');
    const disks = await diskList();
    const byFs = new Map();
    const fsOf = new Map();
    for (const a of accounts) {
      const fs = resolveMountpoint(homeOf(a), disks);
      fsOf.set(a.id, fs);
      if (!byFs.has(fs)) byFs.set(fs, await op('user.quota_report', { filesystem: fs }).catch((err) => ({ available: false, users: [], error: err.message })));
    }
    return accounts.map((a) => {
      const fs = fsOf.get(a.id);
      const report = byFs.get(fs) || { users: [] };
      const live = report.users.find((u) => u.username === a.username) || null;
      return { ...summary(a), filesystem: fs, live: live ? { usedMb: live.usedMb, softMb: live.softMb, hardMb: live.hardMb } : null, reportAvailable: report.available !== false };
    });
  }

  // ------------------------------------------------------------- raw logs ---

  // The agent lists only regular files reached without a symlink; a directory
  // under the account home must also belong to the account (or root), so a
  // tenant cannot point ~/logs at another tenant's logs or at /var/log. A
  // refusal is reported with the listing rather than hidden.
  async function listDir(dir, owner) {
    try {
      const r = await op('acct.list_logs', { path: dir, limit: 5000, ...(owner ? { owner } : {}) });
      return { files: r.entries.filter((e) => LOG_FILE.test(e.name)).map((e) => ({ dir, name: e.name, path: `${dir}/${e.name}`, size: e.size, mtime: e.mtime, owner: owner || null })), warning: null };
    } catch (err) {
      if (err.code === 'refused') return { files: [], warning: `${dir} was skipped: ${err.message}` };
      if (['op_failed', 'not_found', 'path_not_allowed'].includes(err.code)) return { files: [], warning: null };
      throw err;
    }
  }

  const logs = {
    async list(username, kind, user) {
      const account = load(username, user);
      const domains = [account.domain, ...stmts.domains.all(account.id).map((d) => d.domain)];
      const home = homeOf(account);
      const owner = account.uid != null ? username : undefined;
      let server;
      if (kind === 'nginx') {
        if (!capabilities.has('nginx')) throw new CapabilityError('nginx', 'NGINX is not installed on this server, so there are no NGINX logs to download.');
        server = await listDir(NGINX_LOG_DIR);
        server.files = server.files.filter((f) => domains.some((d) => domainLogFile(d).test(f.name)));
      } else server = await listDir(`${DOMLOGS_ROOT}/${username}`);
      const own = await listDir(`${home}/logs`, owner);
      own.files = own.files.filter((f) => (kind === 'nginx') === /nginx/i.test(f.name));
      const files = [...server.files, ...own.files];
      return { username, kind, domains, dirs: kind === 'nginx' ? [NGINX_LOG_DIR, `${home}/logs`] : [`${DOMLOGS_ROOT}/${username}`, `${home}/logs`], files: files.sort((a, b) => a.name.localeCompare(b.name)), warnings: [server.warning, own.warning].filter(Boolean), apache: capabilities.has('apache'), nginx: capabilities.has('nginx') };
    },
    // Streams the file through the agent in 1 MB ranges so a multi-gigabyte log
    // never has to fit in memory on either side of the socket.
    async download(username, kind, file, user, req, res) {
      const listing = await logs.list(username, kind, user);
      const entry = listing.files.find((f) => f.name === file);
      if (!entry) throw notFound(`Log file "${file}"`);
      const chunk = 1024 * 1024;
      const range = (offset, length) => op('acct.read_range', { path: entry.path, offset, length, ...(entry.owner ? { owner: entry.owner } : {}) }, req);
      const first = await range(0, chunk);
      res.status(200);
      res.set({ 'Content-Type': file.endsWith('.gz') ? 'application/gzip' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${username}-${file.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Content-Length': String(first.size), 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      audit(req, { action: 'account.log.download', target: username, args: { kind, file, bytes: first.size } });
      // Content-Length is fixed from the first range: once headers are out a
      // later failure (agent error, file rotated or truncated meanwhile) can
      // only be reported by cutting the connection, never by a JSON error.
      let sent = 0;
      let part = first;
      try {
        for (;;) {
          if (part.length) { sent += part.length; if (!res.write(Buffer.from(part.data, 'base64'))) await new Promise((r) => res.once('drain', r)); }
          if (sent >= first.size || res.destroyed) break;
          if (part.eof) throw new Error(`${entry.path} shrank to ${part.size} bytes while it was being sent (rotated or truncated)`);
          part = await range(sent, Math.min(chunk, first.size - sent));
          if (part.size !== first.size) throw new Error(`${entry.path} changed size while it was being sent (${first.size} -> ${part.size} bytes)`);
        }
      } catch (err) {
        logger.warn({ err, username, file, sent, size: first.size }, 'raw log download aborted');
        audit(req, { action: 'account.log.download.aborted', target: username, args: { kind, file, sent, bytes: first.size, error: err.message } });
        res.destroy(err);
        return { bytes: sent, aborted: true, error: err.message };
      }
      res.end();
      return { bytes: sent };
    },
  };

  // ------------------------------------------------------------ rearrange ---

  const rearrange = {
    async partitions() {
      const disks = await diskList();
      const accounts = stmts.all.all();
      const roots = [];
      for (const root of HOME_ROOTS) {
        const mountpoint = resolveMountpoint(root, disks);
        const disk = disks.find((d) => d.mountpoint === mountpoint) || null;
        const stat = await op('fs.stat', { path: root }).catch(() => ({ exists: false }));
        roots.push({ root, exists: Boolean(stat.exists && stat.isDirectory), mountpoint: disk?.mountpoint ?? null, filesystem: disk?.filesystem ?? null, availableBytes: disk?.availableBytes ?? null, usedPercent: disk?.usedPercent ?? null, accounts: accounts.filter((a) => homeOf(a).startsWith(`${root}/`)).length });
      }
      return { roots, disks };
    },
    async start(username, { target }, user, req) {
      const account = load(username, user);
      if (!HOME_ROOTS.includes(target)) throw unprocessable(`"${target}" is not a home partition the panel manages`, { target: [`One of ${HOME_ROOTS.join(', ')}`] });
      const from = homeOf(account);
      const to = `${target}/${username}`;
      if (from === to) throw conflict(`${username} already lives on ${target}`);
      if ([...jobs.list({ status: 'running', type: 'accounts.rearrange' }), ...jobs.list({ status: 'queued', type: 'accounts.rearrange' })].some((j) => j.params.username === username)) throw conflict(`A move of ${username} is already queued`);
      capabilities.require('rsync', 'rsync is not installed on this server; it is needed to copy the account between partitions');
      const stat = await op('fs.stat', { path: target }, req);
      if (!stat.exists || !stat.isDirectory) throw unprocessable(`${target} does not exist on this server`, { target: ['Mount the partition and create the directory first'] });
      const size = await op('fs.du', { path: from }, req).catch(() => ({ bytes: null }));
      const job = jobs.enqueue('accounts.rearrange', { username, from, to, target, bytes: size.bytes, requestedBy: user.username }, { userId: user.id });
      audit(req, { action: 'account.rearrange', target: username, args: { from, to, bytes: size.bytes, job: job.id } });
      return { job, username, from, to, bytes: size.bytes };
    },
    // The account is suspended for the whole move (Linux user locked, sites on
    // the suspended page) so nothing lands in the old tree after the final
    // sync. The old tree goes only once usermod and the vhost rewrite both
    // succeeded; otherwise both copies stay and the operator is told. A failure
    // after the copy removes the partial target and restores the previous home.
    async run(jobCtx) {
      const { username, from, to, target } = jobCtx.params;
      const account = stmts.byUsername.get(username);
      if (!account) throw new Error(`Account ${username} no longer exists`);
      if (homeOf(account) !== from) throw new Error(`${username}'s home is ${homeOf(account)}, not ${from}; refusing to move`);
      const existing = await op('fs.stat', { path: to });
      if (existing.exists) {
        const entries = existing.isDirectory ? (await op('fs.list', { path: to, limit: 2 })).entries : null;
        if (!entries || entries.length) throw new Error(`${to} already exists and is not empty`);
      }
      const principal = { id: null, username: 'rearrange', role: 'root' };
      const wasSuspended = Boolean(account.suspended);
      const state = { copied: false, homeSet: false, recorded: false, quotaFs: null };
      const lock = async () => {
        if (wasSuspended) { jobCtx.log(`${username} is already suspended (${account.suspend_reason || 'no reason'}); it stays suspended after the move`); return; }
        let web = null;
        if (ctx.accounts?.suspend) ({ web } = await ctx.accounts.suspend(username, `rearrange: moving the home directory to ${target || to}`, principal, null));
        else if (account.uid != null) await op('user.lock', { username });
        jobCtx.log(`${username} suspended for the duration of the move (logins locked${web?.applied ? ', sites on the suspended page' : ''})`);
      };
      const unlock = async () => {
        if (wasSuspended) return;
        try {
          if (ctx.accounts?.unsuspend) await ctx.accounts.unsuspend(username, principal, null);
          else if (account.uid != null) await op('user.unlock', { username });
          jobCtx.log(`${username} unsuspended`);
        } catch (err) { jobCtx.log(`${username} could not be unsuspended: ${err.message}; unsuspend it from Manage Account Suspension`, 'error'); }
      };
      const restoreRecords = () => db.transaction(() => {
        stmts.setHome.run(from, account.id);
        for (const d of stmts.docrootsOf.all(account.id)) if (d.docroot && d.docroot.startsWith(`${to}/`)) stmts.setDocroot.run(`${from}${d.docroot.slice(to.length)}`, d.id);
      })();
      const rollback = async (err) => {
        jobCtx.log(`Move failed: ${err.message}; restoring ${from}`, 'error');
        if (state.recorded) { restoreRecords(); jobCtx.log('Panel records restored'); }
        if (state.homeSet) {
          try { await op('acct.set_home', { username, homeDir: from }); jobCtx.log(`usermod -d ${from} ${username} (restored)`); } catch (e) { jobCtx.log(`The home entry could not be restored to ${from}: ${e.message}`, 'error'); }
        }
        if (state.quotaFs) {
          try { await op('user.set_quota', quotaArgs(username, account.disk_quota_mb, state.quotaFs)); } catch (e) { jobCtx.log(`The quota could not be restored on ${state.quotaFs}: ${e.message}; set it again in Quota Modification`, 'warn'); }
        }
        if (state.copied) {
          try { await op('fs.remove', { path: to, recursive: true }); jobCtx.log(`Removed the partial copy ${to}`); } catch (e) { jobCtx.log(`The partial copy ${to} could not be removed: ${e.message}`, 'error'); }
        }
        ctx.auditRecord?.(null, { action: 'account.rearrange.failed', target: username, args: { from, to, error: err.message } });
      };

      await lock();
      let quota = null;
      let web = null;
      try {
        jobCtx.log(`Copying ${from} to ${to} with rsync -a (ownership and permissions preserved)`);
        jobCtx.progress(5, 'copying files');
        state.copied = true;
        await op('fs.copy_tree', { from, to });
        jobCtx.progress(60, 'copy complete; syncing changes made during the copy');
        await op('fs.copy_tree', { from, to, deleteExtraneous: true });
        jobCtx.progress(75, 'updating the system user');
        if (account.uid != null) {
          await op('acct.set_home', { username, homeDir: to });
          state.homeSet = true;
          jobCtx.log(`usermod -d ${to} ${username}`);
          // Quotas are per filesystem: the limit stays on the old one and means
          // nothing on the new partition until it is set there again.
          if (account.disk_quota_mb && capabilities.has('quota')) {
            const disks = await diskList();
            const [fromFs, toFs] = [resolveMountpoint(from, disks), resolveMountpoint(to, disks)];
            try {
              if (fromFs !== toFs) { await op('user.set_quota', quotaArgs(username, 0, fromFs)); state.quotaFs = fromFs; jobCtx.log(`Cleared the quota on ${fromFs}`); }
              await op('user.set_quota', quotaArgs(username, account.disk_quota_mb, toFs));
              quota = { applied: true, filesystem: toFs, mb: account.disk_quota_mb };
              jobCtx.log(`Re-applied the ${account.disk_quota_mb} MB quota on ${toFs}`);
            } catch (err) {
              quota = { applied: false, filesystem: toFs, mb: account.disk_quota_mb, error: err.message };
              jobCtx.log(`The ${account.disk_quota_mb} MB quota could not be applied on ${toFs}: ${err.message}; set it again in Quota Modification`, 'warn');
            }
          } else if (account.disk_quota_mb) { quota = { applied: false, mb: account.disk_quota_mb, error: 'quota tools are not installed' }; jobCtx.log('Disk quotas are not installed; the saved quota is applied once they are', 'warn'); }
        } else jobCtx.log('No Linux user for this account; only the panel records are updated', 'warn');
        db.transaction(() => {
          stmts.setHome.run(to, account.id);
          for (const d of stmts.docrootsOf.all(account.id)) if (d.docroot && d.docroot.startsWith(`${from}/`)) stmts.setDocroot.run(`${to}${d.docroot.slice(from.length)}`, d.id);
        })();
        state.recorded = true;
        jobCtx.log('Panel records updated (home directory, document roots)');
        if (ctx.web) {
          jobCtx.progress(85, 'rewriting web server configuration');
          try {
            const r = await ctx.web.ensureVhost(username, null);
            // Apache absent: nothing serves either tree, so the rewrite is
            // "done" (recorded as pending) and the old copy can go.
            web = { applied: Boolean(r.applied), reason: r.reason ?? null, ok: vhostWritten(r) || r.reason === 'capability_missing' };
          } catch (err) { web = { applied: false, reason: err.message, ok: false }; }
          jobCtx.log(web.applied ? 'Virtual hosts rewritten and the web server reloaded' : `Virtual hosts ${web.ok ? 'recorded' : 'NOT rewritten'} (${web.reason || 'not applied'})`, web.ok ? (web.applied ? 'info' : 'warn') : 'error');
        }
      } catch (err) {
        await rollback(err);
        await unlock();
        throw err;
      }
      const oldTreeRemovable = (account.uid == null || state.homeSet) && (!web || web.ok);
      let oldTreeRemoved = false;
      if (oldTreeRemovable) {
        jobCtx.progress(92, 'removing the old home directory');
        try { await op('fs.remove', { path: from, recursive: true }); oldTreeRemoved = true; jobCtx.log(`Removed ${from}`); } catch (err) { jobCtx.log(`${from} could not be removed: ${err.message}; remove it by hand once the move is verified`, 'error'); }
      } else {
        jobCtx.log(`${from} was NOT removed: the web server still points at it (${web?.reason || 'vhost rewrite failed'}). ${username} now lives in ${to}; fix the web configuration (Service Configuration > sync the account) and remove ${from} by hand.`, 'error');
        try { await ctx.contacts?.notify?.({ event: 'account.rearrange', severity: 'warning', subject: `Rearrange of ${username} needs attention`, body: `${username} was moved from ${from} to ${to}, but the virtual hosts could not be rewritten (${web?.reason || 'unknown'}). Both directories were kept.` }); } catch { /* notification is best effort */ }
      }
      await unlock();
      ctx.auditRecord?.(null, { action: 'account.rearrange.done', target: username, args: { from, to, quota, web: web ? { applied: web.applied, reason: web.reason } : null, oldTreeRemoved } });
      return { username, from, to, systemUser: account.uid != null, quota, web: web ? { applied: web.applied, reason: web.reason } : null, oldTreeRemoved, oldHome: oldTreeRemoved ? null : from, suspendedDuringMove: !wasSuspended };
    },
  };

  // -------------------------------------------------------- log retention ---

  const shapeRetention = (a, row) => ({ username: a.username, domain: a.domain, owner: a.owner, archive_logs: row ? Boolean(row.archive_logs) : Boolean(settings.get('account_functions.log_archive_default', false)), remove_old_archives: row ? Boolean(row.remove_old_archives) : true, retain_months: row?.retain_months ?? 3, last_archived_at: row?.last_archived_at ?? null, configured: Boolean(row), archive_dir: `${homeOf(a)}/logs/archive`, log_dir: `${DOMLOGS_ROOT}/${a.username}` });

  const logRetention = {
    list(user) {
      const rows = Object.fromEntries(stmts.retentionAll.all().map((r) => [r.account_id, r]));
      return { accounts: visibleAccounts(user).map((a) => shapeRetention(a, rows[a.id])), defaults: { archive_logs: Boolean(settings.get('account_functions.log_archive_default', false)) }, logrotate: capabilities.has('rsync') };
    },
    get(username, user) { const a = load(username, user); return shapeRetention(a, stmts.retention.get(a.id)); },
    set(username, input, user, req) {
      const a = load(username, user);
      const current = shapeRetention(a, stmts.retention.get(a.id));
      const next = { account_id: a.id, archive_logs: (input.archiveLogs ?? current.archive_logs) ? 1 : 0, remove_old_archives: (input.removeOldArchives ?? current.remove_old_archives) ? 1 : 0, retain_months: input.retainMonths ?? current.retain_months };
      stmts.upsertRetention.run(next);
      audit(req, { action: 'account.log_retention', target: username, args: input });
      return shapeRetention(a, stmts.retention.get(a.id));
    },
    archiveNow({ username } = {}, user, req) {
      if (username) load(username, user);
      else if (!isRoot(user)) throw forbidden('Archiving every account at once is reserved for the server administrator; name one of your accounts');
      capabilities.require('rsync', 'rsync is not installed on this server; it is needed to archive web logs into the account home');
      const job = jobs.enqueue('accounts.log_archive', username ? { username } : {}, { userId: user.id });
      audit(req, { action: 'account.log_archive', target: username || 'all', args: { job: job.id } });
      return { job };
    },
    async run(jobCtx) {
      const only = jobCtx.params.username || null;
      const rows = Object.fromEntries(stmts.retentionAll.all().map((r) => [r.account_id, r]));
      const label = previousMonthKey();
      const archived = [];
      const pruned = [];
      const skipped = [];
      const accounts = stmts.all.all().filter((a) => !only || a.username === only);
      for (const [i, a] of accounts.entries()) {
        const conf = shapeRetention(a, rows[a.id]);
        jobCtx.progress((i / Math.max(1, accounts.length)) * 100, a.username);
        if (!conf.archive_logs && !only) { skipped.push(a.username); continue; }
        if (a.uid == null) { jobCtx.log(`${a.username}: no Linux user, so there is no home to archive into`, 'warn'); skipped.push(a.username); continue; }
        const src = `${DOMLOGS_ROOT}/${a.username}`;
        try {
          const stat = await op('fs.stat', { path: src });
          if (!stat.exists) { jobCtx.log(`${a.username}: no web logs under ${src}`, 'warn'); skipped.push(a.username); continue; }
          // The copy and the pruning run as the account inside its home (acct.archive_logs), never as root.
          const r = await op('acct.archive_logs', { username: a.username, source: src, archiveDir: conf.archive_dir, label, retainMonths: conf.remove_old_archives ? conf.retain_months : null });
          stmts.archived.run(a.id);
          archived.push(a.username);
          jobCtx.log(`${a.username}: archived ${src} to ${r.dest}`);
          for (const name of r.pruned || []) { pruned.push(`${a.username}/${name}`); jobCtx.log(`${a.username}: removed archive ${name} (older than ${conf.retain_months} month(s))`); }
        } catch (err) { jobCtx.log(`${a.username}: ${err.message}`, 'error'); skipped.push(a.username); }
      }
      return { label, archived, pruned, skipped };
    },
  };

  return {
    summary: (user) => visibleAccounts(user).map(summary),
    renderTemplate, templatePath: (name) => { if (!TEMPLATE_NAMES.includes(name)) throw notFound(`Template "${name}"`); return `${TEMPLATE_DIR}/${name}.html`; }, templates, changeIp, recipients, emailAll, runEmailAll,
    forcePasswordChange, setDemoMode,
    setBandwidthLimit, resetBandwidth, exceeders, unsuspendExceeders, runBandwidthEnforce, runMonthlyBandwidthReset,
    bandwidthEnforcement, setBandwidthEnforcement, syncEnforcementSchedule,
    setShell, setQuota, quotaReport, logs, rearrange, logRetention, mountpointFor,
    HOME_ROOTS, TEMPLATE_NAMES, TEMPLATE_USAGE, SHELLS, VHOST_WARNINGS, brandingVars,
  };
}
