import path from 'node:path';
import crypto from 'node:crypto';
import { json } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { featureDisabled } from './panel-databases.js';

// Customer panel: backups of one hosting account. Rows are read with the
// panel's own statements pinned to the account (never ctx.backup.listBackups);
// mutations go through ctx.backup with the account's owner principal, and only
// archives the panel generated or the customer uploaded (retention_class
// 'panel') can be downloaded or deleted (design §9.14). Scheduled system
// backups stay WHM-only. Uploaded archives are registered by the panel itself:
// ctx.backup.registerArchive is root-only by construction (§3.3), so a
// reseller-owned account could never reach it, and the archive's account is
// verified before the row exists rather than after.

export const RANGE_BYTES = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1_310_720;
export const UPLOAD_NAME = /^(?!\.)[A-Za-z0-9._-]{1,200}\.(tar\.gz|tgz|tar)$/;
export const REL_PATH = /^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]{1,1024}$/;
const UPLOAD_TTL_MS = 6 * 3600_000;
const INCLUDE = {
  home: { home: true, mail: true, dbs: false, dns: false, metadata: true },
  full: { home: true, mail: true, dbs: true, dns: true, metadata: true },
};

const isCapabilityMissing = (err) => err instanceof CapabilityError || err?.code === 'capability_missing' || err?.code === 'binary_not_found';

// The uploaded file is stored under a name the panel builds from the account,
// so the archive name (which backup.archive.info reads the account from) can
// never claim another account.
export function uploadFileName(username, original, date = new Date()) {
  const ext = /\.tar$/.test(original) ? 'tar' : 'tar.gz';
  const p = (n) => String(n).padStart(2, '0');
  return `backup-${p(date.getMonth() + 1)}.${p(date.getDate())}.${date.getFullYear()}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}_${username}.${ext}`;
}

