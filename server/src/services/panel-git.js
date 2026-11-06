import { posix as path } from 'node:path';
import { z } from 'zod';
import { HttpError, notFound, conflict, unprocessable } from '../lib/errors.js';
import { assertFeature, auditArgs } from './panel-domains.js';

// Git Version Control for the account panel (P3-1, contract §64). A
// repository is a row of panel_git_repos (name, home-relative dir, optional
// remote URL) plus whatever git says about the directory, read as the account
// through the git.* agent ops. Clone, pull and deploy are jobs the account
// follows over the panel jobs pattern; create (git init) and remove answer
// at once. Feature `gitversioncontrol`.
//
//   panelGit.list / create / get / pull / deploy / remove / getJob / streamJob

export const FEATURE = 'gitversioncontrol';
export const JOB_CLONE = 'panel.git.clone';
export const JOB_PULL = 'panel.git.pull';
export const JOB_DEPLOY = 'panel.git.deploy';
export const JOB_TYPES = [JOB_CLONE, JOB_PULL, JOB_DEPLOY];
export const DEFAULT_ROOT = 'repositories';
export const MAX_REPOS = 50;
// Mirrors the agent's git.deploy budget (MAX_TASKS × TASK_TIMEOUT_MS + 1 min).
export const DEPLOY_TIMEOUT_MS = 50 * 300_000 + 60_000;
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const repoName = z.string().regex(REPO_NAME_RE, 'Letters, digits, ".", "_" and "-"; max 64 characters').refine((n) => n !== '.' && n !== '..' && !n.endsWith('.git'), 'Not a plain repository name');
// The same home-relative grammar as the file manager: never absolute, no
// leading "-", no "." or ".." segment, no NUL or line break.
export const REPO_DIR_RE = /^(?![-/])(?!.*(^|\/)\.\.?(\/|$))[^\0\n\r]{1,512}$/;
export const repoDir = z.string().regex(REPO_DIR_RE, 'A folder relative to your home directory, without ".." and not starting with "-"');
// Mirrors the agent's gitUrl so a bad URL is 422 before any job is queued.
const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*';
const URL_PATH = '[A-Za-z0-9][A-Za-z0-9._~/-]*';
export const GIT_URL_RE = new RegExp(`^(?:https://${HOST}(?::\\d{1,5})?/${URL_PATH}|ssh://git@${HOST}(?::\\d{1,5})?/${URL_PATH}|git@${HOST}:${URL_PATH})$`);
export const GIT_URL_MESSAGE = 'An https:// URL, an ssh://git@host/path URL or git@host:path, without a user name or password';
export const gitUrl = z.string().max(512).regex(GIT_URL_RE, GIT_URL_MESSAGE).refine((u) => !/(^|\/)\.\.(\/|$)/.test(u), GIT_URL_MESSAGE);
const ACTIVE_JOB = ['queued', 'running'];
const FINISHED_JOB = ['done', 'failed', 'cancelled'];
const nowIso = () => new Date().toISOString();

