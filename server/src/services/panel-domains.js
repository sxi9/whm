import path from 'node:path';
import { HttpError, notFound, forbidden, unprocessable } from '../lib/errors.js';

// Customer-panel helpers shared by the panel-* services of this unit. Every
// method takes the pinned scope from ctx.panel.scope(req) (design §3.1) and
// delegates with scope.ownerPrincipal after its own account-level checks (§3.2,
// §3.3): the delegates' ownership checks are owner-level, so two accounts of
// the same owner would otherwise look identical to them.

// Package feature keys missing from the plan default to enabled (cPanel semantics).
export function assertFeature(scope, key) {
  const features = scope.features || scope.account?.plan?.features || {};
  if (features[key] === false) throw new HttpError(403, 'feature_disabled', `The "${key}" feature is not enabled for this account`);
}

// The highest of the plan value and any enhancement (ctx.accountInfo.effectiveLimits);
// null means unlimited, as in packages.
export function limitOf(scope, key) {
  const plan = scope.account?.plan?.[key];
  const extra = scope.limits?.[key];
  const values = [plan, extra].filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!values.length) return null;
  return Math.max(...values);
}

export function assertLimit(scope, key, count, label) {
  const limit = limitOf(scope, key);
  if (limit != null && limit >= 0 && count >= limit) throw new HttpError(409, 'limit_reached', `This account's plan allows ${limit} ${label}`);
}

// Audit args always say who really acted (§2.4).
export function auditArgs(scope, args = {}) {
  if (scope.mode !== 'acting' || !scope.actingAs) return args;
  return { ...args, actingAs: scope.username, by: scope.actingAs.by ?? scope.actor?.username ?? null };
}

export const SYSTEM_ROOT = { id: null, username: 'panel', role: 'root' };

export const SUB_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const REL_PATH = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,512}$/;

export const homeOf = (ctx, account) => account.home_dir || `${ctx.settings?.get?.('basic.home_root') || '/home'}/${account.username}`;

// A document root given relative to public_html, resolved and pinned under the home.
export function resolveDocroot(ctx, account, rel) {
  const home = path.resolve(homeOf(ctx, account));
  const target = path.resolve(home, 'public_html', rel);
  if (target !== home && !target.startsWith(`${home}/`)) throw unprocessable('The document root must stay inside the account home', { docroot: ['Must be a path under public_html'] });
  return target;
}

