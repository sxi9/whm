import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';
import * as pkg from '../lib/package.js';

const REASON_CODES = ['undeclared_permission', 'unjustified_permission', 'dangerous_code', 'policy', 'quality', 'metadata', 'other'];

// Minimal unified diff of two texts (LCS on lines).
export function unifiedDiff(a, b, { path = '' } = {}) {
  const A = a.split('\n'); const B = b.split('\n');
  const n = A.length; const k = B.length;
  if (n * k > 4_000_000) return `--- ${path}\n+++ ${path}\n@@ (file too large to diff) @@\n`;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [];
  let i = 0; let j = 0;
  while (i < n || j < k) {
    if (i < n && j < k && A[i] === B[j]) { lines.push(` ${A[i]}`); i++; j++; }
    else if (j < k && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { lines.push(`+${B[j]}`); j++; }
    else { lines.push(`-${A[i]}`); i++; }
  }
  if (!lines.some((l) => l[0] !== ' ')) return '';
  return `--- ${path}\n+++ ${path}\n@@ -1,${n} +1,${k} @@\n${lines.join('\n')}\n`;
}

// Human review (§18.3): queue, detail with the diff since the last published
// version, approve (→ signing), request changes, reject; two reviewers for
// high-risk versions when review.require_two_reviewers_for_high_risk.
export function createReviewService(m) {
  const { db, cfg } = m;
  const stmts = {
    byId: db.prepare('SELECT * FROM reviews WHERE id = ?'),
    openFor: db.prepare("SELECT * FROM reviews WHERE version_id = ? AND state = 'open'"),
    insert: db.prepare('INSERT INTO reviews (id, version_id, state, diff_base_version_id, created_at) VALUES (?, ?, \'open\', ?, ?)'),
    decide: db.prepare('UPDATE reviews SET state = @state, reviewer_id = @reviewer_id, reasons_json = @reasons_json, notes_md = @notes_md, checklist_json = @checklist_json, approvals_json = @approvals_json, decided_at = @decided_at WHERE id = @id'),
    approvals: db.prepare('UPDATE reviews SET approvals_json = ?, checklist_json = ?, notes_md = COALESCE(?, notes_md) WHERE id = ?'),
    filesOf: db.prepare('SELECT path, sha256, bytes, text FROM plugin_files WHERE version_id = ? ORDER BY path'),
  };

  function view(r) {
    return { id: r.id, version_id: r.version_id, reviewer_id: r.reviewer_id, state: r.state, checklist: json.parse(r.checklist_json, {}), reasons: json.parse(r.reasons_json, []), notes_md: r.notes_md, diff_base_version_id: r.diff_base_version_id, approvals: json.parse(r.approvals_json, []), created_at: r.created_at, decided_at: r.decided_at };
  }
  function get(id) {
    const row = stmts.byId.get(id);
    if (!row) throw notFound('Review');
    return row;
  }
  function assertOpen(r) {
    if (r.state !== 'open') throw new HttpError(409, 'review_closed', `This review was already ${r.state}`);
    const v = m.submissions.versionById(r.version_id);
    if (v.status !== 'in_review') throw new HttpError(409, 'review_closed', `The version is ${v.status}`);
    return v;
  }
  function validateReasons(reasons) {
    if (!Array.isArray(reasons) || !reasons.length) throw new HttpError(422, 'validation_failed', 'At least one reason { code, path?, text } is required');
    return reasons.map((r) => {
      if (!REASON_CODES.includes(r.code)) throw new HttpError(422, 'validation_failed', `reason code must be one of ${REASON_CODES.join(', ')}`);
      return { code: r.code, path: r.path ? String(r.path).slice(0, 200) : null, text: String(r.text || '').slice(0, 2000) };
    });
  }
  function diff(versionId, baseId) {
    const cur = stmts.filesOf.all(versionId);
    const base = baseId ? stmts.filesOf.all(baseId) : [];
    const baseBy = new Map(base.map((f) => [f.path, f]));
    const curBy = new Map(cur.map((f) => [f.path, f]));
    const files = [];
    const patches = [];
    for (const f of cur) {
      const b = baseBy.get(f.path);
      if (!b) { files.push({ path: f.path, change: 'added', bytes: f.bytes }); if (f.text != null) patches.push(unifiedDiff('', f.text, { path: f.path })); }
      else if (b.sha256 !== f.sha256) { files.push({ path: f.path, change: 'modified', bytes: f.bytes }); if (f.text != null && b.text != null) patches.push(unifiedDiff(b.text, f.text, { path: f.path })); }
    }
    for (const b of base) if (!curBy.has(b.path)) files.push({ path: b.path, change: 'removed', bytes: b.bytes });
    return { base_version_id: baseId, files, patch: patches.filter(Boolean).join('\n') };
  }

  const svc = {
    REASON_CODES, view, get, diff, unifiedDiff,
    open(versionId) {
      const existing = stmts.openFor.get(versionId);
      if (existing) return existing;
      const v = m.submissions.versionById(versionId);
      const base = m.submissions.versionsOf(v.plugin_id).filter((x) => x.id !== v.id && ['published', 'yanked', 'revoked'].includes(x.status)).sort((a, b) => pkg.semver.compare(b.version, a.version))[0];
      const id = newId('rvw', m.now());
      stmts.insert.run(id, versionId, base?.id || null, m.nowIso());
      db.prepare('UPDATE plugin_versions SET review_id = ? WHERE id = ?').run(id, versionId);
      return stmts.byId.get(id);
    },
    queue(query = {}) {
      const where = ["r.state = 'open'", "v.status = 'in_review'"];
      const params = {};
      if (query.risk) { where.push('v.risk = @risk'); params.risk = query.risk; }
      const page = paginate(db, {
        select: 'r.id, r.version_id, r.created_at, r.approvals_json, v.plugin_id, v.version, v.channel, v.risk, v.scan_report_json, p.name, p.developer_id, d.display_name AS developer_name, d.status AS developer_status',
        from: 'reviews r JOIN plugin_versions v ON v.id = r.version_id JOIN plugins p ON p.id = v.plugin_id JOIN developers d ON d.id = p.developer_id', where, params, sortable: { created_at: 'r.created_at', risk: 'v.risk' }, defaultSort: 'created_at', query,
      });
      return { ...page, data: page.data.map((r) => ({ ...r, approvals: json.parse(r.approvals_json, []).length, flags: json.parse(r.scan_report_json, {})?.flags?.length || 0, approvals_json: undefined, scan_report_json: undefined })) };
    },
    queueAge() {
      const row = db.prepare("SELECT MIN(created_at) AS oldest FROM reviews WHERE state = 'open'").get();
      return row?.oldest ? Math.round((m.now() - new Date(row.oldest).getTime()) / 1000) : 0;
    },
    detail(id) {
      const r = get(id);
      const v = m.submissions.versionById(r.version_id);
      const plugin = m.submissions.get(v.plugin_id);
      const manifest = json.parse(v.manifest_json, {});
      const just = json.parse(v.permission_justifications_json, {});
      const prev = r.diff_base_version_id ? m.submissions.versionById(r.diff_base_version_id) : null;
      const prevScopes = prev ? json.parse(prev.permissions_json, []) : [];
      return {
        review: view(r),
        version: m.submissions.shapeVersion(v, { full: true }),
        plugin: m.submissions.shapePlugin(plugin),
        developer: { ...m.developers.publicView(m.developers.get(plugin.developer_id)), rejections_90d: m.developers.rejectionsIn90Days(plugin.developer_id) },
        permissions: (manifest.permissions || []).map((s) => ({ scope: s, description: pkg.sdk.PERMISSIONS[s] || (s.startsWith('agent:op:') ? 'Run the named privileged agent operation' : s.startsWith('net:outbound:') ? 'Outbound HTTPS to the named host' : null), justification: just[s] || null, added: !prevScopes.includes(s) })),
        diff: diff(v.id, r.diff_base_version_id),
        assets: m.submissions.assetsOf(plugin.id),
        requires_two_reviewers: v.risk === 'high' && !!cfg.review.require_two_reviewers_for_high_risk,
      };
    },
    approve(id, { by, ip, notes = null, checklist = {} } = {}) {
      const r = get(id);
      const v = assertOpen(r);
      const approvals = json.parse(r.approvals_json, []);
      if (approvals.some((a) => a.by === by)) throw new HttpError(409, 'already_approved', 'You already approved this version');
      approvals.push({ by, at: m.nowIso() });
      const needTwo = v.risk === 'high' && !!cfg.review.require_two_reviewers_for_high_risk;
      if (needTwo && approvals.length < 2) {
        stmts.approvals.run(JSON.stringify(approvals), JSON.stringify(checklist), notes, id);
        m.audit({ principal: by, role: 'vendor', ip, action: 'review.approve_first', target: `${v.plugin_id}@${v.version}`, args: { review: id }, result: 'ok' });
        return { ...view(get(id)), pending_second_reviewer: true };
      }
      const signed = m.signing.signVersion(v.id, { by });
      stmts.decide.run({ id, state: 'approved', reviewer_id: by, reasons_json: '[]', notes_md: notes, checklist_json: JSON.stringify(checklist), approvals_json: JSON.stringify(approvals), decided_at: m.nowIso() });
      db.prepare("UPDATE plugin_versions SET status = 'approved' WHERE id = ?").run(v.id);
      svc.notify(v, 'approved', { reasons: [], by, ip, review: id });
      return { ...view(get(id)), signed };
    },
    requestChanges(id, { reasons, by, ip, notes = null } = {}) {
      const r = get(id);
      const v = assertOpen(r);
      const rs = validateReasons(reasons);
      stmts.decide.run({ id, state: 'changes_requested', reviewer_id: by, reasons_json: JSON.stringify(rs), notes_md: notes, checklist_json: r.checklist_json, approvals_json: r.approvals_json, decided_at: m.nowIso() });
      db.prepare("UPDATE plugin_versions SET status = 'changes_requested' WHERE id = ?").run(v.id);
      svc.notify(v, 'changes_requested', { reasons: rs, by, ip, review: id });
      return view(get(id));
    },
    reject(id, { reasons, by, ip, notes = null } = {}) {
      const r = get(id);
      const v = assertOpen(r);
      const rs = validateReasons(reasons);
      stmts.decide.run({ id, state: 'rejected', reviewer_id: by, reasons_json: JSON.stringify(rs), notes_md: notes, checklist_json: r.checklist_json, approvals_json: r.approvals_json, decided_at: m.nowIso() });
      db.prepare("UPDATE plugin_versions SET status = 'rejected' WHERE id = ?").run(v.id);
      svc.notify(v, 'rejected', { reasons: rs, by, ip, review: id });
      const plugin = m.submissions.get(v.plugin_id);
      const recent = db.prepare("SELECT COUNT(*) AS n FROM plugin_versions pv JOIN plugins p ON p.id = pv.plugin_id WHERE p.developer_id = ? AND pv.status = 'rejected' AND pv.created_at > ?").get(plugin.developer_id, m.nowIso(m.now() - 90 * 86_400_000)).n;
      if (recent >= 2) m.developers.triggerReverification(plugin.developer_id, 'two_rejections_90d', { by, ip });
      return view(get(id));
    },
    notify(v, outcome, { reasons, by, ip, review }) {
      const plugin = m.submissions.get(v.plugin_id);
      const dev = m.developers.get(plugin.developer_id);
      m.audit({ principal: by, role: 'vendor', ip, action: `review.${outcome}`, target: `${v.plugin_id}@${v.version}`, args: { review, reasons }, result: 'ok' });
      m.webhook(plugin.developer_id, 'version.review_decided', { plugin_id: v.plugin_id, version: v.version, outcome, reasons });
      m.mail(dev.email, 'dev.submission_reviewed', { display_name: dev.display_name, plugin_id: v.plugin_id, version: v.version, outcome, reasons: reasons.map((r) => `${r.code}${r.path ? ` (${r.path})` : ''}: ${r.text}`) });
    },
  };
  return svc;
}
