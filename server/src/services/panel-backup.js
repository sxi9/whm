import path from 'node:path';
import crypto from 'node:crypto';
import { json } from '../db/index.js';
import { notFound, conflict, forbidden, badRequest, unprocessable, HttpError, CapabilityError } from '../lib/errors.js';
import { featureDisabled } from './panel-databases.js';
import { sshWriteAllowed, SSH_DIR } from './panel-files.js';

// Customer panel: backups of one hosting account. Rows are read with the
// panel's own statements pinned to the account (never ctx.backup.listBackups);
// mutations go through ctx.backup with the account's owner principal, and only
// archives the panel generated or the customer uploaded (retention_class
// 'panel') can be downloaded or deleted (design §9.14). Scheduled system
// backups stay WHM-only. Uploaded archives are registered by the panel itself:
// ctx.backup.registerArchive is root-only by construction (§3.3), so a
// reseller-owned account could never reach it, and the archive's account is
// verified before the row is marked done.
//
// Archives land in the root-owned backup directory, outside the account's
// disk quota, so the panel keeps its own books: at most
// panel.backup.max_archives panel rows per account, their bytes (announced
// upload sizes included) within panel.backup.max_total_mb or the account's
// disk quota, one open upload per account, and every in-flight upload is a
// `backups` row with status 'uploading' so a restart, an expired session or a
// failed verification can always find and remove the file.

export const RANGE_BYTES = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1_310_720;
export const UPLOAD_NAME = /^(?!\.)[A-Za-z0-9._-]{1,200}\.(tar\.gz|tgz|tar)$/;
export const REL_PATH = /^(?![-/])(?!.*(^|\/)\.\.(\/|$))[^\0\n\r]{1,1024}$/;
export const UPLOAD_TTL_MS = 6 * 3600_000;
export const MAINTAIN_JOB = 'panel.backup.maintain';
export const MAINTAIN_SCHEDULE = { name: 'panel-backup-maintain', cron: '20 4 * * *' };
export const DEFAULTS = Object.freeze({
  'panel.backup.max_archives': 3,
  'panel.backup.max_upload_mb': 10240,
  'panel.backup.max_total_mb': null,
  'panel.backup.verify_cooldown_minutes': 60,
  'panel.backup.max_concurrent_verify': 1,
});
const MiB = 1024 * 1024;
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

// How long the panel waits for the root-side tar pass over a tenant-supplied
// archive: proportional to its size, never more than the agent's own limit.
export function verifyTimeoutMs(sizeBytes) {
  return Math.min(30 * 60_000, Math.max(60_000, 60_000 + Math.ceil((Number(sizeBytes) || 0) / (4 * MiB)) * 1000));
}

