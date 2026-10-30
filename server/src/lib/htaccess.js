// Account vhosts allow .htaccess only `Options=Indexes,MultiViews,SymLinksIfOwnerMatch,
// IncludesNOEXEC` (agent web.js DOCROOT_ALLOW_OVERRIDE): Apache refuses any other
// Options token whatever its sign, and `All`, so a site brought in from another server
// whose .htaccess still says `Options +FollowSymLinks` (Drupal, Joomla) or
// `Options All -Indexes` answers 500 on every URL with only the domain error log saying
// why. Whenever the panel writes files into an account, it has the agent rewrite
// FollowSymLinks to the equivalent SymLinksIfOwnerMatch in the account's own files and
// names, in the run log and the step, what it cannot fix.
export const HTACCESS_OPTIONS_ALLOWED = 'Indexes, MultiViews, SymLinksIfOwnerMatch, IncludesNOEXEC';

export async function reconcileHtaccess(agent, { roots, username, req, log, label = username }) {
  const paths = [...new Set((roots || []).filter(Boolean))];
  if (!paths.length || !username) return null;
  let r;
  try { r = await agent.op('web.htaccess.audit', { roots: paths, username, fix: true }, { req }); } catch (err) {
    log?.(`${label}: .htaccess Options check skipped: ${err.message}`, 'warn');
    return null;
  }
  const rewritten = Array.isArray(r?.rewritten) ? r.rewritten : [];
  const unsupported = Array.isArray(r?.unsupported) ? r.unsupported : [];
  for (const f of rewritten) log?.(`${label}: ${f.file}: Options FollowSymLinks rewritten to SymLinksIfOwnerMatch (an account .htaccess may not enable FollowSymLinks)`);
  for (const f of unsupported) log?.(`${label}: ${f.file} line ${f.line}: Options ${f.tokens.join(' ')} is not allowed in an account .htaccess (allowed: ${HTACCESS_OPTIONS_ALLOWED}); Apache answers 500 for that directory until the line is changed`, 'warn');
  return { scanned: r?.scanned ?? 0, rewritten: rewritten.map((f) => f.file), unsupported: unsupported.map((f) => ({ file: f.file, line: f.line, tokens: f.tokens })) };
}

export function htaccessSummary(r) {
  if (!r) return '';
  const files = new Set(r.unsupported.map((u) => u.file)).size;
  return `${r.rewritten.length ? `; ${r.rewritten.length} .htaccess FollowSymLinks line(s) rewritten` : ''}${files ? `; ${files} .htaccess file(s) need attention (Options Apache refuses)` : ''}`;
}

export function htaccessFields(r) {
  if (!r) return {};
  return { ...(r.rewritten.length ? { htaccessRewritten: r.rewritten } : {}), ...(r.unsupported.length ? { htaccessUnsupported: r.unsupported } : {}) };
}