export function createPanelDomainsService(ctx) {
  const { db, logger } = ctx;
  const agent = () => ctx.agent;
  const stmts = {
    domainsOf: db.prepare('SELECT id, domain, type, docroot, php_version, created_at FROM account_domains WHERE account_id = ? ORDER BY type, domain'),
    rowOf: db.prepare('SELECT * FROM account_domains WHERE domain = ? AND account_id = ?'),
    countType: db.prepare('SELECT COUNT(*) AS n FROM account_domains WHERE account_id = ? AND type = ?'),
    countParked: db.prepare("SELECT COUNT(*) AS n FROM account_domains WHERE account_id = ? AND type IN ('parked', 'alias')"),
    // Hosted anywhere on this server: a main domain, any account's domain row, or a
    // zone that is not this account's.
    hosted: db.prepare(`SELECT 1 FROM accounts WHERE domain = @domain
      UNION SELECT 1 FROM account_domains WHERE domain = @domain
      UNION SELECT 1 FROM dns_zones WHERE domain = @domain AND (account_id IS NULL OR account_id <> @accountId)`),
    // A hostname of another account (main or any row): names under it are refused.
    foreignDomain: db.prepare(`SELECT 1 FROM accounts WHERE domain = @domain AND id <> @accountId
      UNION SELECT 1 FROM account_domains WHERE domain = @domain AND account_id <> @accountId`),
    insert: db.prepare('INSERT INTO account_domains (account_id, domain, type, docroot) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM account_domains WHERE id = ? AND account_id = ?'),
    zoneOf: db.prepare('SELECT id, domain, account_id FROM dns_zones WHERE domain = ? AND account_id = ?'),
    deleteMailDomain: db.prepare('DELETE FROM mail_domains WHERE domain = ? AND account_id = ?'),
    forwarding: db.prepare('SELECT domain, target_url, type, match_www, keep_path, status, last_error, updated_at FROM domain_forwarding WHERE domain = ? AND account_id = ?'),
  };

  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const isCapabilityMissing = (err) => err?.code === 'capability_missing';

  // Every hostname this account answers for: the main domain plus its rows.
  function allDomains(scope) {
    const rows = stmts.domainsOf.all(scope.accountId);
    if (!rows.some((r) => r.type === 'main')) rows.unshift({ id: null, domain: scope.account.domain, type: 'main', docroot: `${homeOf(ctx, scope.account)}/public_html`, php_version: null, created_at: scope.account.created_at ?? null });
    return rows;
  }

  // The account's row for a hostname, or 404 (never 403: a foreign name must look absent).
  function assertDomain(scope, domain, types = null) {
    const row = allDomains(scope).find((r) => r.domain === domain);
    if (!row || (types && !types.includes(row.type))) throw notFound(`Domain "${domain}"`);
    return row;
  }

  const systemUser = (scope) => scope.account.uid != null;

  async function mkdirAsUser(scope, dir, req) {
    if (!systemUser(scope)) return { created: false, reason: 'no_system_user' };
    await agent().op('files.mkdir', { username: scope.username, path: dir, mode: '0750' }, { req });
    return { created: true };
  }

  async function removeDocrootAsUser(scope, docroot, req) {
    const home = path.resolve(homeOf(ctx, scope.account));
    const target = path.resolve(docroot);
    if (!systemUser(scope)) return { removed: false, reason: 'no_system_user' };
    if (target === home || target === `${home}/public_html` || !target.startsWith(`${home}/public_html/`)) return { removed: false, reason: 'protected' };
    await agent().op('files.remove', { username: scope.username, paths: [target] }, { req });
    return { removed: true };
  }

  // A hostname inside another account's zone or under another account's
  // domain (www.victim.com) is that account's to serve: BIND would answer the
  // more specific zone, Apache the new vhost and Exim the new mail route.
  const foreignParent = (scope, domain) => {
    const zone = typeof ctx.dns?.zoneFor === 'function' ? ctx.dns.zoneFor(domain) : null;
    if (zone && zone.account_id !== scope.accountId) return zone.domain;
    const labels = domain.split('.');
    for (let i = 1; i < labels.length - 1; i += 1) {
      const parent = labels.slice(i).join('.');
      if (stmts.foreignDomain.get({ domain: parent, accountId: scope.accountId })) return parent;
    }
    return null;
  };
  function assertNotHosted(scope, domain) {
    if (domain === scope.account.domain || stmts.hosted.get({ domain, accountId: scope.accountId })) throw new HttpError(409, 'exists', `${domain} is already hosted on this server`);
    const parent = foreignParent(scope, domain);
    if (parent) throw new HttpError(409, 'exists', `${domain} is part of ${parent}, which is hosted by another account on this server`);
  }

  // ctx.web.ensureVhost answers with reason codes; the customer reads sentences.
  const WEB_REASONS = {
    capability_missing: 'The web server is not installed on this server yet; the site is served as soon as it is.',
    php_missing: 'PHP is not installed; the site is served without PHP until it is.',
    php_pool_failed: 'The PHP pool for this site could not be started; ask your hosting provider.',
  };
  const webReason = (code) => WEB_REASONS[code] || 'The web server has not applied the change yet; it is retried automatically.';

  async function syncWeb(scope, req, warnings) {
    if (typeof ctx.web?.ensureVhost !== 'function') { warnings.push('The web server category is not loaded; the vhost is written once it is'); return { applied: false, reason: 'web_unavailable' }; }
    try {
      const r = await ctx.web.ensureVhost(scope.username, req);
      if (!r.applied && r.reason) warnings.push(webReason(r.reason));
      return { applied: Boolean(r.applied), reason: r.reason ?? null };
    } catch (err) {
      logger.warn({ err, username: scope.username }, 'panel: vhost sync failed');
      warnings.push(`Web server: ${err.message}`);
      return { applied: false, reason: err.code || 'error' };
    }
  }

  // Seam S1: ctx.web.removeVhost(domain, req). Until it lands the vhost row is
  // re-synced from the remaining account_domains rows, which drops the spec of
  // the removed name from the next render but leaves its file for the integrator's op.
  async function dropVhost(scope, domain, req, warnings) {
    try {
      if (typeof ctx.web?.removeVhost === 'function') { await ctx.web.removeVhost(domain, req); return { removed: true }; }
      warnings.push(`The vhost of ${domain} is left in place until the web server category can remove it`);
      return { removed: false, reason: 'seam_pending' };
    } catch (err) {
      if (!isCapabilityMissing(err)) logger.warn({ err, domain }, 'panel: vhost removal failed');
      warnings.push(`Web server: ${err.message}`);
      return { removed: false, reason: err.code || 'error' };
    }
  }

  async function setRouting(domain, req, warnings) {
    if (typeof ctx.mail?.setRouting !== 'function') return { applied: false, reason: 'mail_unavailable' };
    try {
      const r = await ctx.mail.setRouting(domain, 'local', req);
      return { applied: Boolean(r.applied), reason: r.reason ?? null };
    } catch (err) {
      if (!(err instanceof HttpError) && !err?.agentError) throw err;
      warnings.push(`Mail routing for ${domain} was saved but not applied: ${err.message}`);
      return { applied: false, reason: err.code || 'error' };
    }
  }

  // The hostname's mail objects (forwarders, autoresponders, passwd/alias
  // files) leave with it. A host write that fails keeps the rows, which then
  // block the next owner (409 domain_stale) until root releases them; that is
  // reported, never a reason to keep the domain.
  async function releaseMail(scope, domain, req, warnings) {
    if (typeof ctx.panelEmail?.releaseDomain !== 'function') return { released: false, reason: 'email_unavailable' };
    try {
      const r = await ctx.panelEmail.releaseDomain(domain, scope.accountId, req, { username: scope.username });
      if (!r.released) warnings.push(`Mail: the settings of ${domain} were not fully removed from the server (${(r.errors || []).map((e) => e.op).join(', ') || 'host error'}); ask your provider to release the domain`);
      return { released: Boolean(r.released), errors: (r.errors || []).map((e) => ({ op: e.op, code: e.code ?? null, message: e.message })) };
    } catch (err) {
      warnings.push(`Mail: ${err.message}`);
      return { released: false, reason: err.code ?? 'error', errors: [{ op: null, code: err.code ?? null, message: err.message }] };
    }
  }

  async function dnsRecordsFor(scope, fqdn, values, req, warnings) {
    const zone = ctx.dns?.zoneFor?.(fqdn);
    if (!zone || zone.account_id !== scope.accountId) { warnings.push(`No DNS zone of this account contains ${fqdn}; add the records yourself`); return { applied: false, reason: 'no_zone' }; }
    try {
      const a = await ctx.dns.upsertRecords(zone.domain, fqdn, 'A', values.ipv4, req);
      if (values.ipv6) await ctx.dns.upsertRecords(zone.domain, fqdn, 'AAAA', values.ipv6, req);
      return { zone: zone.domain, applied: Boolean(a?.applied ?? true) };
    } catch (err) {
      if (!(err instanceof HttpError) && !err?.agentError) throw err;
      warnings.push(`DNS: ${err.message}`);
      return { zone: zone.domain, applied: false, reason: err.code || 'error' };
    }
  }

  const shapeForwarding = (r) => (r ? { domain: r.domain, targetUrl: r.target_url, type: r.type, matchWww: Boolean(r.match_www), keepPath: Boolean(r.keep_path), status: r.status, lastError: r.last_error, updatedAt: r.updated_at } : null);

  function shapeDomain(row) {
    const vhost = typeof ctx.web?.vhostFor === 'function' ? ctx.web.vhostFor(row.domain) : null;
    const cert = typeof ctx.ssl?.certForDomain === 'function' ? ctx.ssl.certForDomain(row.domain) : null;
    return {
      id: row.id, domain: row.domain, type: row.type, docroot: row.docroot, phpVersion: row.php_version ?? null, createdAt: row.created_at ?? null,
      vhost: vhost ? { status: vhost.status ?? null, error: vhost.error ?? null, ip: vhost.ip ?? null, ipv6: vhost.ipv6 ?? null, aliases: vhost.aliases ?? [] } : null,
      ssl: cert ? { installed: cert.state === 'installed', state: cert.state, issuer: cert.issuer, notAfter: cert.notAfter, daysRemaining: cert.daysRemaining, autossl: cert.autossl, selfSigned: cert.selfSigned } : null,
    };
  }

  return {
    allDomains,
    assertDomain,

    list(scope, { type } = {}) {
      const rows = allDomains(scope).filter((r) => !type || (type === 'parked' ? ['parked', 'alias'].includes(r.type) : r.type === type));
      const counts = { main: 1, addon: stmts.countType.get(scope.accountId, 'addon').n, sub: stmts.countType.get(scope.accountId, 'sub').n, parked: stmts.countParked.get(scope.accountId).n };
      return { data: rows.map(shapeDomain), meta: { counts, limits: { max_addons: limitOf(scope, 'max_addons'), max_subdomains: limitOf(scope, 'max_subdomains'), max_parked: limitOf(scope, 'max_parked') } } };
    },

    async addAddon(scope, { domain, docroot: rel, createZone = true }, req) {
      assertFeature(scope, 'addondomains');
      assertLimit(scope, 'max_addons', stmts.countType.get(scope.accountId, 'addon').n, 'addon domain(s)');
      assertNotHosted(scope, domain);
      const docroot = resolveDocroot(ctx, scope.account, rel || domain);
      const warnings = [];
      let zone = null;
      if (createZone) {
        if (typeof ctx.dns?.ensureZoneForDomain !== 'function') warnings.push('The DNS category is not loaded; no zone was created');
        else zone = await ctx.dns.ensureZoneForDomain(domain, { ip: scope.account.ip, accountId: scope.accountId, nameservers: ctx.resellers?.nameserversFor?.(scope.account.owner_id) }, req);
      }
      let dir;
      try {
        dir = await mkdirAsUser(scope, docroot, req);
        stmts.insert.run(scope.accountId, domain, 'addon', docroot);
      } catch (err) {
        if (zone?.created && typeof ctx.dns?.deleteZone === 'function') {
          try { await ctx.dns.deleteZone(domain, scope.ownerPrincipal, req); } catch (cleanupErr) { logger.warn({ err: cleanupErr, domain }, 'panel: could not remove the zone of a failed addon'); }
        }
        throw err;
      }
      const mail = await setRouting(domain, req, warnings);
      const web = await syncWeb(scope, req, warnings);
      audit(req, { action: 'panel.domains.addon.add', target: scope.username, args: auditArgs(scope, { domain, docroot, createZone, zone: zone ? { created: zone.created, applied: zone.applied } : null, web: web.applied, mail: mail.applied }) });
      return { data: { ...shapeDomain(stmts.rowOf.get(domain, scope.accountId)), zone: zone ? { domain, created: Boolean(zone.created), applied: Boolean(zone.applied), reason: zone.reason ?? null } : null, docrootCreated: dir.created, web, mail }, meta: { warnings } };
    },

    async removeAddon(scope, domain, { removeZone = true, removeDocroot = false } = {}, req) {
      assertFeature(scope, 'addondomains');
      const row = assertDomain(scope, domain, ['addon']);
      const warnings = [];
      let ssl = null;
      const cert = typeof ctx.ssl?.certForDomain === 'function' ? ctx.ssl.certForDomain(domain) : null;
      if (cert && cert.state !== 'stored' && typeof ctx.ssl?.uninstall === 'function') {
        try { ssl = await ctx.ssl.uninstall(domain, scope.ownerPrincipal, req); } catch (err) { warnings.push(`SSL: ${err.message}`); }
      }
      const web = await dropVhost(scope, domain, req, warnings);
      let zone = { removed: false };
      if (removeZone && stmts.zoneOf.get(domain, scope.accountId) && typeof ctx.dns?.deleteZone === 'function') {
        try { await ctx.dns.deleteZone(domain, scope.ownerPrincipal, req); zone = { removed: true }; } catch (err) { if (!(err instanceof HttpError) && !err?.agentError) throw err; warnings.push(`DNS: ${err.message}`); zone = { removed: false, reason: err.code }; }
      }
      if (stmts.forwarding.get(domain, scope.accountId) && typeof ctx.dns?.removeForwarding === 'function') {
        try { await ctx.dns.removeForwarding(domain, scope.ownerPrincipal, req); } catch (err) { warnings.push(`Redirect: ${err.message}`); }
      }
      const mail = await releaseMail(scope, domain, req, warnings);
      db.transaction(() => { stmts.remove.run(row.id, scope.accountId); stmts.deleteMailDomain.run(domain, scope.accountId); })();
      let docroot = { removed: false };
      if (removeDocroot && row.docroot) {
        try { docroot = await removeDocrootAsUser(scope, row.docroot, req); } catch (err) { warnings.push(`Document root: ${err.message}`); }
      }
      audit(req, { action: 'panel.domains.addon.remove', target: scope.username, args: auditArgs(scope, { domain, removeZone, removeDocroot, zoneRemoved: zone.removed, docrootRemoved: docroot.removed, mailReleased: mail.released }) });
      return { data: { domain, removed: true, zone, web, ssl: ssl ? { removed: ssl.removed } : null, docroot, mail }, meta: { warnings } };
    },

    async addSub(scope, { label, parent, docroot: rel }, req) {
      assertFeature(scope, 'subdomains');
      assertLimit(scope, 'max_subdomains', stmts.countType.get(scope.accountId, 'sub').n, 'subdomain(s)');
      if (!SUB_LABEL.test(label)) throw unprocessable('Invalid subdomain label', { label: ['Letters, digits and "-", max 63 chars'] });
      assertDomain(scope, parent, ['main', 'addon']);
      const fqdn = `${label}.${parent}`;
      if (fqdn.length > 253) throw unprocessable('The subdomain name is too long', { label: ['The full name exceeds 253 characters'] });
      if (stmts.hosted.get({ domain: fqdn, accountId: scope.accountId })) throw new HttpError(409, 'exists', `${fqdn} already exists`);
      const docroot = resolveDocroot(ctx, scope.account, rel || label);
      const warnings = [];
      const dir = await mkdirAsUser(scope, docroot, req);
      stmts.insert.run(scope.accountId, fqdn, 'sub', docroot);
      const dns = await dnsRecordsFor(scope, fqdn, { ipv4: scope.account.ip ? [{ value: scope.account.ip }] : [], ipv6: scope.account.ipv6 ? [{ value: scope.account.ipv6 }] : null }, req, warnings);
      const web = await syncWeb(scope, req, warnings);
      audit(req, { action: 'panel.domains.sub.add', target: scope.username, args: auditArgs(scope, { domain: fqdn, parent, docroot, dns: dns.applied, web: web.applied }) });
      return { data: { ...shapeDomain(stmts.rowOf.get(fqdn, scope.accountId)), parent, docrootCreated: dir.created, dns, web }, meta: { warnings } };
    },

    async removeSub(scope, domain, { removeDocroot = false } = {}, req) {
      assertFeature(scope, 'subdomains');
      const row = assertDomain(scope, domain, ['sub']);
      const warnings = [];
      const web = await dropVhost(scope, domain, req, warnings);
      const dns = await dnsRecordsFor(scope, domain, { ipv4: [], ipv6: [] }, req, warnings);
      const mail = await releaseMail(scope, domain, req, warnings);
      db.transaction(() => { stmts.remove.run(row.id, scope.accountId); stmts.deleteMailDomain.run(domain, scope.accountId); })();
      let docroot = { removed: false };
      if (removeDocroot && row.docroot) {
        try { docroot = await removeDocrootAsUser(scope, row.docroot, req); } catch (err) { warnings.push(`Document root: ${err.message}`); }
      }
      audit(req, { action: 'panel.domains.sub.remove', target: scope.username, args: auditArgs(scope, { domain, removeDocroot, docrootRemoved: docroot.removed, mailReleased: mail.released }) });
      return { data: { domain, removed: true, dns, web, docroot, mail }, meta: { warnings } };
    },

    async addParked(scope, { domain, createZone = true }, req) {
      assertFeature(scope, 'parkeddomains');
      assertLimit(scope, 'max_parked', stmts.countParked.get(scope.accountId).n, 'parked domain(s)');
      assertNotHosted(scope, domain);
      if (typeof ctx.dns?.parkDomain !== 'function') throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded');
      const result = await ctx.dns.parkDomain({ domain, account: scope.username, createZone }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.domains.parked.add', target: scope.username, args: auditArgs(scope, { domain, createZone, web: result.web }) });
      return { domain, type: 'parked', target: result.target, docroot: result.docroot, zone: result.zone, web: result.web, webDetail: result.webDetail ?? null };
    },

    async removeParked(scope, domain, { removeZone = true } = {}, req) {
      assertFeature(scope, 'parkeddomains');
      assertDomain(scope, domain, ['parked', 'alias']);
      if (typeof ctx.dns?.unparkDomain !== 'function') throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded');
      const warnings = [];
      const mail = await releaseMail(scope, domain, req, warnings);
      const result = await ctx.dns.unparkDomain(domain, { removeZone }, scope.ownerPrincipal, req);
      stmts.deleteMailDomain.run(domain, scope.accountId);
      audit(req, { action: 'panel.domains.parked.remove', target: scope.username, args: auditArgs(scope, { domain, removeZone, zoneRemoved: result.zoneRemoved, mailReleased: mail.released }) });
      return { data: { domain, removed: true, zoneRemoved: result.zoneRemoved, web: result.web, mail }, meta: { warnings } };
    },

    getRedirect(scope, domain) {
      assertFeature(scope, 'redirects');
      assertDomain(scope, domain);
      return { domain, redirect: shapeForwarding(stmts.forwarding.get(domain, scope.accountId)), webSupported: typeof ctx.web?.setRedirects === 'function' };
    },

    async setRedirect(scope, domain, input, req) {
      assertFeature(scope, 'redirects');
      assertDomain(scope, domain);
      if (typeof ctx.dns?.setForwarding !== 'function') throw new HttpError(503, 'service_unavailable', 'The DNS category is not loaded');
      await ctx.dns.setForwarding(domain, { targetUrl: input.targetUrl, type: input.type, matchWww: input.matchWww, keepPath: input.keepPath }, scope.ownerPrincipal, req);
      const row = stmts.forwarding.get(domain, scope.accountId);
      if (!row) throw forbidden('The redirect was not recorded for this account');
      audit(req, { action: 'panel.domains.redirect.set', target: scope.username, args: auditArgs(scope, { domain, targetUrl: row.target_url, type: row.type, status: row.status }) });
      return { domain, redirect: shapeForwarding(row) };
    },

    async removeRedirect(scope, domain, req) {
      assertFeature(scope, 'redirects');
      assertDomain(scope, domain);
      if (!stmts.forwarding.get(domain, scope.accountId)) throw notFound(`Redirect for ${domain}`);
      const result = await ctx.dns.removeForwarding(domain, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.domains.redirect.remove', target: scope.username, args: auditArgs(scope, { domain, web: result.web }) });
      return { domain, removed: true, web: result.web };
    },
  };
}
