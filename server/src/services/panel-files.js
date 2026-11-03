import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { HttpError, notFound, conflict, unprocessable, CapabilityError } from '../lib/errors.js';

// File manager of the account panel. Every method takes the pinned scope
// (ctx.panel.scope(req)): the account's username and home come from it, the
// client only ever supplies paths relative to that home. The agent re-derives
// the home from /etc/passwd and runs every command as the account's uid.
//
//   panelFiles.list(scope, { path, limit }, req) / stat / read / write / mkdir
//   panelFiles.rename / copy / chmod / remove / du
//   panelFiles.download(scope, { path }, req, res)      streams chunk_read
//   panelFiles.uploads.begin / status / chunk / finish / abort
//   panelFiles.enqueueArchive / enqueueExtract           202 jobs
//   panelFiles.listJobs / getJob                         the account's own jobs
//
// Every agent call of a request passes a gate that bounds the as-user ops in
// flight per account and server-wide (a chunked download is many ops for one
// HTTP request), and archive/extract jobs are capped per account so one
// tenant cannot fill the job queue ahead of server-wide work.

export const UPLOAD_CHUNK_BYTES = 1_310_720;
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
export const DU_CACHE_MS = 5 * 60_000;
export const UPLOAD_TTL_MS = 6 * 3600_000;
export const MAX_UPLOADS_PER_ACCOUNT = 20;
export const JOB_ARCHIVE = 'panel.files.archive';
export const JOB_EXTRACT = 'panel.files.extract';
export const JOB_TYPES = [JOB_ARCHIVE, JOB_EXTRACT];
export const SSH_DIR = '.ssh';
// Defaults for the settings panel.files.max_* (none has to be seeded).
export const LIMITS = Object.freeze({
  inflightPerAccount: 2, inflight: 16, waitingPerAccount: 64,
  activeJobsPerAccount: 3, activeJobs: 24,
});
const LONG_OP_MS = 1_800_000;
const LONG_OP_GRACE_MS = 30_000;

// A path relative to the home: never absolute, no leading "-", no ".."
// segment, no NUL or line break. The service resolves it under the home and
// refuses escapes.
const REL = /^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]{1,512}$/;
const REL_MESSAGE = 'A path relative to the home directory: not absolute, without ".." and not starting with "-"';
export const relPath = z.string().regex(REL, REL_MESSAGE);
export const relPathOrRoot = z.string().max(512).regex(/^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]*$/, REL_MESSAGE).default('');
export const fileName = z.string().regex(/^(?!\.\.?$)[^\0\/\n\r]{1,255}$/, 'A plain file name');
export const fileMode = z.string().regex(/^0?[0-7]{3,4}$/, 'An octal mode such as 0644');
export const archiveFormat = z.enum(['zip', 'tar.gz']);

const ARCHIVE_EXT = { zip: /\.zip$/i, 'tar.gz': /\.(tar\.gz|tgz)$/i };
const EXTRACT_BIN = (name) => (/\.zip$/i.test(name) ? 'unzip' : /\.(tar|tar\.gz|tgz)$/i.test(name) ? 'tar' : null);
const ACTIVE = ['running', 'queued'];
const firstSegment = (rel) => String(rel).split('/')[0];

// The same gate as the SSH-key feature (routes/panel/security.js): the .ssh
// directory may be written through the file manager only by a session login
// of an account with shell access and the ssh feature, never over an API token
// or while an admin acts as the account.
export function sshWriteAllowed(scope, req) {
  if (!scope || scope.features?.ssh === false) return false;
  if (!scope.account?.plan?.has_shell) return false;
  if (req?.auth?.via === 'token') return false;
  if (scope.mode === 'acting' || scope.actingAs) return false;
  return true;
}