export function createPanelGitService(ctx) {
  const { db } = ctx;
  const stmts = {
    list: db.prepare('SELECT * FROM panel_git_repos WHERE account_id = ? ORDER BY name'),
    count: db.prepare('SELECT COUNT(*) AS n FROM panel_git_repos WHERE account_id = ?'),
    byId: db.prepare('SELECT * FROM panel_git_repos WHERE id = ? AND account_id = ?'),
    byName: db.prepare('SELECT id FROM panel_git_repos WHERE account_id = ? AND name = ?'),
    insert: db.prepare('INSERT INTO panel_git_repos (account_id, name, dir, url) VALUES (?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM panel_git_repos WHERE id = ? AND account_id = ?'),
    pulled: db.prepare('UPDATE panel_git_repos SET last_pull_at = ? WHERE id = ?'),
    deployed: db.prepare('UPDATE panel_git_repos SET last_deploy_at = ? WHERE id = ?'),
    account: db.prepare('SELECT id, username, owner_id, home_dir, domain FROM accounts WHERE id = ? AND username = ?'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  };
  const agent = () => ctx.agent;
  const op = (name, args, req) => agent().op(name, args, { req });
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
  // Pins a home-relative directory under the home (422 on escape; the agent
  // re-checks through symlinks) and refuses the home itself.
  function resolveDir(scope, rel) {
    const clean = String(rel ?? '').replace(/^\/+|\/+$/g, '');
    if (!clean || !REPO_DIR_RE.test(clean)) throw unprocessable('Request validation failed', { dir: ['A folder relative to your home directory, without ".." and not starting with "-"'] });
    const base = home(scope);
    const abs = path.resolve(base, clean);
    if (!abs.startsWith(`${base}/`)) throw unprocessable('Request validation failed', { dir: ['The folder must stay inside your home directory'] });
    return { abs, rel: path.relative(base, abs) };
  }
  const shape = (r) => ({ id: r.id, name: r.name, dir: r.dir, url: r.url ?? null, createdAt: r.created_at ?? null, lastPullAt: r.last_pull_at ?? null, lastDeployAt: r.last_deploy_at ?? null });
  function rowOf(scope, id) {
    const row = stmts.byId.get(id, scope.accountId);
    if (!row) throw notFound('Repository');
    return row;
  }
  // A new directory may not sit inside, or hold, a registered repository.
  function assertDisjoint(scope, rel) {
    for (const r of stmts.list.all(scope.accountId)) {
      if (r.dir === rel) throw conflict(`${rel} is already registered as repository "${r.name}"`);
      if (rel.startsWith(`${r.dir}/`)) throw conflict(`${rel} is inside repository "${r.name}" (${r.dir})`);
      if (r.dir.startsWith(`${rel}/`)) throw conflict(`repository "${r.name}" (${r.dir}) is inside ${rel}`);
    }
  }

  async function discover(scope, req) {
    const base = home(scope);
    const root = path.resolve(base, DEFAULT_ROOT);
    try {
      const r = await op('git.list', { username: scope.username, root }, req);
      return (r?.repos || []).map((x) => ({ dir: x.rel, name: x.name }));
    } catch (err) {
      if (isAgentCode(err, ['not_found', 'refused', 'path_not_allowed', 'capability_missing', 'binary_not_found', 'unknown_op'])) return [];
      throw err;
    }
  }

  async function list(scope, req) {
    requireScopeShape(scope);
    const rows = stmts.list.all(scope.accountId);
    const found = await discover(scope, req);
    const registered = new Set(rows.map((r) => r.dir));
    const unregistered = found.filter((f) => !registered.has(f.dir));
    const present = new Set(found.map((f) => f.dir));
    const data = rows.map((r) => ({ ...shape(r), present: r.dir.startsWith(`${DEFAULT_ROOT}/`) && !r.dir.slice(DEFAULT_ROOT.length + 1).includes('/') ? present.has(r.dir) : null }));
    return { data, meta: { total: rows.length, max: MAX_REPOS, defaultRoot: DEFAULT_ROOT, unregistered } };
  }

  // {name, dir?, url?}: with a URL the clone runs as a job (202), without one
  // the empty repository is created at once (201); `adopt: true` registers a
  // repository that already exists in the directory.
  async function create(scope, input, req) {
    requireScopeShape(scope);
    if (stmts.count.get(scope.accountId).n >= MAX_REPOS) throw new HttpError(409, 'limit_reached', `At most ${MAX_REPOS} repositories per account`);
    if (stmts.byName.get(scope.accountId, input.name)) throw conflict(`A repository named "${input.name}" already exists`);
    const { abs, rel } = resolveDir(scope, input.dir || `${DEFAULT_ROOT}/${input.name}`);
    assertDisjoint(scope, rel);
    if (input.url) {
      const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, name: input.name, dir: rel, abs, url: input.url };
      const job = ctx.jobs.enqueue(JOB_CLONE, params, { userId: scope.actor?.id || null });
      audit(req, scope, 'panel.git.clone', { name: input.name, dir: rel, url: input.url, job: job.id });
      return { status: 202, data: { job: { id: job.id }, name: input.name, dir: rel, url: input.url } };
    }
    let info;
    if (input.adopt) info = await op('git.info', { username: scope.username, dir: abs }, req);
    else info = await op('git.init', { username: scope.username, dir: abs }, req);
    const id = Number(stmts.insert.run(scope.accountId, input.name, rel, info.remotes?.[0]?.url ?? null).lastInsertRowid);
    audit(req, scope, input.adopt ? 'panel.git.adopt' : 'panel.git.init', { name: input.name, dir: rel });
    return { status: 201, data: { ...shape(stmts.byId.get(id, scope.accountId)), info: publicInfo(info) } };
  }

  const publicInfo = (info) => ({ branch: info.branch ?? null, head: info.head ?? null, remotes: info.remotes ?? [], dirty: info.dirty ?? null, lastPullAt: info.lastPullAt ?? null, hasKeelYml: Boolean(info.hasKeelYml) });

  async function get(scope, id, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    const { abs } = resolveDir(scope, row.dir);
    let info = null;
    let missing = false;
    try { info = publicInfo(await op('git.info', { username: scope.username, dir: abs }, req)); } catch (err) {
      if (!isAgentCode(err, ['not_found'])) throw err;
      missing = true;
    }
    return { ...shape(row), info, missing };
  }

  function enqueue(scope, row, type, action, req, extra = {}) {
    const { abs } = resolveDir(scope, row.dir);
    const params = { accountId: scope.accountId, username: scope.username, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null, repoId: row.id, name: row.name, dir: row.dir, abs, ...extra };
    const job = ctx.jobs.enqueue(type, params, { userId: scope.actor?.id || null });
    audit(req, scope, action, { name: row.name, dir: row.dir, job: job.id, ...extra });
    return { job: { id: job.id }, id: row.id, name: row.name, dir: row.dir };
  }

  async function pull(scope, id, req) {
    requireScopeShape(scope);
    return enqueue(scope, rowOf(scope, id), JOB_PULL, 'panel.git.pull', req);
  }

  async function deploy(scope, id, { dryRun = false } = {}, req) {
    requireScopeShape(scope);
    return enqueue(scope, rowOf(scope, id), JOB_DEPLOY, 'panel.git.deploy', req, { dryRun: Boolean(dryRun) });
  }

  // Unregisters the repository; with files=true the directory goes too
  // (as the account, the repository directory only).
  async function remove(scope, id, { files = true } = {}, req) {
    requireScopeShape(scope);
    const row = rowOf(scope, id);
    let removed = false;
    if (files) {
      const { abs } = resolveDir(scope, row.dir);
      const r = await op('git.remove', { username: scope.username, dir: abs }, req);
      removed = Boolean(r?.removed);
    }
    stmts.remove.run(row.id, scope.accountId);
    audit(req, scope, 'panel.git.remove', { name: row.name, dir: row.dir, files: Boolean(files), removed });
    return { id: row.id, name: row.name, dir: row.dir, unregistered: true, filesRemoved: removed };
  }

  // The job acts for the account's owner, read back at run time: a missing or
  // changed owner fails the job instead of falling back to a root principal.
  function jobScope(params) {
    const account = stmts.account.get(params.accountId, params.username);
    if (!account) throw new Error(`Account "${params.username}" no longer exists`);
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; start the job again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the job was queued; start it again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    const scope = { account, accountId: account.id, username: account.username, mode: 'job', actor: null, actingAs: null, owner, ownerPrincipal: req.user, limits: {}, features: {} };
    return { scope, req };
  }

  async function runClone(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    job.log(`Cloning ${p.url} into ~/${p.dir} as ${p.username}`);
    job.progress(5, 'git clone');
    try {
      if (stmts.byName.get(scope.accountId, p.name)) throw new Error(`A repository named "${p.name}" was registered while the clone was queued`);
      const r = await agent().op('git.clone', { username: p.username, dir: p.abs, url: p.url });
      for (const line of String(r.output || '').split('\n').filter(Boolean)) job.log(line);
      const id = Number(stmts.insert.run(scope.accountId, p.name, p.dir, p.url).lastInsertRowid);
      stmts.pulled.run(nowIso(), id);
      job.progress(100, 'done');
      audit(req, scope, 'panel.git.clone.done', { name: p.name, dir: p.dir, url: p.url, branch: r.branch ?? null, head: r.head?.sha ?? null, job: job.job.id });
      job.log(`Cloned ${p.name}: branch ${r.branch || '?'} at ${r.head?.short || 'no commits yet'}`);
      return { id, name: p.name, dir: p.dir, url: p.url, info: publicInfo(r) };
    } catch (err) {
      audit(req, scope, 'panel.git.clone.failed', { name: p.name, dir: p.dir, url: p.url, job: job.job.id, reason: err.message }, 'error');
      for (const line of String(err?.details?.stderr || '').split('\n').filter(Boolean)) job.log(line, 'warn');
      throw err;
    }
  }

  async function runPull(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    job.log(`git pull --ff-only in ~/${p.dir}`);
    job.progress(10, 'git pull');
    try {
      const r = await agent().op('git.pull', { username: p.username, dir: p.abs });
      for (const line of String(r.output || '').split('\n').filter(Boolean)) job.log(line);
      stmts.pulled.run(nowIso(), p.repoId);
      job.progress(100, 'done');
      audit(req, scope, 'panel.git.pull.done', { name: p.name, dir: p.dir, from: r.from ?? null, head: r.head?.sha ?? null, updated: Boolean(r.updated), job: job.job.id });
      job.log(r.updated ? `Updated to ${r.head?.short || '?'}` : 'Already up to date');
      return { id: p.repoId, name: p.name, dir: p.dir, updated: Boolean(r.updated), from: r.from ?? null, info: publicInfo(r) };
    } catch (err) {
      audit(req, scope, 'panel.git.pull.failed', { name: p.name, dir: p.dir, job: job.job.id, reason: err.message }, 'error');
      for (const line of String(err?.details?.stderr || '').split('\n').filter(Boolean)) job.log(line, 'warn');
      throw err;
    }
  }

  async function runDeploy(job) {
    const p = job.params;
    const { scope, req } = jobScope(p);
    job.log(`${p.dryRun ? 'Checking' : 'Running'} the deployment tasks of ~/${p.dir}/.keel.yml`);
    job.progress(10, p.dryRun ? 'reading .keel.yml' : 'deploying');
    try {
      const r = await agent().op('git.deploy', { username: p.username, dir: p.abs, dryRun: Boolean(p.dryRun) }, { timeoutMs: DEPLOY_TIMEOUT_MS });
      for (const t of r.tasks || []) {
        job.log(`${t.index + 1}. ${t.line}${t.ran ? '' : ' (not run)'}`);
        for (const line of String(t.output || '').split('\n').filter(Boolean)) job.log(`   ${line}`);
      }
      if (!p.dryRun) stmts.deployed.run(nowIso(), p.repoId);
      job.progress(100, 'done');
      audit(req, scope, 'panel.git.deploy.done', { name: p.name, dir: p.dir, tasks: (r.tasks || []).length, dryRun: Boolean(p.dryRun), job: job.job.id });
      job.log(p.dryRun ? `${(r.tasks || []).length} task(s) would run` : `${(r.tasks || []).length} task(s) ran`);
      return { id: p.repoId, name: p.name, dir: p.dir, dryRun: Boolean(p.dryRun), tasks: r.tasks || [] };
    } catch (err) {
      for (const t of err?.details?.results || []) {
        job.log(`${t.index + 1}. ${t.line}${t.code != null ? ` → exit ${t.code}` : ''}`, t.code ? 'warn' : 'info');
        for (const line of String(t.output || '').split('\n').filter(Boolean)) job.log(`   ${line}`, 'warn');
      }
      audit(req, scope, 'panel.git.deploy.failed', { name: p.name, dir: p.dir, job: job.job.id, reason: err.message }, 'error');
      throw err;
    }
  }

  // The account's own jobs; anything else is 404 so job ids stay unguessable.
  function jobOf(scope, id) {
    const job = ctx.jobs.get(id);
    if (!JOB_TYPES.includes(job.type) || job.params?.accountId !== scope.accountId) throw notFound('Job');
    return job;
  }
  function shapeJob(job) {
    const params = { ...(job.params ?? {}) };
    for (const k of ['ownerId', 'accountId', 'abs']) delete params[k];
    return { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, params, result: job.result ?? null, error: job.error ?? null, errorCode: job.error_code ?? null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, ...(job.logs ? { logs: job.logs } : {}) };
  }
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

  return { list, create, get, pull, deploy, remove, runClone, runPull, runDeploy, getJob, streamJob, resolveDir };
}