export function createPanelBackupService(ctx) {
  const { db, agent, settings, logger } = ctx;

  const stmts = {
    list: db.prepare('SELECT * FROM backups WHERE account_name = @username AND account_id = @accountId ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset'),
    count: db.prepare('SELECT COUNT(*) AS n FROM backups WHERE account_name = ? AND account_id = ?'),
    byId: db.prepare('SELECT * FROM backups WHERE id = ? AND account_name = ? AND account_id = ?'),
    byPath: db.prepare('SELECT id FROM backups WHERE path = ?'),
    markPanel: db.prepare("UPDATE backups SET retention_class = 'panel' WHERE id = ?"),
    insert: db.prepare(`INSERT INTO backups (account_id, account_name, owner_id, type, path, size, sha256, status, run_id, retention_class, components_json, error, local_present, created_at)
      VALUES (@account_id, @account_name, @owner_id, 'import', @path, @size, @sha256, 'done', NULL, 'panel', @components_json, NULL, 1, datetime('now'))`),
    restores: db.prepare('SELECT * FROM backup_restores WHERE account_name = ? ORDER BY id DESC LIMIT 50'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
  };

  const uploads = new Map();
  const audit = (req, scope, entry) => req?.audit?.({ ...entry, target: scope.username, args: { ...(entry.args || {}), ...(scope.mode === 'acting' ? { actingAs: scope.username, by: scope.actor?.username } : {}) } });
  const requireFeature = (scope) => { if (scope.features?.backup === false) throw featureDisabled('backup'); };
  const backup = () => {
    if (!ctx.backup) throw new CapabilityError('backup', 'Backups are not available on this server');
    return ctx.backup;
  };
  const localDir = () => backup().localDir();

  function translate(err) {
    if (isCapabilityMissing(err)) return new CapabilityError('backup', err.message);
    if (err?.code === 'path_not_allowed') return forbidden(err.message);
    if (err?.code === 'not_found') return notFound(err.message);
    if (err?.code === 'exists') return conflict(err.message);
    if (err?.code === 'refused') return unprocessable(err.message);
    if (err?.code === 'invalid_args') return unprocessable(`The agent rejected the request: ${err.message}`, err.details?.fields);
    return err;
  }

  async function op(name, args, req, timeoutMs) {
    try { return await agent.op(name, args, timeoutMs ? { req, timeoutMs } : { req }); } catch (err) { throw translate(err); }
  }

  function shape(row) {
    const components = json.parse(row.components_json, {});
    return {
      id: row.id, account: row.account_name, type: row.type, name: row.path ? path.basename(row.path) : null, size: row.size, sha256: row.sha256,
      status: row.status, error: row.error, created_at: row.created_at, retention_class: row.retention_class, pinned: Boolean(row.pinned), local_present: Boolean(row.local_present),
      kind: components.include ? (components.include.dbs ? 'full' : 'home') : row.type === 'import' ? 'upload' : 'full',
      components, panelOwned: row.retention_class === 'panel', downloadable: row.retention_class === 'panel' && Boolean(row.local_present) && Boolean(row.path),
    };
  }

  function owned(scope, id) {
    const row = stmts.byId.get(id, scope.username, scope.accountId);
    if (!row) throw notFound('Backup');
    return row;
  }

  function runningJobFor(username) {
    return [...ctx.jobs.list({ type: 'panel.backup.generate', status: 'running', limit: 200 }), ...ctx.jobs.list({ type: 'panel.backup.generate', status: 'queued', limit: 200 })].find((j) => j.params?.username === username) || null;
  }

  function list(scope, query = {}) {
    requireFeature(scope);
    const page = query.page || 1;
    const pageSize = query.pageSize || 50;
    const rows = stmts.list.all({ username: scope.username, accountId: scope.accountId, limit: pageSize, offset: (page - 1) * pageSize });
    const running = runningJobFor(scope.username);
    return { data: rows.map(shape), meta: { page, pageSize, total: stmts.count.get(scope.username, scope.accountId).n, running: running ? { id: running.id, status: running.status, kind: running.params?.kind ?? null } : null, kinds: Object.keys(INCLUDE) } };
  }

  function generate(scope, { kind }, req) {
    requireFeature(scope);
    backup();
    const running = runningJobFor(scope.username);
    if (running) throw new HttpError(409, 'busy', `A backup of ${scope.username} is already ${running.status} (job ${running.id})`);
    const job = ctx.jobs.enqueue('panel.backup.generate', { username: scope.username, accountId: scope.accountId, kind, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null }, { userId: scope.actor?.id || null });
    audit(req, scope, { action: 'panel.backup.generate', args: { kind, job: job.id } });
    return { job: { id: job.id }, kind };
  }

  // The job runs as the account's owner (never SYSTEM_ROOT): ctx.backup.archiveAccount
  // checks ownership with that principal and audits under it.
  function ownerRequest(params) {
    const user = (params.ownerId && stmts.ownerById.get(params.ownerId)) || { id: null, username: 'panel', role: 'root' };
    const req = { user, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  async function runGenerate(job) {
    const { username, accountId, kind } = job.params;
    const account = db.prepare('SELECT id FROM accounts WHERE id = ? AND username = ?').get(accountId, username);
    if (!account) throw new Error(`Account "${username}" no longer exists`);
    const req = ownerRequest(job.params);
    job.log(`Generating a ${kind} backup of ${username}`);
    let result;
    try {
      result = await backup().archiveAccount(username, { destDir: localDir(), include: INCLUDE[kind] || INCLUDE.full, log: job.log }, req.user, req);
    } catch (err) {
      if (err?.backupId) stmts.markPanel.run(err.backupId);
      throw err;
    }
    stmts.markPanel.run(result.id);
    job.progress(100, `${path.basename(result.path || '')} (${result.size ?? 0} bytes)`);
    req.audit({ action: 'panel.backup.generated', target: username, args: { backupId: result.id, kind, sizeBytes: result.size ?? null } });
    return { backupId: result.id, kind, path: result.path, size: result.size };
  }

  async function get(scope, id) {
    requireFeature(scope);
    const row = owned(scope, id);
    let archive = null;
    if (row.local_present && row.path && row.status === 'done') {
      try { archive = await backup().archiveInfo(id, scope.ownerPrincipal); } catch (err) { if (isCapabilityMissing(err)) throw translate(err); archive = { error: err.message }; }
    }
    return { ...shape(row), archive };
  }

  async function browse(scope, id, prefix) {
    requireFeature(scope);
    owned(scope, id);
    return backup().inspect(id, prefix || 'homedir', scope.ownerPrincipal);
  }

  // Streams the archive by looping the root-side range op; headers are sent
  // only once the first range succeeded so an error still gets a JSON body.
  async function download(scope, id, res, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.retention_class !== 'panel') throw new HttpError(403, 'not_downloadable', 'Only backups generated or uploaded from the panel can be downloaded');
    if (!row.local_present || !row.path || row.status !== 'done') throw conflict('The archive is not available on local disk');
    const first = await op('backup.archive.read_range', { archive: row.path, offset: 0, length: RANGE_BYTES }, req);
    audit(req, scope, { action: 'panel.backup.download', args: { backupId: row.id, name: path.basename(row.path), sizeBytes: first.size } });
    res.status(200);
    res.setHeader('Content-Type', row.path.endsWith('.gz') ? 'application/gzip' : 'application/x-tar');
    res.setHeader('Content-Length', String(first.size));
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(row.path).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    let chunk = first;
    let sent = 0;
    for (;;) {
      if (res.destroyed || res.writableEnded) return { sent, aborted: true };
      if (chunk.length) {
        const ok = res.write(Buffer.from(chunk.data, 'base64'));
        sent += chunk.length;
        if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      }
      if (chunk.eof || sent >= first.size) break;
      try {
        chunk = await op('backup.archive.read_range', { archive: row.path, offset: sent, length: Math.min(RANGE_BYTES, first.size - sent) }, req);
      } catch (err) {
        logger.warn({ err, backupId: row.id }, 'backup download interrupted');
        res.destroy(err);
        return { sent, aborted: true };
      }
      if (chunk.size !== first.size) { res.destroy(new Error('archive changed during download')); return { sent, aborted: true }; }
    }
    res.end();
    return { sent, aborted: false };
  }

  function restore(scope, id, { paths, overwrite = false }, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.status !== 'done') throw conflict('Only completed backups can be restored');
    if (!paths?.length) throw badRequest('Choose at least one file or directory to restore');
    const r = backup().enqueueRestore({ backupId: row.id, kind: 'files', options: { paths, overwrite: Boolean(overwrite) } }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.backup.restore', args: { backupId: row.id, paths: paths.length, overwrite: Boolean(overwrite), job: r.job.id } });
    return { job: { id: r.job.id }, restore: r.restore };
  }

  async function remove(scope, id, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.retention_class !== 'panel') throw new HttpError(403, 'not_deletable', 'Only backups generated or uploaded from the panel can be deleted here');
    const r = await backup().deleteBackup(id, { remote: true }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.backup.delete', args: { backupId: id, name: row.path ? path.basename(row.path) : null } });
    return { id, deleted: true, local: r.local ?? null };
  }

  function restores(scope) {
    requireFeature(scope);
    return stmts.restores.all(scope.username).map((r) => ({ id: r.id, backup_id: r.backup_id, kind: r.kind, status: r.status, error: r.error, options: json.parse(r.options_json, {}), summary: json.parse(r.summary_json, {}), created_at: r.created_at, finished_at: r.finished_at, job_id: r.job_id }));
  }

  // ------------------------------------------------------------- uploads ---

  const shapeUpload = (u) => ({ id: u.id, name: u.name, size: u.size, received: u.received, chunks: u.chunks, chunkBytes: UPLOAD_CHUNK_BYTES });

  function uploadOwned(scope, id) {
    const u = uploads.get(id);
    if (!u || u.accountId !== scope.accountId) throw notFound('Upload');
    u.touched = Date.now();
    return u;
  }

  async function beginUpload(scope, { name, size }, req) {
    requireFeature(scope);
    const dir = localDir();
    for (const [id, u] of uploads) if (Date.now() - u.touched > UPLOAD_TTL_MS) uploads.delete(id);
    const taken = (p) => stmts.byPath.get(p) || [...uploads.values()].some((u) => u.path === p);
    let file = null;
    for (let i = 0; i < 120 && !file; i += 1) {
      const candidate = `${dir}/${uploadFileName(scope.username, name, new Date(Date.now() + i * 1000))}`;
      if (!taken(candidate)) file = candidate;
    }
    if (!file) throw conflict('Too many uploads for this account right now; try again in a minute');
    await op('fs.mkdir', { path: dir, mode: '0700', owner: 'root' }, req);
    const id = crypto.randomBytes(12).toString('hex');
    uploads.set(id, { id, accountId: scope.accountId, username: scope.username, name, path: file, size, received: 0, chunks: 0, started: false, touched: Date.now() });
    audit(req, scope, { action: 'panel.backup.upload.begin', args: { name, size, id } });
    return shapeUpload(uploads.get(id));
  }

  async function uploadChunk(scope, id, data, req) {
    const u = uploadOwned(scope, id);
    const bytes = Buffer.byteLength(data, 'base64');
    if (u.received + bytes > u.size) throw unprocessable('More data than announced', { data: ['Upload exceeds the declared size'] });
    await op('transfer.upload.append', { path: u.path, data, truncate: !u.started }, req);
    u.started = true; u.received += bytes; u.chunks += 1;
    return shapeUpload(u);
  }

  async function discardUpload(u, req) {
    uploads.delete(u.id);
    if (u.started) await agent.op('backup.archive.remove', { archive: u.path }, { req }).catch(() => {});
  }

  async function finishUpload(scope, id, req) {
    const u = uploadOwned(scope, id);
    if (u.received !== u.size) throw unprocessable(`Received ${u.received} of ${u.size} bytes`, { data: ['Upload is incomplete'] });
    let info;
    try {
      info = await op('backup.archive.info', { archive: u.path }, req, 1_800_000 + 60_000);
    } catch (err) {
      await discardUpload(u, req);
      throw err;
    }
    const claimed = info.metadata?.account?.username ?? info.username ?? null;
    if (info.username !== scope.username || (claimed && claimed !== scope.username)) {
      await discardUpload(u, req);
      audit(req, scope, { action: 'panel.backup.upload', result: 'error', args: { name: u.name, reason: 'wrong_account', claimed } });
      throw new HttpError(422, 'wrong_account', `The archive belongs to account "${claimed || 'unknown'}", not to ${scope.username}`);
    }
    const verify = await op('backup.archive.verify', { archive: u.path }, req, 3_600_000 + 60_000);
    uploads.delete(id);
    const { lastInsertRowid } = stmts.insert.run({ account_id: scope.accountId, account_name: scope.username, owner_id: scope.owner?.id ?? scope.ownerPrincipal?.id ?? null, path: u.path, size: verify.sizeBytes ?? info.sizeBytes ?? u.received, sha256: verify.sha256, components_json: JSON.stringify({ ...(info.components || {}), uploaded: true, originalName: u.name }) });
    audit(req, scope, { action: 'panel.backup.upload', args: { name: u.name, backupId: Number(lastInsertRowid), sizeBytes: u.received } });
    return shape(stmts.byId.get(lastInsertRowid, scope.username, scope.accountId));
  }

  async function abortUpload(scope, id, req) {
    const u = uploadOwned(scope, id);
    await discardUpload(u, req);
    audit(req, scope, { action: 'panel.backup.upload.abort', args: { name: u.name } });
    return { id, aborted: true };
  }

  return { list, generate, runGenerate, get, browse, download, restore, remove, restores, beginUpload, uploadChunk, finishUpload, abortUpload, uploadStatus: (scope, id) => shapeUpload(uploadOwned(scope, id)), INCLUDE };
}
