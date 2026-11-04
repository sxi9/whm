import { HttpError, notFound } from '../lib/errors.js';
import { domainLogFile, DOMLOGS_ROOT, NGINX_LOG_DIR } from './account-functions.js';
import { assertFeature, auditArgs, homeOf } from './panel-domains.js';

export const MAX_TAIL_BYTES = 1024 * 1024;

// Raw web logs and bandwidth history for one account (design §4.11). A file is
// only ever addressed by the name the listing produced; the agent reads the
// listed path with the account as owner, so a planted symlink or a foreign
// file under ~/logs is refused on the host as well.
export function createPanelLogsService(ctx) {
  const audit = (req, entry) => (req?.audit ? req.audit(entry) : ctx.auditRecord?.(null, entry));
  const accountFunctions = () => { if (!ctx.accountFunctions?.logs) throw new HttpError(503, 'service_unavailable', 'The Account Functions category is not loaded'); return ctx.accountFunctions; };
  const accountInfo = () => { if (!ctx.accountInfo?.bandwidthHistory) throw new HttpError(503, 'service_unavailable', 'The Account Information category is not loaded'); return ctx.accountInfo; };
  const ownDomains = (scope) => (ctx.panelDomains?.allDomains ? ctx.panelDomains.allDomains(scope).map((d) => d.domain) : []);
  const serverDirs = (scope) => [`${DOMLOGS_ROOT}/${scope.username}`, NGINX_LOG_DIR];
  const shapeFile = (scope, f) => ({ name: f.name, size: f.size, mtime: f.mtime, location: serverDirs(scope).includes(f.dir) ? 'server' : 'home' });

  // The delegate lists the account's directories; the server-side directories
  // are narrowed to files named after the account's own hostnames.
  async function listing(scope, kind) {
    const result = await accountFunctions().logs.list(scope.username, kind, scope.ownerPrincipal);
    const home = `${homeOf(ctx, scope.account)}/logs`;
    // The delegate lists the main domain once from the account and again from
    // its account_domains row when one exists.
    const domains = [...new Set([...(result.domains || []), ...ownDomains(scope)])];
    const patterns = domains.map((d) => domainLogFile(d));
    const files = (result.files || []).filter((f) => f.dir === home || patterns.some((p) => p.test(f.name)));
    return { ...result, domains, files };
  }

  return {
    async list(scope, { kind = 'apache' } = {}) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      return { kind, domains: result.domains, files: result.files.map((f) => shapeFile(scope, f)), warnings: result.warnings ?? [], apache: result.apache, nginx: result.nginx };
    },

    async tail(scope, { kind = 'apache', file, bytes = 64 * 1024 }, req) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      const entry = result.files.find((f) => f.name === file);
      if (!entry) throw notFound(`Log file "${file}"`);
      const want = Math.min(Math.max(1, bytes), MAX_TAIL_BYTES);
      const size = Number(entry.size) || 0;
      if (size === 0) return { file, size: 0, offset: 0, length: 0, truncated: false, content: '', mtime: entry.mtime ?? null };
      const offset = Math.max(0, size - want);
      const part = await ctx.agent.op('acct.read_range', { path: entry.path, owner: scope.username, offset, length: Math.min(want, size - offset) }, { req });
      let content = Buffer.from(part.data || '', 'base64').toString('utf8');
      if (offset > 0) { const nl = content.indexOf('\n'); if (nl >= 0) content = content.slice(nl + 1); }
      return { file, size: part.size, offset, length: part.length, truncated: offset > 0, content, mtime: part.mtime ?? entry.mtime ?? null };
    },

    async download(scope, { kind = 'apache', file }, req, res) {
      assertFeature(scope, 'rawlog');
      const result = await listing(scope, kind);
      if (!result.files.some((f) => f.name === file)) throw notFound(`Log file "${file}"`);
      audit(req, { action: 'panel.logs.download', target: scope.username, args: auditArgs(scope, { kind, file }) });
      return accountFunctions().logs.download(scope.username, kind, file, scope.ownerPrincipal, req, res);
    },

    bandwidth(scope, { months = 12 } = {}) {
      assertFeature(scope, 'bandwidth');
      const result = accountInfo().bandwidthHistory(scope.username, scope.ownerPrincipal, months);
      return { domain: result.domain, limitMb: result.limitMb, months: result.months, sources: (result.sources || []).map((s) => ({ path: s.path, bytes: s.bytes_processed, lastSeenAt: s.last_seen_at })) };
    },

    retention(scope) {
      assertFeature(scope, 'rawlog');
      const r = accountFunctions().logRetention.get(scope.username, scope.ownerPrincipal);
      return { archiveLogs: r.archive_logs, removeOldArchives: r.remove_old_archives, retainMonths: r.retain_months, lastArchivedAt: r.last_archived_at, archiveDir: r.archive_dir };
    },

    setRetention(scope, { archiveLogs, removeOldArchives }, req) {
      assertFeature(scope, 'rawlog');
      const r = accountFunctions().logRetention.set(scope.username, { archiveLogs, removeOldArchives }, scope.ownerPrincipal, req);
      audit(req, { action: 'panel.logs.retention', target: scope.username, args: auditArgs(scope, { archiveLogs, removeOldArchives }) });
      return { archiveLogs: r.archive_logs, removeOldArchives: r.remove_old_archives, retainMonths: r.retain_months, lastArchivedAt: r.last_archived_at, archiveDir: r.archive_dir };
    },
  };
}
