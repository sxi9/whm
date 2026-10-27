import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { newId, json } from '../../shared/db.js';
import * as pkg from '../lib/package.js';
import * as rules from '../lib/scanner-rules.js';

const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;

// §18.3 automated checks: any reject → scan_failed with the report attached;
// otherwise in_review with the flags attached and an open reviews row.
export function createScannerService(m) {
  const { ctx, db, cfg } = m;

  function av(dir) {
    const cmd = cfg.scan.av_command;
    if (!Array.isArray(cmd) || !cmd.length) return Promise.resolve({ ran: false });
    return new Promise((resolve) => {
      execFile(cmd[0], [...cmd.slice(1), dir], { timeout: 120_000 }, (err, stdout) => {
        if (!err) return resolve({ ran: true, infected: false });
        resolve({ ran: true, infected: true, detail: String(stdout || err.message).slice(0, 500) });
      });
    });
  }

  function typosquat(plugin, manifest) {
    const findings = [];
    const forms = [...new Set([rules.skeleton(manifest.name), rules.skeleton(plugin.slug), rules.skeleton(manifest.id.split('.').slice(2).join('.'))].filter(Boolean))];
    const others = db.prepare('SELECT id, name, name_skeleton, slug, status, developer_id FROM plugins WHERE developer_id != ?').all(plugin.developer_id);
    const candidates = [
      ...others.flatMap((o) => [{ what: `plugin ${o.id}`, status: o.status, forms: [o.name_skeleton, rules.skeleton(o.slug), rules.skeleton(o.id.split('.').slice(2).join('.'))] }]),
      ...cfg.bundled_ids.map((id) => ({ what: `bundled ${id}`, status: 'listed', forms: [rules.skeleton(id.split('.').slice(2).join('.')), rules.skeleton(id)] })),
      ...[...rules.RESERVED_BRANDS, ...cfg.reserved_brands].map((b) => ({ what: `brand ${b}`, status: 'brand', forms: [rules.skeleton(b)] })),
    ];
    for (const c of candidates) {
      for (const f of forms) for (const cf of c.forms.filter(Boolean)) {
        const d = rules.damerauLevenshtein(f, cf);
        if (d === 0 && (c.status === 'listed' || c.status === 'brand')) findings.push({ rule: 'typosquat', action: 'reject', detail: `"${f}" is identical to ${c.what}` });
        else if (d <= 2) findings.push({ rule: 'typosquat', action: 'flag', detail: `"${f}" resembles ${c.what} (distance ${d})` });
      }
    }
    const seen = new Set();
    return findings.filter((x) => !seen.has(x.detail) && seen.add(x.detail)).sort((a, b) => (a.action === 'reject' ? -1 : 1) - (b.action === 'reject' ? -1 : 1));
  }

  async function run(version, plugin, root) {
    const manifest = json.parse(version.manifest_json, {});
    const findings = [];
    const add = (file, f) => findings.push({ file, ...f });
    const vr = pkg.validateManifest(manifest);
    if (!vr.ok) add('plugin.json', { rule: 'manifest', action: 'reject', detail: vr.errors.map((e) => `${e.path}: ${e.message}`).join('; ') });
    if (manifest.id !== plugin.id) add('plugin.json', { rule: 'manifest', action: 'reject', detail: `id ${manifest.id} ≠ ${plugin.id}` });
    if (!cfg.host_api_versions.some((h) => { try { return pkg.semver.satisfies(h, manifest.engines?.whm || ''); } catch { return false; } })) add('plugin.json', { rule: 'engines', action: 'reject', detail: `engines.whm "${manifest.engines?.whm}" does not intersect the supported host versions ${cfg.host_api_versions.join(', ')}` });
    if (!/\.js$/.test(manifest.main || '')) add('plugin.json', { rule: 'entry_point', action: 'reject', detail: `main must be a .js file (got ${manifest.main})` });
    const scopes = manifest.permissions || [];
    const just = json.parse(version.permission_justifications_json, {});
    for (const s of scopes) if (!just[s] || String(just[s]).trim().length < 20) add('plugin.json', { rule: 'permission_justification', action: 'reject', detail: `scope ${s} needs a justification of at least 20 characters` });
    const highRisk = scopes.some((s) => rules.HIGH_RISK_SCOPES.includes(s) || s.startsWith('agent:op:') || s.startsWith('net:outbound:'));
    const files = pkg.fileList(root);
    if (files.length > pkg.MAX_ENTRIES) add('', { rule: 'size', action: 'reject', detail: `more than ${pkg.MAX_ENTRIES} entries` });
    for (const f of files) {
      if (f.path === pkg.DEV_SIGNATURE_FILE) continue;
      if (!rules.fileTypeAllowed(f.path)) { add(f.path, { rule: 'file_type', action: 'reject', detail: 'file type outside the allow-list' }); continue; }
      if (/(^|\/)node_modules\//.test(f.path) && /\.(node|so|dll|dylib)$/i.test(f.path)) add(f.path, { rule: 'file_type', action: 'reject', detail: 'native binary under node_modules' });
      if (f.bytes > MAX_SCAN_FILE_BYTES || !pkg.isTextPath(f.path)) continue;
      const text = fs.readFileSync(path.join(root, f.path), 'utf8');
      for (const code of rules.scanSecrets(text)) add(f.path, { rule: 'secret', action: 'reject', detail: code });
      const ext = path.extname(f.path).toLowerCase();
      if (['.js', '.cjs'].includes(ext)) {
        if (rules.looksMinified(text) && !files.some((o) => o.path === `${f.path}.map`)) add(f.path, { rule: 'minified_bundle', action: 'reject', detail: 'minified bundle over 1 MiB without a source map' });
        for (const x of rules.scanSource(text, { scopes, matchesNetScope: pkg.sdk.matchesNetScope })) add(f.path, { rule: x.rule, action: x.action, line: x.line, detail: x.detail });
      }
    }
    for (const f of typosquat(plugin, manifest)) add('plugin.json', f);
    const avResult = await av(root);
    if (avResult.infected) add('', { rule: 'av', action: 'reject', detail: avResult.detail });
    const rejects = findings.filter((f) => f.action === 'reject');
    const flags = findings.filter((f) => f.action === 'flag');
    return { ok: rejects.length === 0, risk: highRisk ? 'high' : 'normal', rejects, flags, files: files.length, extracted_bytes: files.reduce((n, f) => n + f.bytes, 0), av: avResult, scanned_at: m.nowIso() };
  }

  const svc = {
    // scan(versionId, { root }) — `root` is the already unpacked, wrapper-stripped
    // tree when the upload just produced it; otherwise the stored upload is unpacked.
    async scan(versionId, { root = null } = {}) {
      const version = m.submissions.versionById(versionId);
      const plugin = m.submissions.get(version.plugin_id);
      db.prepare("UPDATE plugin_versions SET status = 'scanning' WHERE id = ?").run(versionId);
      let unpacked = null;
      try {
        if (!root) { unpacked = pkg.unpack(fs.readFileSync(version.upload_file), { maxBytes: cfg.max_package_bytes }); root = pkg.stripWrapper(unpacked); }
        const report = await run(version, plugin, root);
        const status = report.ok ? 'in_review' : 'scan_failed';
        db.transaction(() => {
          db.prepare('UPDATE plugin_versions SET status = ?, risk = ?, scan_report_json = ? WHERE id = ?').run(status, report.risk, JSON.stringify(report), versionId);
          if (status === 'in_review') m.review.open(versionId);
        })();
        const dev = m.developers.get(plugin.developer_id);
        m.audit({ principal: 'system', role: 'system', ip: null, action: 'version.scan', target: `${plugin.id}@${version.version}`, args: { rejects: report.rejects.length, flags: report.flags.length, risk: report.risk }, result: report.ok ? 'ok' : 'error:scan_failed' });
        m.webhook(plugin.developer_id, 'version.scan_completed', { plugin_id: plugin.id, version: version.version, ok: report.ok, risk: report.risk, rejects: report.rejects.length, flags: report.flags.length });
        m.mail(dev.email, 'dev.submission_scanned', { display_name: dev.display_name, plugin_id: plugin.id, version: version.version, ok: report.ok, rejects: report.rejects.map((r) => `${r.file}: ${r.rule} ${r.detail || ''}`) });
        ctx.metrics?.inc('market_scans_total', { result: status });
        return report;
      } finally {
        unpacked?.cleanup();
      }
    },
    async scanQueue(limit = 20) {
      const rows = db.prepare("SELECT v.id FROM plugin_versions v JOIN plugins p ON p.id = v.plugin_id JOIN developers d ON d.id = p.developer_id WHERE v.status IN ('uploaded', 'scanning') AND d.status != 'suspended' ORDER BY v.created_at LIMIT ?").all(limit);
      for (const r of rows) { try { await svc.scan(r.id); } catch (err) { ctx.logger.error({ err, version: r.id }, 'scan failed'); } }
      return { scanned: rows.length };
    },
    queueAge() {
      const row = db.prepare("SELECT MIN(created_at) AS oldest FROM plugin_versions WHERE status IN ('uploaded', 'scanning')").get();
      return row?.oldest ? Math.round((m.now() - new Date(row.oldest).getTime()) / 1000) : 0;
    },
    typosquat,
  };
  return svc;
}
