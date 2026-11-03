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

  // Always the reseller-shaped dropdown: a root-owned account delegates as root,
  // whose answer carries binaries, ini paths and units the customer must not see.
  async function versions(scope) {
    const result = await software().php.versions({ user: scope.ownerPrincipal });
    const allowed = planVersions(scope);
    const list = (result.versions || []).filter((v) => !allowed || allowed.includes(v.id)).map((v) => ({ id: v.id, label: v.label, version: v.version, isDefault: v.id === result.effectiveDefault, advisories: v.advisories ?? [] }));
    return { versions: list, defaultId: result.effectiveDefault ?? result.defaultId ?? null, planDefault: scope.account?.plan?.php_version ?? null, restricted: Boolean(allowed) };
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
      if (version != null) {
        const { versions: allowed } = await versions(scope);
        if (!allowed.some((v) => v.id === version)) throw unprocessable(`PHP "${version}" is not available for this account`, { version: ['Pick one of the offered versions'] });
      }
      const result = await software().php.setDomainVersion([domain], version, scope.ownerPrincipal, req);
      const entry = result.results?.find((r) => r.domain === domain) ?? null;
      audit(req, { action: 'panel.php.version', target: scope.username, args: auditArgs(scope, { domain, version, web: entry?.web ?? null }) });
      return { domain, phpVersion: version, web: entry?.web ?? null };
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