// Bounds concurrent work per key (an account) and overall; callers past the
// bound wait in arrival order, and a key with too many waiters is refused so
// a flood of requests cannot pile up promises without limit.
export function createGate({ perKey, total, maxWaiting }) {
  const keys = new Map();
  const waiting = [];
  let active = 0;
  const state = (key) => keys.get(key) ?? keys.set(key, { active: 0, waiting: 0 }).get(key);
  const canStart = (key) => active < total() && state(key).active < perKey();
  const start = (key) => { active += 1; state(key).active += 1; };
  const release = (key) => {
    active -= 1;
    const k = state(key);
    k.active -= 1;
    if (!k.active && !k.waiting) keys.delete(key);
    for (let i = 0; i < waiting.length;) {
      const w = waiting[i];
      if (!canStart(w.key)) { i += 1; continue; }
      waiting.splice(i, 1);
      state(w.key).waiting -= 1;
      start(w.key);
      w.resolve();
    }
  };
  return {
    async run(key, fn) {
      if (canStart(key)) start(key);
      else {
        const k = state(key);
        if (k.waiting >= maxWaiting()) throw new HttpError(409, 'busy', 'Too many file operations are waiting for this account; try again in a moment');
        k.waiting += 1;
        await new Promise((resolve) => waiting.push({ key, resolve }));
      }
      try { return await fn(); } finally { release(key); }
    },
    stats: () => ({ active, waiting: waiting.length, keys: Object.fromEntries([...keys].map(([k, v]) => [k, { ...v }])) }),
  };
}

