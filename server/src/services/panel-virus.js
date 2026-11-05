import { posix as path } from 'node:path';
import { HttpError, CapabilityError, notFound, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

// Virus scanner of the account panel (design P2-9). One scan is a job that
// runs `sec.clamav.scan_as` as the account itself (clamdscan --fdpass) over
// one of three pinned folders of the home; the account follows its own jobs
// through the same scoped stream the WordPress installer uses. Infected files
// are reported with paths relative to the home so the file manager can open
// them; nothing is quarantined or deleted by the scan. Feature `virusscan`.
//
//   panelVirus.status / start / run / getJob / streamJob / history / removeInfected

export const FEATURE = 'virusscan';
export const JOB_SCAN = 'panel.clamav.scan';
export const JOB_TYPES = [JOB_SCAN];
export const SCAN_SCOPES = Object.freeze({ home: '', mail: 'mail', public_html: 'public_html' });
export const SCAN_SCOPE_KEYS = Object.keys(SCAN_SCOPES);
export const SCAN_TIMEOUT_MS = 15 * 60_000;
export const HISTORY_LIMIT = 10;
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const AGENT_GRACE_MS = 30_000;

export function createPanelVirusService(ctx) {
  const { db } = ctx;
  const stmts = {
    account: db.prepare('SELECT id, username, owner_id, home_dir, domain FROM accounts WHERE id = ? AND username = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  };
  const op = (name, args, req, timeoutMs) => ctx.agent.op(name, args, { req, ...(timeoutMs ? { timeoutMs } : {}) });
  const audit = (req, scope, action, args = {}, result) => {
    const entry = { action, target: scope.username, args: auditArgs(scope, args), ...(result ? { result } : {}) };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  const isAgentCode = (err, codes) => Boolean(err?.agentError) && codes.includes(err.code);

  function requireScopeShape(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    assertFeature(scope, FEATURE);
  }
  function home(scope) {
    const dir = scope.account?.home_dir;
    if (!dir || !path.isAbsolute(dir)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
    return path.resolve(dir);
  }
  // The three folders a scan may cover, pinned under the home; anything else
  // never reaches the agent.
  function targetOf(scope, key) {
    if (!Object.hasOwn(SCAN_SCOPES, key)) throw unprocessable('Request validation failed', { scope: [`One of ${SCAN_SCOPE_KEYS.join(', ')}`] });
    const base = home(scope);
    const abs = path.resolve(base, SCAN_SCOPES[key]);
    if (abs !== base && !abs.startsWith(`${base}/`)) throw unprocessable('Request validation failed', { scope: ['The folder must stay inside the home directory'] });
    return { home: base, abs, rel: SCAN_SCOPES[key] || '.' };
  }

  async function detect(req) {
    try {
      const r = await op('sec.clamav.detect', {}, req);
      return { installed: Boolean(r.installed), version: r.version ?? null, signatures: r.signatures ?? null, databaseAgeSec: r.databaseAgeSec ?? null };
    } catch (err) {
      if (isAgentCode(err, ['capability_missing', 'binary_not_found', 'unknown_op'])) return { installed: false, version: null, signatures: null, databaseAgeSec: null };
      throw err;
    }
  }

  function mine(scope, { status, limit = 500 } = {}) {
    return ctx.jobs.list({ type: JOB_SCAN, status, limit }).filter((j) => j.params?.accountId === scope.accountId);
  }
  function activeOf(scope) {
    return ACTIVE_JOB.flatMap((status) => mine(scope, { status })).sort((a, b) => b.id - a.id)[0] || null;
  }

  async function status(scope, req) {
    requireScopeShape(scope);
    const scanner = await detect(req);
    return { scanner, scopes: SCAN_SCOPE_KEYS.map((key) => ({ key, path: SCAN_SCOPES[key] || '.' })), active: shapeJobOrNull(activeOf(scope)), history: history(scope) };
  }

  function history(scope) {
    requireScopeShape(scope);
    return mine(scope, { limit: 200 }).filter((j) => FINISHED_JOB.includes(j.status)).slice(0, HISTORY_LIMIT).map(shapeJob);
  }

  async function start(scope, { scope: key }, req) {
    requireScopeShape(scope);
    const target = targetOf(scope, key);
    const scanner = await detect(req);
    if (!scanner.installed) throw new CapabilityError('clamav', 'The virus scanner (ClamAV) is not installed on this server');
    const running = activeOf(scope);
    if (running) throw new HttpError(409, 'scan_running', 'A scan of this account is already queued or running; wait for it to finish', { job: { id: running.id, status: running.status } });
    const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, scope: key, path: target.abs, rel: target.rel };
    const job = ctx.jobs.enqueue(JOB_SCAN, params, { userId: scope.actor?.id || null });
    audit(req, scope, 'panel.clamav.scan', { scope: key, path: target.rel, job: job.id });
    return { job: { id: job.id, type: job.type, status: job.status }, scope: key, path: target.rel };
  }

  // The job acts for the account's owner, read back at run time (as the
  // WordPress job does): a missing or changed owner fails the job.
  function jobScope(params) {
    const account = stmts.account.get(params.accountId, params.username);
    if (!account) throw new Error(`Account "${params.username}" no longer exists`);
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; start the scan again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the scan was queued; start it again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    const scope = { account, accountId: account.id, username: account.username, mode: 'job', actor: null, actingAs: null, owner, ownerPrincipal: req.user, limits: {}, features: {} };
    return { scope, req };
  }

  async function run(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    // The path is re-derived from the account row, never trusted from the job
    // record, so a home moved since the enqueue cannot point the scan elsewhere.
    const target = targetOf(scope, p.scope);
    job.log(`Scanning ${target.rel === '.' ? 'the home directory' : target.rel} of ${scope.username} with ClamAV (as the account, 15 minutes at most)`);
    job.progress(5, `clamdscan ${target.rel}`);
    const started = Date.now();
    let r;
    try {
      r = await op('sec.clamav.scan_as', { username: scope.username, path: target.abs, maxDurationSec: SCAN_TIMEOUT_MS / 1000 }, req, SCAN_TIMEOUT_MS + AGENT_GRACE_MS);
    } catch (err) {
      audit(req, scope, 'panel.clamav.scan.failed', { scope: p.scope, path: target.rel, job: job.job.id, reason: err.message }, 'error');
      throw err;
    }
    const infected = (r.infected || []).map((f) => ({ file: relOf(target.home, f.file), signature: f.signature }));
    const errors = (r.errors || []).map((f) => ({ file: relOf(target.home, f.file), error: f.error }));
    for (const f of infected) job.log(`${f.file}: ${f.signature} FOUND`, 'warn');
    for (const f of errors) job.log(`${f.file}: ${f.error}`, 'warn');
    job.progress(100, infected.length ? `${infected.length} infected file${infected.length === 1 ? '' : 's'} found` : 'clean');
    const result = { scope: p.scope, path: target.rel, infected, errors, exitCode: r.exitCode ?? null, durationMs: r.durationMs ?? Date.now() - started, finishedAt: new Date().toISOString() };
    audit(req, scope, 'panel.clamav.scan.done', { scope: p.scope, path: target.rel, infected: infected.length, errors: errors.length, job: job.job.id });
    job.log(infected.length ? `Done: ${infected.length} infected file${infected.length === 1 ? '' : 's'}; review them and delete what you do not recognise` : 'Done: nothing found');
    return result;
  }
  const relOf = (base, file) => {
    const abs = path.resolve(String(file || ''));
    return abs === base || abs.startsWith(`${base}/`) ? (path.relative(base, abs) || '.') : abs;
  };

  // Infected files are removed through the file manager service (its path
  // pinning, .ssh guard and audit), so a path outside the home is 422 there.
  async function removeInfected(scope, { paths }, req) {
    requireScopeShape(scope);
    if (!ctx.panelFiles) throw new HttpError(503, 'service_unavailable', 'The file manager service is not loaded');
    const r = await ctx.panelFiles.remove(scope, { paths }, req);
    audit(req, scope, 'panel.clamav.remove', { paths });
    return r;
  }

  // The account's own scan jobs; anything else is 404 so job ids stay unguessable.
  function jobOf(scope, id) {
    const job = ctx.jobs.get(id);
    if (!JOB_TYPES.includes(job.type) || job.params?.accountId !== scope.accountId) throw notFound('Job');
    return job;
  }
  function shapeJob(job) {
    const params = { ...(job.params ?? {}) };
    for (const k of ['ownerId', 'accountId', 'path']) delete params[k];
    return { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, params, result: job.result ?? null, error: job.error ?? null, errorCode: job.error_code ?? null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, ...(job.logs ? { logs: job.logs } : {}) };
  }
  const shapeJobOrNull = (job) => (job ? shapeJob(job) : null);
  function getJob(scope, id) {
    requireScopeShape(scope);
    return shapeJob(jobOf(scope, id));
  }
  function streamJob(scope, id, req, res) {
    requireScopeShape(scope);
    const job = shapeJob(jobOf(scope, id));
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'snapshot', job });
    if (!ACTIVE_JOB.includes(job.status)) { res.end(); return; }
    const unsubscribe = ctx.jobs.subscribe(job.id, (event) => { send(event); if (FINISHED_JOB.includes(event.type)) { unsubscribe(); res.end(); } });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  }

  return { status, start, run, getJob, streamJob, history, removeInfected, targetOf };
}
