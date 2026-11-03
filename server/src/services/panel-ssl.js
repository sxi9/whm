import { HttpError, CapabilityError, notFound, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

export const DOWNLOAD_PARTS = ['cert', 'csr', 'chain', 'fullchain'];

// SSL for one account (design §4.4): status per hostname, AutoSSL "issue now"
// (never forced), own-certificate install and the storage manager. Every cert
// id is matched against ssl_certs.account_id before ctx.ssl sees it, because
// ssl.visible() is owner-level.
export function createPanelSslService(ctx) {
  const { db } = ctx;
  const stmts = {
    certAccount: db.prepare('SELECT id, account_id, domain, installed FROM ssl_certs WHERE id = ?'),
  };
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const ssl = () => { if (!ctx.ssl) throw new HttpError(503, 'service_unavailable', 'The SSL category is not loaded'); return ctx.ssl; };
  const domains = () => { if (!ctx.panelDomains) throw new HttpError(503, 'service_unavailable', 'The panel domains service is not loaded'); return ctx.panelDomains; };

  // A hostname the account answers for, or a wildcard / deeper name under one.
  function assertCoveredName(scope, name) {
    const base = name.replace(/^\*\./, '');
    const owned = new Set(domains().allDomains(scope).map((d) => d.domain));
    const labels = base.split('.');
    for (let i = 0; i < labels.length - 1; i++) if (owned.has(labels.slice(i).join('.'))) return base;
    throw notFound(`Domain "${name}"`);
  }

  function assertOwnCert(scope, id) {
    const row = stmts.certAccount.get(id);
    if (!row || row.account_id !== scope.accountId) throw notFound('Certificate');
    return row;
  }

  const trimHost = (h) => (h ? { id: h.id, domain: h.domain, state: h.state, installed: h.installed, subject: h.subject, issuer: h.issuer, notBefore: h.notBefore, notAfter: h.notAfter, daysRemaining: h.daysRemaining, expired: h.expired, autossl: h.autossl, selfSigned: h.selfSigned, files: h.files ?? null } : null);

  return {
    async domains(scope) {
      assertFeature(scope, 'sslmanager');
      const list = domains().allDomains(scope);
      let hosts = [];
      try { hosts = (await ssl().hosts.list(scope.ownerPrincipal)).hosts.filter((h) => h.accountId === scope.accountId); } catch (err) { if (!(err instanceof HttpError) && !err?.agentError) throw err; }
      const settings = ssl().autossl.settings();
      // Seam S8: ctx.ssl.autossl.lastEntryFor(domain) reads ssl_autossl_runs.entries_json.
      const lastEntry = typeof ctx.ssl.autossl?.lastEntryFor === 'function' ? (d) => ctx.ssl.autossl.lastEntryFor(d) : () => null;
      const out = list.filter((d) => ['main', 'addon', 'sub', 'parked', 'alias'].includes(d.type)).map((d) => {
        const host = hosts.find((h) => h.domain === d.domain) || null;
        const cert = host ? trimHost(host) : trimHost(ssl().certForDomain(d.domain));
        return { domain: d.domain, type: d.type, docroot: d.docroot, certificate: cert, autossl: lastEntry(d.domain) };
      });
      return { domains: out, autossl: { provider: settings.provider, enabled: settings.provider !== 'disabled', includeWww: settings.includeWww }, webLinked: typeof ctx.web?.applySsl === 'function' };
    },

    async get(scope, domain) {
      assertFeature(scope, 'sslmanager');
      domains().assertDomain(scope, domain);
      return ssl().hosts.get(domain, scope.ownerPrincipal);
    },

    async issue(scope, domain, req) {
      assertFeature(scope, 'autossl');
      domains().assertDomain(scope, domain, ['main', 'addon', 'sub', 'parked', 'alias']);
      const settings = ssl().autossl.settings();
      if (settings.provider === 'disabled') throw new CapabilityError('acme', 'AutoSSL is not enabled on this server; ask your provider to turn it on');
      const result = await ssl().autossl.issueNow({ domain, force: false }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.issue', target: scope.username, args: auditArgs(scope, { domain, job: result.job?.id ?? null }) });
      return result;
    },

    // Either a stored certificate of this account or a pasted cert + key pair:
    // a pasted cert without its key would make ssl.install search every stored
    // key of the owner, which spans sibling accounts.
    async install(scope, domain, { certId, certPem, keyPem, chainPem }, req) {
      assertFeature(scope, 'sslmanager');
      domains().assertDomain(scope, domain, ['main', 'addon', 'sub', 'parked', 'alias']);
      if (certId != null) assertOwnCert(scope, certId);
      else if (!certPem || !keyPem) throw unprocessable('Paste both the certificate and its private key, or pick a stored certificate', { certPem: certPem ? [] : ['Required'], keyPem: keyPem ? [] : ['Required'] });
      const result = await ssl().install({ domain, ...(certId != null ? { certId } : {}), ...(certPem ? { certPem } : {}), ...(keyPem ? { keyPem } : {}), ...(chainPem ? { chainPem } : {}), force: false }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.install', target: scope.username, args: auditArgs(scope, { domain, certId: certId ?? null, web: result.web }) });
      return { cert: result.cert, certificate: result.certificate, web: result.web, webDetail: result.webDetail ?? null };
    },

    async uninstall(scope, domain, req) {
      assertFeature(scope, 'sslmanager');
      domains().assertDomain(scope, domain, ['main', 'addon', 'sub', 'parked', 'alias']);
      const result = await ssl().uninstall(domain, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.uninstall', target: scope.username, args: auditArgs(scope, { domain, web: result.web }) });
      return { domain, removed: result.removed, web: result.web, cert: result.cert };
    },

    certs(scope, query = {}) {
      assertFeature(scope, 'sslmanager');
      const result = ssl().certs.list({ ...query, account: scope.username }, scope.ownerPrincipal);
      return { ...result, data: result.data.filter((c) => c.accountId === scope.accountId) };
    },

    storage(scope) {
      assertFeature(scope, 'sslmanager');
      const result = ssl().storage.list(scope.ownerPrincipal, { account: scope.username });
      const items = result.items.filter((i) => i.accountId === scope.accountId);
      return { items, counts: { key: items.filter((i) => i.kind === 'key').length, csr: items.filter((i) => i.kind === 'csr').length, cert: items.filter((i) => i.kind === 'cert').length } };
    },

    async generateCsr(scope, input, req) {
      assertFeature(scope, 'sslmanager');
      assertCoveredName(scope, input.domain);
      const result = await ssl().certs.generateCsr({ ...input, account: scope.username }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.csr', target: scope.username, args: auditArgs(scope, { domain: input.domain, sans: input.sans ?? [] }) });
      return result;
    },

    async generateSelfSigned(scope, input, req) {
      assertFeature(scope, 'sslmanager');
      assertCoveredName(scope, input.domain);
      const result = await ssl().certs.generateSelfSigned({ ...input, account: scope.username }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.self_signed', target: scope.username, args: auditArgs(scope, { domain: input.domain, days: input.days }) });
      return result;
    },

    async upload(scope, input, req) {
      assertFeature(scope, 'sslmanager');
      if (input.domain) assertCoveredName(scope, input.domain);
      const result = await ssl().certs.upload({ ...input, account: scope.username }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.upload', target: scope.username, args: auditArgs(scope, { domain: result.cert?.domain ?? input.domain ?? null, parts: { cert: Boolean(input.certPem), key: Boolean(input.keyPem), chain: Boolean(input.chainPem), csr: Boolean(input.csrPem) } }) });
      return result;
    },

    // The private key never leaves the server through the customer panel.
    download(scope, id, part, req) {
      assertFeature(scope, 'sslmanager');
      if (!DOWNLOAD_PARTS.includes(part)) throw unprocessable('That part cannot be downloaded', { part: [`One of ${DOWNLOAD_PARTS.join(', ')}`] });
      assertOwnCert(scope, id);
      return ssl().certs.download(id, part, scope.ownerPrincipal, req);
    },

    remove(scope, id, req) {
      assertFeature(scope, 'sslmanager');
      const row = assertOwnCert(scope, id);
      const result = ssl().certs.remove(id, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.ssl.storage.delete', target: scope.username, args: auditArgs(scope, { id, domain: row.domain }) });
      return result;
    },
  };
}