export function createPanelBackupService(ctx) {
  const { db, agent, settings, logger } = ctx;

  const stmts = {
    list: db.prepare('SELECT * FROM backups WHERE account_name = @username AND account_id = @accountId ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset'),
    count: db.prepare('SELECT COUNT(*) AS n FROM backups WHERE account_name = ? AND account_id = ?'),
    byId: db.prepare('SELECT * FROM backups WHERE id = ? AND account_name = ? AND account_id = ?'),
    byPath: db.prepare('SELECT id FROM backups WHERE path = ?'),
    markPanel: db.prepare("UPDATE backups SET retention_class = 'panel' WHERE id = ?"),
    panelUsage: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM backups WHERE account_id = ? AND retention_class = 'panel'"),
    panelRows: db.prepare("SELECT id, path, size, status, created_at, account_name FROM backups WHERE account_id = ? AND retention_class = 'panel' ORDER BY created_at ASC, id ASC"),
    panelAccounts: db.prepare("SELECT DISTINCT account_id FROM backups WHERE retention_class = 'panel' AND account_id IS NOT NULL"),
    openUploads: db.prepare("SELECT id FROM backups WHERE account_id = ? AND retention_class = 'panel' AND status = 'uploading'"),
    uploading: db.prepare("SELECT id, path, account_id, account_name, created_at FROM backups WHERE retention_class = 'panel' AND status = 'uploading'"),
    insertUpload: db.prepare(`INSERT INTO backups (account_id, account_name, owner_id, type, path, size, sha256, status, run_id, retention_class, components_json, error, local_present, created_at)
      VALUES (@account_id, @account_name, @owner_id, 'import', @path, @size, NULL, 'uploading', NULL, 'panel', @components_json, NULL, 1, datetime('now'))`),
    finishUpload: db.prepare("UPDATE backups SET status = 'done', size = @size, sha256 = @sha256, components_json = @components_json, local_present = 1 WHERE id = @id AND status = 'uploading'"),
    deleteRow: db.prepare('DELETE FROM backups WHERE id = ?'),
    restores: db.prepare('SELECT * FROM backup_restores WHERE account_name = ? ORDER BY id DESC LIMIT 50'),
    ownerById: db.prepare('SELECT id, username, role FROM users WHERE id = ?'),
    accountQuota: db.prepare('SELECT id, username, owner_id, disk_quota_mb, disk_used_mb FROM accounts WHERE id = ?'),
  };

  const uploads = new Map();
  const cooldowns = new Map();
  const verifyingFor = new Set();
  let verifying = 0;
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

  // ------------------------------------------------------------- policy ---

  function policy() {
    const num = (key) => { const v = Number(settings.get(key, DEFAULTS[key])); return Number.isFinite(v) ? v : DEFAULTS[key]; };
    const total = settings.get('panel.backup.max_total_mb', DEFAULTS['panel.backup.max_total_mb']);
    return {
      maxArchives: num('panel.backup.max_archives'),
      maxUploadMb: num('panel.backup.max_upload_mb'),
      maxTotalMb: total != null && Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : null,
      cooldownMs: num('panel.backup.verify_cooldown_minutes') * 60_000,
      maxConcurrentVerify: Math.max(1, num('panel.backup.max_concurrent_verify')),
    };
  }

  // What the account has in the backup directory and what it may still add:
  // the byte budget is the panel.backup.max_total_mb setting when set, else
  // the account's disk quota (its only storage limit); null means no byte
  // budget beyond the archive count.
  function budget(scope) {
    const p = policy();
    const account = stmts.accountQuota.get(scope.accountId) || {};
    const usage = stmts.panelUsage.get(scope.accountId);
    const running = runningJobFor(scope.username) ? 1 : 0;
    const totalMb = p.maxTotalMb ?? (Number(account.disk_quota_mb) > 0 ? Number(account.disk_quota_mb) : null);
    return {
      maxArchives: p.maxArchives, count: usage.n + running, usedBytes: Number(usage.bytes) || 0,
      totalBytes: totalMb == null ? null : totalMb * MiB, maxUploadBytes: p.maxUploadMb > 0 ? p.maxUploadMb * MiB : null,
      estimateBytes: (Number(account.disk_used_mb) || 0) * MiB,
    };
  }

  function assertRoom(scope, wantBytes) {
    const b = budget(scope);
    if (b.maxArchives > 0 && b.count >= b.maxArchives) throw new HttpError(409, 'limit_reached', `At most ${b.maxArchives} panel backup(s) can be kept per account; delete one before creating another`);
    if (b.totalBytes != null && b.usedBytes + wantBytes > b.totalBytes) throw new HttpError(409, 'limit_reached', `Panel backups may use at most ${Math.floor(b.totalBytes / MiB)} MB for this account (${Math.ceil(b.usedBytes / MiB)} MB in use, ${Math.ceil(wantBytes / MiB)} MB requested); delete a backup first`);
    return b;
  }

  function shapeBudget(scope) {
    const b = budget(scope);
    return { maxArchives: b.maxArchives || null, archives: b.count, usedMb: Math.ceil(b.usedBytes / MiB), totalMb: b.totalBytes == null ? null : Math.floor(b.totalBytes / MiB), maxUploadMb: b.maxUploadBytes == null ? null : Math.floor(b.maxUploadBytes / MiB) };
  }

  // Root-side tar passes over a tenant-supplied archive (verification, info,
  // browsing) are bounded in number: at most maxConcurrentVerify server-wide
  // and one per account at a time, so a crafted archive cannot keep more than
  // that many agent processes busy.
  async function withVerifySlot(scope, fn) {
    const { maxConcurrentVerify } = policy();
    if (verifying >= maxConcurrentVerify) throw new HttpError(409, 'busy', 'Another archive is being verified on this server right now; try again in a moment');
    if (verifyingFor.has(scope.accountId)) throw new HttpError(409, 'busy', 'An archive of this account is already being verified; try again in a moment');
    verifying += 1;
    verifyingFor.add(scope.accountId);
    try { return await fn(); } finally { verifying -= 1; verifyingFor.delete(scope.accountId); }
  }

  const isUploaded = (row) => Boolean(json.parse(row.components_json, {}).uploaded);
  const guarded = (scope, row, fn) => (isUploaded(row) ? withVerifySlot(scope, fn) : fn());

  // ------------------------------------------------------------- shapes ---

  function shape(row) {
    const components = json.parse(row.components_json, {});
    const ready = row.status === 'done';
    return {
      id: row.id, account: row.account_name, type: row.type, name: row.path ? path.basename(row.path) : null, size: row.size, sha256: row.sha256,
      status: row.status, error: row.error, created_at: row.created_at, retention_class: row.retention_class, pinned: Boolean(row.pinned), local_present: Boolean(row.local_present),
      kind: components.include ? (components.include.dbs ? 'full' : 'home') : row.type === 'import' ? 'upload' : 'full',
      components, panelOwned: row.retention_class === 'panel', downloadable: row.retention_class === 'panel' && ready && Boolean(row.local_present) && Boolean(row.path),
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
    return { data: rows.map(shape), meta: { page, pageSize, total: stmts.count.get(scope.username, scope.accountId).n, running: running ? { id: running.id, status: running.status, kind: running.params?.kind ?? null } : null, kinds: Object.keys(INCLUDE), limits: shapeBudget(scope) } };
  }

  // ----------------------------------------------------------- generate ---

  function generate(scope, { kind }, req) {
    requireFeature(scope);
    backup();
    const running = runningJobFor(scope.username);
    if (running) throw new HttpError(409, 'busy', `A backup of ${scope.username} is already ${running.status} (job ${running.id})`);
    const b = assertRoom(scope, budget(scope).estimateBytes);
    const job = ctx.jobs.enqueue('panel.backup.generate', { username: scope.username, accountId: scope.accountId, kind, ownerId: scope.ownerPrincipal?.id ?? null, actor: scope.actor?.username ?? null }, { userId: scope.actor?.id || null });
    audit(req, scope, { action: 'panel.backup.generate', args: { kind, job: job.id, archives: b.count } });
    return { job: { id: job.id }, kind };
  }

  // The job acts as the account's owner, read back at run time: a missing or
  // changed owner fails the job rather than widening to a root principal, so
  // ctx.backup.archiveAccount always checks ownership and audits truthfully.
  function ownerRequest(params, account) {
    const owner = params.ownerId != null ? stmts.ownerById.get(params.ownerId) : null;
    if (!owner) throw new Error(`The owner of account "${params.username}" no longer exists; request the backup again`);
    if (account.owner_id !== owner.id) throw new Error(`Account "${params.username}" changed owner since the backup was requested; request it again`);
    const req = { user: { id: owner.id, username: owner.username, role: owner.role }, ip: null, id: null };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }

  async function runGenerate(job) {
    const { username, accountId, kind } = job.params;
    const account = db.prepare('SELECT id, owner_id FROM accounts WHERE id = ? AND username = ?').get(accountId, username);
    if (!account) throw new Error(`Account "${username}" no longer exists`);
    const req = ownerRequest(job.params, account);
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

  // ---------------------------------------------------------- read side ---

  async function get(scope, id) {
    requireFeature(scope);
    const row = owned(scope, id);
    let archive = null;
    if (row.local_present && row.path && row.status === 'done') {
      try { archive = await guarded(scope, row, () => backup().archiveInfo(id, scope.ownerPrincipal)); } catch (err) { if (isCapabilityMissing(err) || err?.code === 'busy') throw translate(err); archive = { error: err.message }; }
    }
    return { ...shape(row), archive };
  }

  async function browse(scope, id, prefix) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.status !== 'done') throw conflict('The archive is not complete yet');
    return guarded(scope, row, () => backup().inspect(id, prefix || 'homedir', scope.ownerPrincipal));
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

  // The same .ssh gate as the file manager (panel-files.sshWriteAllowed): a
  // restore may bring .ssh back only for a session login of an account with
  // shell access and the ssh feature; otherwise the paths may not name it and
  // the agent keeps the archive's homedir/.ssh (and every link) out.
  function restore(scope, id, { paths, overwrite = false }, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.status !== 'done') throw conflict('Only completed backups can be restored');
    if (!paths?.length) throw badRequest('Choose at least one file or directory to restore');
    const allowSsh = sshWriteAllowed(scope, req);
    if (!allowSsh) {
      const touchesSsh = (p) => { const clean = String(p).replace(/\/+$/, ''); return clean === '' || clean === '.' || clean.split('/')[0] === SSH_DIR; };
      if (paths.some(touchesSsh)) throw new HttpError(403, 'ssh_managed', `${SSH_DIR} is managed from Security › SSH keys and cannot be restored here; choose the files or directories to restore`);
    }
    const r = backup().enqueueRestore({ backupId: row.id, kind: 'files', options: { paths, overwrite: Boolean(overwrite), excludeSshDir: !allowSsh } }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.backup.restore', args: { backupId: row.id, paths: paths.length, overwrite: Boolean(overwrite), excludeSshDir: !allowSsh, job: r.job.id } });
    return { job: { id: r.job.id }, restore: r.restore };
  }

  async function remove(scope, id, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    if (row.retention_class !== 'panel') throw new HttpError(403, 'not_deletable', 'Only backups generated or uploaded from the panel can be deleted here');
    if (row.status === 'uploading') {
      const u = [...uploads.values()].find((x) => x.backupId === row.id);
      if (u) await discardUpload(u, req);
      else await removeArchiveRow(row, req);
      audit(req, scope, { action: 'panel.backup.delete', args: { backupId: id, name: row.path ? path.basename(row.path) : null, uploading: true } });
      return { id, deleted: true, local: null };
    }
    const r = await backup().deleteBackup(id, { remote: true }, scope.ownerPrincipal, req);
    audit(req, scope, { action: 'panel.backup.delete', args: { backupId: id, name: row.path ? path.basename(row.path) : null } });
    return { id, deleted: true, local: r.local ?? null };
  }

  function restores(scope) {
    requireFeature(scope);
    return stmts.restores.all(scope.username).map((r) => ({ id: r.id, backup_id: r.backup_id, kind: r.kind, status: r.status, error: r.error, options: json.parse(r.options_json, {}), summary: json.parse(r.summary_json, {}), created_at: r.created_at, finished_at: r.finished_at, job_id: r.job_id }));
  }

  // ------------------------------------------------------------- uploads ---

  const shapeUpload = (u) => ({ id: u.id, backupId: u.backupId, name: u.name, size: u.size, received: u.received, chunks: u.chunks, chunkBytes: UPLOAD_CHUNK_BYTES });

  function uploadOwned(scope, id) {
    const u = uploads.get(id);
    if (!u || u.accountId !== scope.accountId) throw notFound('Upload');
    const row = db.prepare("SELECT id FROM backups WHERE id = ? AND account_id = ? AND status = 'uploading'").get(u.backupId, scope.accountId);
    if (!row) { uploads.delete(id); throw notFound('Upload'); }
    u.touched = Date.now();
    return u;
  }

  // Removes the on-disk file (and sidecar) of an in-flight upload row and the
  // row itself; nothing else may reference it.
  async function removeArchiveRow(row, req) {
    let removed = null;
    if (row.path) {
      try { removed = (await agent.op('backup.archive.remove', { archive: row.path }, { req })).removed ?? null; } catch (err) { logger.warn({ err, path: row.path }, 'could not remove an abandoned panel upload'); removed = false; }
    }
    stmts.deleteRow.run(row.id);
    return removed;
  }

  async function discardUpload(u, req) {
    uploads.delete(u.id);
    const row = db.prepare('SELECT id, path FROM backups WHERE id = ?').get(u.backupId) || { id: u.backupId, path: u.path };
    return removeArchiveRow(row, req);
  }

  // Expired sessions, and 'uploading' rows with no session at all (the panel
  // restarted), are removed together with their files.
  async function sweep({ all = false } = {}) {
    const now = Date.now();
    const swept = [];
    for (const row of stmts.uploading.all()) {
      const u = [...uploads.values()].find((x) => x.backupId === row.id);
      const stale = !u ? all || now - Date.parse(`${row.created_at.replace(' ', 'T')}Z`) > UPLOAD_TTL_MS : now - u.touched > UPLOAD_TTL_MS;
      if (!stale) continue;
      if (u) uploads.delete(u.id);
      const removed = await removeArchiveRow(row, null);
      swept.push({ id: row.id, path: row.path, account: row.account_name, removed });
      ctx.auditRecord?.(null, { action: 'panel.backup.upload.expire', target: row.account_name, args: { backupId: row.id, name: row.path ? path.basename(row.path) : null, removed } });
    }
    for (const [id, u] of uploads) if (now - u.touched > UPLOAD_TTL_MS) uploads.delete(id);
    for (const [accountId, until] of cooldowns) if (until <= now) cooldowns.delete(accountId);
    return swept;
  }

  // Panel rows beyond the per-account cap (the setting was lowered, or rows
  // were created outside the panel's checks) are pruned oldest first; the
  // scheduled system backups keep their own retention classes.
  async function prune() {
    const { maxArchives } = policy();
    const pruned = [];
    if (!(maxArchives > 0)) return pruned;
    for (const { account_id: accountId } of stmts.panelAccounts.all()) {
      const rows = stmts.panelRows.all(accountId).filter((r) => r.status !== 'uploading');
      for (const row of rows.slice(0, Math.max(0, rows.length - maxArchives))) {
        const removed = await removeArchiveRow(row, null);
        pruned.push({ id: row.id, path: row.path, account: row.account_name, removed });
        ctx.auditRecord?.(null, { action: 'panel.backup.prune', target: row.account_name, args: { backupId: row.id, name: row.path ? path.basename(row.path) : null, removed, maxArchives } });
      }
    }
    return pruned;
  }

  async function maintain(job) {
    const swept = await sweep();
    const pruned = await prune();
    job?.log?.(`panel backups: ${swept.length} abandoned upload(s) removed, ${pruned.length} archive(s) pruned`);
    return { swept, pruned };
  }

  async function beginUpload(scope, { name, size }, req) {
    requireFeature(scope);
    const dir = localDir();
    await sweep();
    const until = cooldowns.get(scope.accountId);
    if (until && until > Date.now()) throw new HttpError(429, 'verify_cooldown', `The last uploaded archive could not be verified; uploads for this account reopen in ${Math.ceil((until - Date.now()) / 60_000)} minute(s)`);
    if (stmts.openUploads.get(scope.accountId)) throw new HttpError(409, 'busy', 'An upload is already in progress for this account; finish or abort it first');
    const b = budget(scope);
    if (b.maxUploadBytes != null && size > b.maxUploadBytes) throw unprocessable(`Uploads are limited to ${Math.floor(b.maxUploadBytes / MiB)} MB`, { size: [`At most ${Math.floor(b.maxUploadBytes / MiB)} MB per upload`] });
    if (b.totalBytes != null && size > b.totalBytes) throw unprocessable(`This account may keep at most ${Math.floor(b.totalBytes / MiB)} MB of panel backups`, { size: [`At most ${Math.floor(b.totalBytes / MiB)} MB per upload for this account`] });
    assertRoom(scope, size);
    const taken = (p) => stmts.byPath.get(p) || [...uploads.values()].some((u) => u.path === p);
    let file = null;
    for (let i = 0; i < 120 && !file; i += 1) {
      const candidate = `${dir}/${uploadFileName(scope.username, name, new Date(Date.now() + i * 1000))}`;
      if (!taken(candidate)) file = candidate;
    }
    if (!file) throw conflict('Too many uploads for this account right now; try again in a minute');
    await op('fs.mkdir', { path: dir, mode: '0700', owner: 'root' }, req);
    const { lastInsertRowid } = stmts.insertUpload.run({ account_id: scope.accountId, account_name: scope.username, owner_id: scope.owner?.id ?? scope.ownerPrincipal?.id ?? null, path: file, size, components_json: JSON.stringify({ uploaded: true, originalName: name, inProgress: true }) });
    const id = crypto.randomBytes(12).toString('hex');
    uploads.set(id, { id, backupId: Number(lastInsertRowid), accountId: scope.accountId, username: scope.username, name, path: file, size, received: 0, chunks: 0, started: false, writing: false, touched: Date.now() });
    audit(req, scope, { action: 'panel.backup.upload.begin', args: { name, size, id, backupId: Number(lastInsertRowid) } });
    return shapeUpload(uploads.get(id));
  }

  // Chunks are serialised per upload and the byte count is reserved before the
  // append, so two concurrent chunks cannot both pass the size check; the
  // agent's reported file size is the final word on what was received.
  async function uploadChunk(scope, id, data, req) {
    const u = uploadOwned(scope, id);
    if (u.writing) throw new HttpError(409, 'busy', 'A chunk of this upload is still being written; send chunks one at a time');
    const bytes = Buffer.byteLength(data, 'base64');
    if (u.received + bytes > u.size) throw unprocessable('More data than announced', { data: ['Upload exceeds the declared size'] });
    u.writing = true;
    u.received += bytes;
    let r;
    try {
      r = await op('transfer.upload.append', { path: u.path, data, truncate: !u.started }, req);
    } catch (err) {
      u.received -= bytes;
      u.writing = false;
      throw err;
    }
    u.writing = false;
    u.started = true;
    u.chunks += 1;
    if (typeof r?.size === 'number' && r.size !== u.received) {
      await discardUpload(u, req);
      audit(req, scope, { action: 'panel.backup.upload.abort', result: 'error', args: { name: u.name, reason: 'size_drift', expected: u.received, onDisk: r.size } });
      throw unprocessable('The upload no longer matches what was sent; start it again', { data: ['Upload discarded'] });
    }
    return shapeUpload(u);
  }

  async function finishUpload(scope, id, req) {
    const u = uploadOwned(scope, id);
    if (u.writing) throw new HttpError(409, 'busy', 'A chunk of this upload is still being written');
    if (u.received !== u.size) {
      await discardUpload(u, req);
      audit(req, scope, { action: 'panel.backup.upload.abort', result: 'error', args: { name: u.name, reason: 'incomplete', received: u.received, size: u.size } });
      throw unprocessable(`Received ${u.received} of ${u.size} bytes; the upload was discarded`, { data: ['Upload is incomplete'] });
    }
    return withVerifySlot(scope, async () => {
      const timeout = verifyTimeoutMs(u.size);
      let info;
      let verify;
      try {
        info = await op('backup.archive.info', { archive: u.path }, req, timeout);
        const claimed = info.metadata?.account?.username ?? info.username ?? null;
        if (info.username !== scope.username || (claimed && claimed !== scope.username)) throw Object.assign(new HttpError(422, 'wrong_account', `The archive belongs to account "${claimed || 'unknown'}", not to ${scope.username}`), { claimed });
        verify = await op('backup.archive.verify', { archive: u.path }, req, timeout);
        if (typeof verify.sizeBytes === 'number' && verify.sizeBytes !== u.size) throw new HttpError(422, 'size_mismatch', `The archive on disk is ${verify.sizeBytes} bytes, ${u.size} were announced`);
      } catch (err) {
        await discardUpload(u, req);
        const reason = err?.code === 'wrong_account' || err?.code === 'size_mismatch' ? err.code : 'verify_failed';
        if (reason === 'verify_failed') cooldowns.set(scope.accountId, Date.now() + policy().cooldownMs);
        audit(req, scope, { action: 'panel.backup.upload', result: 'error', args: { name: u.name, reason, claimed: err?.claimed ?? null, error: err.message } });
        throw err;
      }
      uploads.delete(id);
      const changed = stmts.finishUpload.run({ id: u.backupId, size: verify.sizeBytes ?? info.sizeBytes ?? u.received, sha256: verify.sha256, components_json: JSON.stringify({ ...(info.components || {}), uploaded: true, originalName: u.name }) }).changes;
      if (!changed) { await removeArchiveRow({ id: u.backupId, path: u.path }, req); throw conflict('The upload was removed while it was being verified'); }
      audit(req, scope, { action: 'panel.backup.upload', args: { name: u.name, backupId: u.backupId, sizeBytes: u.received } });
      return shape(stmts.byId.get(u.backupId, scope.username, scope.accountId));
    });
  }

  async function abortUpload(scope, id, req) {
    const u = uploadOwned(scope, id);
    await discardUpload(u, req);
    audit(req, scope, { action: 'panel.backup.upload.abort', args: { name: u.name } });
    return { id, aborted: true };
  }

  return {
    list, generate, runGenerate, get, browse, download, restore, remove, restores,
    beginUpload, uploadChunk, finishUpload, abortUpload, uploadStatus: (scope, id) => shapeUpload(uploadOwned(scope, id)),
    sweep, prune, maintain, budget: shapeBudget, policy, INCLUDE,
  };
}