export function createPanelFilesService(ctx) {
  const { agent, settings, jobs, capabilities } = ctx;
  const uploads = new Map();
  const duCache = new Map();
  const limit = (name) => { const v = Number(settings.get(`panel.files.max_${name}`, LIMITS[camelLimit(name)])); return Number.isFinite(v) && v >= 1 ? Math.floor(v) : LIMITS[camelLimit(name)]; };
  const inflight = createGate({ perKey: () => limit('inflight_per_account'), total: () => limit('inflight'), maxWaiting: () => limit('waiting_per_account') });

  const audit = (req, scope, action, args = {}) => {
    const entry = { action, target: scope.username, args: scope.mode === 'acting' ? { ...args, actingAs: scope.username, by: scope.actor?.username } : args };
    if (req?.audit) req.audit(entry); else ctx.auditRecord?.(req ?? null, entry);
  };
  // `who` is the scope or an upload record: anything that carries the accountId.
  const op = (who, name, args, req, timeoutMs) => inflight.run(who.accountId, () => agent.op(name, args, timeoutMs ? { req, timeoutMs } : { req }));
  const chunkBytes = () => Math.max(1024, Number(settings.get('panel.upload_chunk_bytes', UPLOAD_CHUNK_BYTES)) || UPLOAD_CHUNK_BYTES);

  function gate(scope) {
    if (!scope?.username || !scope.accountId) throw new HttpError(403, 'panel_scope_required', 'No hosting account is bound to this session');
    if (scope.features?.filemanager === false) throw new HttpError(403, 'feature_disabled', 'The file manager is not enabled for this account\'s package');
  }

  function home(scope) {
    const dir = scope.account?.home_dir;
    if (!dir || !path.isAbsolute(dir)) throw new HttpError(409, 'no_home', 'This account has no home directory on the server yet');
    return path.resolve(dir);
  }

  // Pins a client path under the home: resolved lexically here, checked again
  // (including through symlinks) by the agent.
  function resolve(scope, rel) {
    const base = home(scope);
    const clean = String(rel ?? '');
    if (clean && !REL.test(clean)) throw unprocessable('Request validation failed', { path: [REL_MESSAGE] });
    const abs = path.resolve(base, clean);
    if (abs !== base && !abs.startsWith(`${base}/`)) throw unprocessable('Request validation failed', { path: ['Path is outside the home directory'] });
    return { home: base, abs, rel: path.relative(base, abs) || '.' };
  }

  function guardSsh(scope, target, req) {
    if (firstSegment(target.rel) !== SSH_DIR) return;
    if (!sshWriteAllowed(scope, req)) throw new HttpError(403, 'ssh_managed', `${SSH_DIR} is managed from Security › SSH keys and cannot be changed here`);
  }
  // The lexical gate above is the quick answer; the agent re-checks where the
  // write really lands (through any link on disk) with this flag.
  const protect = (scope, req) => ({ protectSshDir: !sshWriteAllowed(scope, req) });

  function activeJobs() {
    return JOB_TYPES.flatMap((type) => ACTIVE.flatMap((status) => jobs.list({ type, status, limit: 500 })));
  }
  function shapeJob(job) {
    const { op: _op, ...params } = job.params ?? {};
    return { id: job.id, type: job.type, status: job.status, progress: job.progress, message: job.message, params, result: job.result ?? null, error: job.error ?? null, errorCode: job.error_code ?? null, createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at, ...(job.logs ? { logs: job.logs } : {}) };
  }
  // An identical request reuses the job already queued or running for it;
  // otherwise a new job is refused when the account (or the server) already
  // has enough files jobs active.
  function existingOrCapacity(scope, same) {
    const all = activeJobs();
    const mine = all.filter((j) => j.params?.accountId === scope.accountId);
    const found = mine.find(same);
    if (found) return found;
    if (mine.length >= limit('active_jobs_per_account')) throw new HttpError(409, 'busy', `${mine.length} file operation(s) of this account are already queued or running; wait for one to finish`);
    if (all.length >= limit('active_jobs')) throw new HttpError(409, 'busy', 'The server is busy with other file operations right now; try again in a moment');
    return null;
  }
  const jobOf = (scope, id) => {
    const job = jobs.get(id);
    if (!JOB_TYPES.includes(job.type) || job.params?.accountId !== scope.accountId) throw notFound('Job');
    return job;
  };

  async function requireBinary(bin, what) {
    await capabilities.ensureFresh();
    if (!capabilities.snapshot().binaries?.[bin]) throw new CapabilityError('archive', `${bin} is not installed on this server; it is required to ${what}`);
  }

  function shapeUpload(u) {
    return { id: u.id, path: u.rel, name: u.name, size: u.size, received: u.received, chunks: u.chunks, chunkBytes: chunkBytes(), expiresAt: new Date(u.touched + UPLOAD_TTL_MS).toISOString() };
  }

  function pruneUploads() {
    const now = Date.now();
    for (const [id, u] of uploads) if (now - u.touched > UPLOAD_TTL_MS) uploads.delete(id);
  }

  function loadUpload(scope, id) {
    pruneUploads();
    const u = uploads.get(id);
    if (!u || u.accountId !== scope.accountId) throw notFound('Upload');
    return u;
  }

  const uploadsApi = {
    async begin(scope, { path: dir, name, size, overwrite = false }, req) {
      gate(scope);
      pruneUploads();
      const target = resolve(scope, dir);
      const file = resolve(scope, path.join(target.rel === '.' ? '' : target.rel, name));
      const mine = [...uploads.values()].filter((u) => u.accountId === scope.accountId);
      if (mine.length >= MAX_UPLOADS_PER_ACCOUNT) throw conflict(`${MAX_UPLOADS_PER_ACCOUNT} uploads are already in progress; finish or abort one first`);
      if (mine.some((u) => u.abs === file.abs)) throw conflict(`${name} is being uploaded already; wait for it to finish or abort it`);
      guardSsh(scope, file, req);
      const dirStat = await op(scope, 'files.stat', { username: scope.username, path: target.abs }, req);
      if (!dirStat.exists) throw notFound(`Directory ${target.rel}`);
      if (dirStat.type !== 'dir') throw unprocessable('Request validation failed', { path: ['Not a directory'] });
      const existing = await op(scope, 'files.stat', { username: scope.username, path: file.abs }, req);
      if (existing.exists && (!overwrite || existing.type !== 'file')) throw new HttpError(409, 'exists', `${file.rel} already exists`);
      const id = crypto.randomBytes(12).toString('hex');
      uploads.set(id, { id, accountId: scope.accountId, username: scope.username, abs: file.abs, rel: file.rel, name, size, received: 0, chunks: 0, started: false, touched: Date.now(), createdBy: req?.user?.id ?? null, protect: protect(scope, req) });
      return shapeUpload(uploads.get(id));
    },
    status(scope, id) {
      gate(scope);
      return shapeUpload(loadUpload(scope, id));
    },
    // No semantic audit per chunk: the finish entry carries the whole upload.
    async chunk(scope, id, data, req) {
      gate(scope);
      const u = loadUpload(scope, id);
      const bytes = Buffer.byteLength(data, 'base64');
      if (bytes > chunkBytes()) throw unprocessable('Request validation failed', { data: [`A chunk carries at most ${chunkBytes()} bytes`] });
      if (u.received + bytes > u.size) throw unprocessable('More data than announced', { data: ['Upload exceeds the declared size'] });
      await op(u, 'files.chunk_write', { username: u.username, path: u.abs, data, truncate: !u.started, ...(u.protect || {}) }, req);
      u.started = true; u.received += bytes; u.chunks += 1; u.touched = Date.now();
      return shapeUpload(u);
    },
    async finish(scope, id, req) {
      gate(scope);
      const u = loadUpload(scope, id);
      if (u.received !== u.size) throw unprocessable(`Received ${u.received} of ${u.size} bytes`, { data: ['Upload is incomplete'] });
      uploads.delete(id);
      duCache.clear();
      audit(req, scope, 'panel.files.upload', { path: u.rel, bytes: u.received, chunks: u.chunks });
      return { id, path: u.rel, bytes: u.received };
    },
    async abort(scope, id, req) {
      gate(scope);
      const u = loadUpload(scope, id);
      uploads.delete(id);
      if (u.started) await op(u, 'files.remove', { username: u.username, paths: [u.abs], ...(u.protect || {}) }, req).catch(() => {});
      audit(req, scope, 'panel.files.upload_abort', { path: u.rel, bytes: u.received });
      return { id, aborted: true };
    },
  };

  const service = {
    relPath,
    uploads: uploadsApi,

    async list(scope, { path: dir = '', limit = 2000 } = {}, req) {
      gate(scope);
      const target = resolve(scope, dir);
      const r = await op(scope, 'files.list', { username: scope.username, path: target.abs, limit }, req);
      return { path: target.rel, entries: r.entries, total: r.total, truncated: r.truncated };
    },

    async stat(scope, { path: p }, req) {
      gate(scope);
      const target = resolve(scope, p);
      const r = await op(scope, 'files.stat', { username: scope.username, path: target.abs }, req);
      if (!r.exists) throw notFound(target.rel);
      const { path: _abs, ...rest } = r;
      return { ...rest, path: target.rel };
    },

    async read(scope, { path: p, maxBytes = 1024 * 1024 }, req) {
      gate(scope);
      const target = resolve(scope, p);
      const r = await op(scope, 'files.read', { username: scope.username, path: target.abs, maxBytes }, req);
      if (r.binary) throw new HttpError(422, 'binary', `${target.rel} is not a text file and cannot be opened in the editor`);
      return { path: target.rel, content: r.content, size: r.size, truncated: r.truncated, mtime: r.mtime, mode: r.mode };
    },

    async write(scope, { path: p, content, mode }, req) {
      gate(scope);
      const target = resolve(scope, p);
      if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw unprocessable('Request validation failed', { content: ['At most 4 MiB'] });
      guardSsh(scope, target, req);
      const r = await op(scope, 'files.write', { username: scope.username, path: target.abs, content, ...(mode ? { mode } : {}), ...protect(scope, req) }, req);
      duCache.clear();
      audit(req, scope, 'panel.files.write', { path: target.rel, bytes: r.bytes, created: r.created });
      return { path: target.rel, bytes: r.bytes, mode: r.mode };
    },

    async mkdir(scope, { path: p, mode = '0755' }, req) {
      gate(scope);
      const target = resolve(scope, p);
      if (target.rel === '.') throw unprocessable('Request validation failed', { path: ['Name the directory to create'] });
      guardSsh(scope, target, req);
      await op(scope, 'files.mkdir', { username: scope.username, path: target.abs, mode, ...protect(scope, req) }, req);
      audit(req, scope, 'panel.files.mkdir', { path: target.rel, mode });
      return { path: target.rel, mode };
    },

    async rename(scope, { from, to, overwrite = false }, req) {
      gate(scope);
      const src = resolve(scope, from);
      const dst = resolve(scope, to);
      if (src.rel === '.' || dst.rel === '.') throw unprocessable('Request validation failed', { from: ['The home directory itself cannot be moved'] });
      guardSsh(scope, src, req);
      guardSsh(scope, dst, req);
      await op(scope, 'files.move', { username: scope.username, from: src.abs, to: dst.abs, overwrite, ...protect(scope, req) }, req);
      duCache.clear();
      audit(req, scope, 'panel.files.rename', { from: src.rel, to: dst.rel, overwrite });
      return { from: src.rel, to: dst.rel };
    },

    async copy(scope, { from, to }, req) {
      gate(scope);
      const src = resolve(scope, from);
      const dst = resolve(scope, to);
      if (src.rel === '.' || dst.rel === '.') throw unprocessable('Request validation failed', { from: ['The home directory itself cannot be copied'] });
      guardSsh(scope, dst, req);
      await op(scope, 'files.copy', { username: scope.username, from: src.abs, to: dst.abs, ...protect(scope, req) }, req, 600_000 + LONG_OP_GRACE_MS);
      duCache.clear();
      audit(req, scope, 'panel.files.copy', { from: src.rel, to: dst.rel });
      return { from: src.rel, to: dst.rel };
    },

    async chmod(scope, { path: p, mode, recursive = false }, req) {
      gate(scope);
      const target = resolve(scope, p);
      guardSsh(scope, target, req);
      await op(scope, 'files.chmod', { username: scope.username, path: target.abs, mode, recursive, ...protect(scope, req) }, req, 600_000 + LONG_OP_GRACE_MS);
      audit(req, scope, 'panel.files.chmod', { path: target.rel, mode, recursive });
      return { path: target.rel, mode, recursive };
    },

    async remove(scope, { paths }, req) {
      gate(scope);
      const targets = paths.map((p) => resolve(scope, p));
      if (targets.some((t) => t.rel === '.')) throw unprocessable('Request validation failed', { paths: ['The home directory itself cannot be deleted'] });
      for (const t of targets) guardSsh(scope, t, req);
      const r = await op(scope, 'files.remove', { username: scope.username, paths: targets.map((t) => t.abs), ...protect(scope, req) }, req, 600_000 + LONG_OP_GRACE_MS);
      duCache.clear();
      audit(req, scope, 'panel.files.remove', { paths: targets.map((t) => t.rel) });
      return { removed: r.removed ?? targets.map((t) => t.rel) };
    },

    async du(scope, { path: dir = '', depth = 1 } = {}, req) {
      gate(scope);
      const target = resolve(scope, dir);
      const key = `${scope.accountId}:${target.rel}:${depth}`;
      const cached = duCache.get(key);
      if (cached && Date.now() - cached.at < DU_CACHE_MS) return { ...cached.result, cached: true };
      const r = await op(scope, 'files.du', { username: scope.username, path: target.abs, depth }, req, 600_000 + LONG_OP_GRACE_MS);
      const result = { path: target.rel, depth, totalKb: r.totalKb, entries: r.entries, partial: Boolean(r.partial), measuredAt: new Date().toISOString() };
      duCache.set(key, { at: Date.now(), result });
      return { ...result, cached: false };
    },

    // Streams a file as an attachment by reading it in 2 MiB ranges as the
    // account; each range is one gated agent op.
    async download(scope, { path: p }, req, res) {
      gate(scope);
      const target = resolve(scope, p);
      const st = await op(scope, 'files.stat', { username: scope.username, path: target.abs }, req);
      if (!st.exists) throw notFound(target.rel);
      if (st.type !== 'file') throw new HttpError(422, 'not_a_file', `${target.rel} is not a regular file`);
      const name = path.basename(target.abs);
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.setHeader('Cache-Control', 'no-store');
      audit(req, scope, 'panel.files.download', { path: target.rel, bytes: st.size });
      let offset = 0;
      while (offset < st.size) {
        const chunk = await op(scope, 'files.chunk_read', { username: scope.username, path: target.abs, offset, length: Math.min(DOWNLOAD_CHUNK_BYTES, st.size - offset) }, req);
        const buf = Buffer.from(chunk.data, 'base64');
        if (!buf.length) break;
        offset += buf.length;
        if (!res.write(buf)) await new Promise((resolve) => res.once('drain', resolve));
        if (chunk.eof) break;
      }
      if (offset < st.size) res.destroy(new Error(`${target.rel} shrank while it was being sent`));
      else res.end();
      return null;
    },

    async enqueueArchive(scope, { paths, dest, format }, req) {
      gate(scope);
      await requireBinary(format === 'zip' ? 'zip' : 'tar', `create ${format} archives`);
      const out = resolve(scope, dest);
      if (out.rel === '.') throw unprocessable('Request validation failed', { dest: ['Name the archive file'] });
      if (!ARCHIVE_EXT[format].test(out.abs)) throw unprocessable('Request validation failed', { dest: [`The archive name must end in .${format}`] });
      const members = paths.map((p) => resolve(scope, p));
      if (members.some((m) => m.rel === '.')) throw unprocessable('Request validation failed', { paths: ['The home directory itself cannot be archived'] });
      guardSsh(scope, out, req);
      const same = existingOrCapacity(scope, (j) => j.type === JOB_ARCHIVE && j.params.dest === out.rel);
      if (same) return { job: { id: same.id, type: same.type, status: same.status }, reused: true };
      const existing = await op(scope, 'files.stat', { username: scope.username, path: out.abs }, req);
      if (existing.exists) throw new HttpError(409, 'exists', `${out.rel} already exists`);
      const job = jobs.enqueue(JOB_ARCHIVE, { accountId: scope.accountId, username: scope.username, dest: out.rel, paths: members.map((m) => m.rel), format, op: { username: scope.username, paths: members.map((m) => m.abs), dest: out.abs, format, ...protect(scope, req) } }, { userId: req?.user?.id ?? null });
      audit(req, scope, 'panel.files.archive', { dest: out.rel, paths: members.length, format, jobId: job.id });
      return { job: { id: job.id, type: job.type, status: job.status }, reused: false };
    },

    async enqueueExtract(scope, { archive, dest }, req) {
      gate(scope);
      const src = resolve(scope, archive);
      const out = resolve(scope, dest);
      const bin = EXTRACT_BIN(path.basename(src.abs));
      if (!bin) throw unprocessable('Request validation failed', { archive: ['Only .zip, .tar, .tar.gz and .tgz archives can be extracted'] });
      await requireBinary(bin, 'extract archives');
      guardSsh(scope, out, req);
      const same = existingOrCapacity(scope, (j) => j.type === JOB_EXTRACT && j.params.archive === src.rel && j.params.dest === out.rel);
      if (same) return { job: { id: same.id, type: same.type, status: same.status }, reused: true };
      const st = await op(scope, 'files.stat', { username: scope.username, path: src.abs }, req);
      if (!st.exists) throw notFound(src.rel);
      if (st.type !== 'file') throw new HttpError(422, 'not_a_file', `${src.rel} is not a regular file`);
      // The agent lists the members first and refuses any that would land in
      // .ssh unless this request could write there directly (same gate).
      const allowSshDir = sshWriteAllowed(scope, req);
      const job = jobs.enqueue(JOB_EXTRACT, { accountId: scope.accountId, username: scope.username, archive: src.rel, dest: out.rel, op: { username: scope.username, archive: src.abs, dest: out.abs, allowSshDir } }, { userId: req?.user?.id ?? null });
      audit(req, scope, 'panel.files.extract', { archive: src.rel, dest: out.rel, jobId: job.id });
      return { job: { id: job.id, type: job.type, status: job.status }, reused: false };
    },

    // The account's own archive/extract jobs: a role-user principal has no
    // other job reader (/api/system/jobs is reseller-only).
    listJobs(scope) {
      gate(scope);
      const rows = JOB_TYPES.flatMap((type) => jobs.list({ type, limit: 200 })).filter((j) => j.params?.accountId === scope.accountId);
      return rows.sort((a, b) => b.id - a.id).slice(0, 50).map(shapeJob);
    },
    getJob(scope, id) {
      gate(scope);
      return shapeJob(jobOf(scope, id));
    },
    // SSE: a snapshot, then the job's events until it ends.
    streamJob(scope, id, req, res) {
      gate(scope);
      const job = shapeJob(jobOf(scope, id));
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'snapshot', job });
      if (!ACTIVE.includes(job.status)) return res.end();
      const unsubscribe = jobs.subscribe(job.id, (event) => { send(event); if (['done', 'failed', 'cancelled'].includes(event.type)) { unsubscribe(); res.end(); } });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      return null;
    },

    // Job handlers (registered by the route module).
    async runArchiveJob({ params, log, progress }) {
      log(`Creating ${params.dest} (${params.format}) from ${params.paths.length} path(s) as ${params.username}`);
      progress(5, 'compressing');
      const r = await agent.op('files.archive', params.op, { timeoutMs: LONG_OP_MS + LONG_OP_GRACE_MS });
      duCache.clear();
      progress(100, 'done');
      return { dest: params.dest, format: params.format, members: r.members, size: r.size };
    },
    async runExtractJob({ params, log, progress }) {
      log(`Extracting ${params.archive} into ${params.dest} as ${params.username}`);
      progress(5, 'extracting');
      const r = await agent.op('files.extract', params.op, { timeoutMs: LONG_OP_MS + LONG_OP_GRACE_MS });
      duCache.clear();
      for (const w of r.warnings ?? []) log(w, 'warn');
      progress(100, 'done');
      return { archive: params.archive, dest: params.dest, format: r.format, warnings: r.warnings ?? [] };
    },

    _uploads: uploads,
    _duCache: duCache,
    _inflight: inflight,
  };
  return service;
}

function camelLimit(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
