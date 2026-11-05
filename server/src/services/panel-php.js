import { HttpError, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

const WEB_TYPES = ['main', 'addon', 'sub'];

// PHP version per domain and the .user.ini editor (design §4.12). The delegate
// (ctx.software) does not know the plan, so the version choice is checked here:
// an installed version, restricted to plan.php_versions when the package lists any.
export function createPanelPhpService(ctx) {
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const software = () => { if (!ctx.software?.php) throw new HttpError(503, 'service_unavailable', 'The Software category is not loaded'); return ctx.software; };
  const domains = () => { if (!ctx.panelDomains) throw new HttpError(503, 'service_unavailable', 'The panel domains service is not loaded'); return ctx.panelDomains; };

  const planVersions = (scope) => {
    const list = scope.account?.plan?.php_versions;
    return Array.isArray(list) && list.length ? list.map(String) : null;
  };

  const webDomains = (scope) => domains().allDomains(scope).filter((r) => WEB_TYPES.includes(r.type));
  const usageOf = (scope) => {
    const usage = {};
    for (const r of webDomains(scope)) if (r.php_version) usage[r.php_version] = (usage[r.php_version] ?? 0) + 1;
    return usage;
  };

  // Always the reseller-shaped dropdown: a root-owned account delegates as root,
  // whose answer carries binaries, ini paths and units the customer must not see.
  // The root's offered list (contract §52) narrows it further; a version one of
  // this account's domains is already pinned to stays listed as `legacy` so the
  // picker never shows a blank.
  async function versions(scope) {
    const result = await software().php.versions({ user: scope.ownerPrincipal });
    const allowed = planVersions(scope);
    const offered = software().php.offeredVersions?.() ?? null;
    const usage = usageOf(scope);
    const selectable = (id) => (!allowed || allowed.includes(id)) && (!offered || offered.includes(id));
    const list = (result.versions || []).filter((v) => selectable(v.id) || usage[v.id]).map((v) => ({ id: v.id, label: v.label, version: v.version, isDefault: v.id === result.effectiveDefault, advisories: v.advisories ?? [], usage: usage[v.id] ?? 0, legacy: !selectable(v.id) }));
    // The agent lists versions in readdir order (oldest first); the pick is the newest.
    const num = (v) => String(v.version || v.id).replace(/[^0-9.]/g, '').split('.').map(Number);
    const newest = [...list].sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; });
    const recommended = newest.find((v) => !v.legacy && !v.advisories.some((a) => a.severity === 'critical'))?.id ?? newest.find((v) => !v.legacy)?.id ?? null;
    return { versions: list, defaultId: result.effectiveDefault ?? result.defaultId ?? null, planDefault: scope.account?.plan?.php_version ?? null, restricted: Boolean(allowed), offered: offered !== null, usage, recommended };
  }

  async function assertSelectable(scope, version) {
    const { versions: allowed } = await versions(scope);
    if (!allowed.some((v) => v.id === version && !v.legacy)) throw unprocessable(`PHP "${version}" is not available for this account`, { version: ['Pick one of the offered versions'] });
  }

  return {
    versions(scope) {
      assertFeature(scope, 'phpversion');
      return versions(scope);
    },

    async domains(scope) {
      assertFeature(scope, 'phpversion');
      const result = await software().php.domains(scope.ownerPrincipal, { account: scope.username, pageSize: 500 });
      const rows = (result.data?.domains || []).filter((d) => d.accountId === scope.accountId).map((d) => ({ domain: d.domain, type: d.type, docroot: d.docroot, phpVersion: d.phpVersion, effective: d.effective, inherited: d.inherited }));
      return { systemDefault: result.data?.systemDefault?.effective ?? null, domains: rows };
    },

    async setVersion(scope, domain, version, req) {
      assertFeature(scope, 'phpversion');
      domains().assertDomain(scope, domain, WEB_TYPES);
      if (version != null) await assertSelectable(scope, version);
      const result = await software().php.setDomainVersion([domain], version, scope.ownerPrincipal, req);
      const entry = result.results?.find((r) => r.domain === domain) ?? null;
      audit(req, { action: 'panel.php.version', target: scope.username, args: auditArgs(scope, { domain, version, web: entry?.web ?? null }) });
      return { domain, phpVersion: version, web: entry?.web ?? null };
    },

    // One version for every web hostname of the account (or the given subset);
    // the delegate records the rows at once and applies a batch through a job.
    async setAll(scope, version, { domains: subset } = {}, req) {
      assertFeature(scope, 'phpversion');
      const list = subset?.length ? [...new Set(subset)].map((d) => domains().assertDomain(scope, d, WEB_TYPES).domain) : webDomains(scope).map((r) => r.domain);
      if (version != null) await assertSelectable(scope, version);
      const result = await software().php.setDomainVersion(list, version, scope.ownerPrincipal, req);
      const results = (result.results || []).map((r) => ({ domain: r.domain, phpVersion: r.phpVersion ?? version, web: r.web ?? null }));
      audit(req, { action: 'panel.php.version_all', target: scope.username, args: auditArgs(scope, { domains: list, version, jobId: result.job?.id ?? null }) });
      return { domains: list, phpVersion: version, job: result.job ? { id: result.job.id } : null, results };
    },

    async readIni(scope, domain) {
      assertFeature(scope, 'phpversion');
      domains().assertDomain(scope, domain, WEB_TYPES);
      const result = await software().ini.readDomain(domain, scope.ownerPrincipal);
      return { domain, path: result.path ?? null, exists: result.exists ?? null, directives: result.directives ?? {}, basic: result.basic ?? {}, content: result.content ?? null };
    },

    async writeIni(scope, domain, { directives }, req) {
      assertFeature(scope, 'phpversion');
      domains().assertDomain(scope, domain, WEB_TYPES);
      const result = await software().ini.writeDomain(domain, { directives }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.php.userini', target: scope.username, args: auditArgs(scope, { domain, directives: Object.keys(directives) }) });
      return { domain, path: result.path ?? null, directives: result.directives ?? {}, basic: result.basic ?? {} };
    },
  };
}
