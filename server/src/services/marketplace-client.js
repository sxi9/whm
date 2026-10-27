import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { json } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { loadPluginSdk } from '../lib/plugin-sdk.js';
import { HOST_API_VERSION, MAX_PACKAGE_BYTES } from './plugins.js';

// Panel marketplace client (§18.6). It has no transport of its own: signed
// calls go through ctx.license.hub.request() (verified against the compiled-in
// license keys) and public catalog reads through ctx.license.transport with the
// hub URL the license owns. The Market Provider Manager's whm-hub row is only the
// enable switch; its origin must match the license hub or nothing is installed.

export const INSTALL_JOB = 'marketplace.install';
export const UPDATE_JOB = 'marketplace.update';
export const REVOCATIONS_JOB = 'marketplace.revocations';
export const UPDATE_CHECK_JOB = 'marketplace.update-check';
export const REVOCATIONS_SCHEDULE = 'marketplace-revocations';
export const UPDATE_CHECK_SCHEDULE = 'marketplace-update-check';
export const FEED_SKEW_S = 300;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
const SCOPE_RE = /^[a-z][a-z0-9:._*-]{0,160}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KID_RE = /^[0-9a-f]{8}$/;
const CHANNELS = new Set(['stable', 'beta']);

const nowIso = () => new Date().toISOString();
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const isHttps = (url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };
const uniq = (list) => [...new Set(list)];
const scopes = (list) => (Array.isArray(list) ? uniq(list.filter((s) => typeof s === 'string' && SCOPE_RE.test(s))).sort() : []);

export function createMarketplaceClient(ctx) {
  const { db, config, logger } = ctx;
  const log = logger.child ? logger.child({ module: 'marketplace' }) : logger;
  const semver = loadPluginSdk()?.semver ?? null;
  const cacheDir = path.join(config.dataDir, 'marketplace', 'cache');

  const stmts = {
    state: db.prepare('SELECT * FROM marketplace_state WHERE id = 1'),
    saveState: db.prepare(`UPDATE marketplace_state SET last_catalog_sync_at = @last_catalog_sync_at, last_revocation_ts = @last_revocation_ts, last_revocation_now = @last_revocation_now,
      revocations_head_ts = @revocations_head_ts, last_update_check_at = @last_update_check_at, pending_updates_json = @pending_updates_json, fail_count = @fail_count, updated_at = @updated_at WHERE id = 1`),
    installs: db.prepare('SELECT * FROM marketplace_installs ORDER BY plugin_id'),
    install: db.prepare('SELECT * FROM marketplace_installs WHERE plugin_id = ?'),
    upsertInstall: db.prepare(`INSERT INTO marketplace_installs (plugin_id, version, channel, package_sha256, hub_kid, consented_permissions_json, consented_by, consented_at, consent_state, was_enabled, installed_at, updated_at)
      VALUES (@plugin_id, @version, @channel, @package_sha256, @hub_kid, @consented_permissions_json, @consented_by, @consented_at, @consent_state, @was_enabled, datetime('now'), datetime('now'))
      ON CONFLICT (plugin_id) DO UPDATE SET version = excluded.version, channel = excluded.channel, package_sha256 = excluded.package_sha256, hub_kid = excluded.hub_kid,
        consented_permissions_json = excluded.consented_permissions_json, consented_by = excluded.consented_by, consented_at = excluded.consented_at, consent_state = excluded.consent_state,
        was_enabled = excluded.was_enabled, updated_at = excluded.updated_at`),
    consent: db.prepare(`UPDATE marketplace_installs SET consented_permissions_json = ?, consented_by = ?, consented_at = datetime('now'), consent_state = 'consented', was_enabled = 0, updated_at = datetime('now') WHERE plugin_id = ?`),
    removeInstall: db.prepare('DELETE FROM marketplace_installs WHERE plugin_id = ?'),
    plugin: db.prepare('SELECT id, version, state, source, signer, signed FROM plugins WHERE id = ?'),
    revocations: db.prepare('SELECT * FROM marketplace_revocations ORDER BY ts DESC, id DESC LIMIT 200'),
    revocation: db.prepare('SELECT * FROM marketplace_revocations WHERE id = ?'),
    unacked: db.prepare('SELECT * FROM marketplace_revocations WHERE acknowledged_at IS NULL ORDER BY ts DESC, id DESC'),
    unackedFor: db.prepare("SELECT id, severity, action, reason, version, ts FROM marketplace_revocations WHERE plugin_id = ? AND applied_at IS NOT NULL AND acknowledged_at IS NULL AND applied_to_json != '[]' ORDER BY ts DESC LIMIT 1"),
    insertRevocation: db.prepare(`INSERT OR IGNORE INTO marketplace_revocations (id, plugin_id, version, severity, action, reason, ts, applied_at, applied_to_json, acknowledged_by, acknowledged_at)
      VALUES (@id, @plugin_id, @version, @severity, @action, @reason, @ts, @applied_at, @applied_to_json, @acknowledged_by, @acknowledged_at)`),
    ack: db.prepare(`UPDATE marketplace_revocations SET acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ? AND acknowledged_at IS NULL`),
  };
  if (!stmts.state.get()) db.prepare('INSERT OR IGNORE INTO marketplace_state (id) VALUES (1)').run();

  const state = () => stmts.state.get();
  function saveState(patch) {
    const row = state();
    stmts.saveState.run({ ...row, ...patch, updated_at: nowIso() });
  }
  const pendingUpdates = () => json.parse(state().pending_updates_json, []) || [];

  // ---- identity: the license owns the hub ----------------------------------

  const license = () => {
    if (!ctx.license) throw new HttpError(503, 'license_unavailable', 'The license client is not available on this panel');
    return ctx.license;
  };
  const hubRow = () => { try { return ctx.market?.hub?.() ?? { enabled: false, url: null }; } catch { return { enabled: false, url: null }; } };
  const hubUrl = () => { try { return license().hubUrl(); } catch { return null; } };
  const developerMode = () => ctx.settings.get('plugins.developer_mode', false) === true;

  function status() {
    const row = hubRow();
    const url = hubUrl();
    const lic = ctx.license ? ctx.license.get() : null;
    const hubMismatch = Boolean(row.enabled) && (!url || !row.url || originOf(row.url) !== originOf(url));
    const st = state();
    syncSchedules(Boolean(row.enabled) && !hubMismatch);
    return {
      enabled: Boolean(row.enabled), url: row.url || null, hubUrl: url, hubMismatch, licenseStatus: lic?.status ?? null, licenseDegraded: lic ? lic.enforce && lic.degraded : false,
      hasToken: Boolean(lic && ctx.license.token()), hubKids: lic?.pluginSigningKids ?? [], conflictKids: lic?.conflictKids ?? [],
      lastRevocationTs: st.last_revocation_ts, revocationsHeadTs: st.revocations_head_ts, lastRevocationNow: st.last_revocation_now, lastUpdateCheckAt: st.last_update_check_at,
      pendingUpdates: pendingUpdates(), unacknowledgedRevocations: stmts.unacked.all().length, developerMode: developerMode(), hostVersion: HOST_API_VERSION, feedFailCount: st.fail_count,
    };
  }

  // Every marketplace action needs the hub row on and pointing at the license hub.
  function requireHub() {
    const s = status();
    if (!s.enabled) throw new HttpError(422, 'marketplace_disabled', 'The WHM marketplace hub is disabled: enable the whm-hub provider in Market Provider Manager');
    if (s.hubMismatch) throw new HttpError(409, 'hub_mismatch', `The whm-hub provider points at ${s.url || 'no URL'} but this panel's license was issued by ${s.hubUrl || 'no hub'}; the two must share an origin`);
    return s;
  }
  function requireLicensed() {
    const lic = license().get();
    if (lic.enforce && lic.degraded) throw new HttpError(423, 'license_degraded', `The license is ${lic.status}: marketplace installs resume once a valid license is active`, { status: lic.status });
    if (!license().token()) throw new HttpError(422, 'license_required', 'Activate a license (Basic Setup → License) before installing from the marketplace');
    return lic;
  }
  function requirePaidFeature(pricing) {
    const model = pricing && typeof pricing === 'object' ? pricing.model : 'free';
    if (!model || model === 'free') return;
    const lic = license().get();
    if (lic.enforce && !license().hasFeature('marketplace_paid')) throw new HttpError(403, 'feature_required', `Your ${lic.editionLabel || 'current'} license does not include paid marketplace plugins. Upgrade your license to install this plugin.`, { feature: ['marketplace_paid'] });
  }

  // ---- public catalog reads (unsigned GET through the license transport) ----

  async function publicGet(pathname, query = {}) {
    const base = requireHub().hubUrl;
    const url = new URL(pathname, base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (!isHttps(url.href)) throw new HttpError(422, 'hub_url_insecure', 'The marketplace hub must be reached over https://');
    let res;
    try {
      res = await license().transport.request(url.href, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': `whm-panel/${ctx.version}` }, timeoutMs: 30_000 });
    } catch (err) {
      throw new HttpError(503, 'hub_unreachable', `The marketplace hub at ${url.origin} could not be reached: ${err.message}`);
    }
    let parsed = null;
    try { parsed = JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')); } catch { parsed = null; }
    if (res.status >= 400 || !parsed || typeof parsed !== 'object' || parsed.error) {
      const code = parsed?.error?.code;
      if (res.status === 404) throw notFound(`Marketplace plugin ${pathname.split('/').slice(-1)[0]}`);
      throw new HttpError(502, typeof code === 'string' ? code : 'hub_error', parsed?.error?.message || `The marketplace hub answered HTTP ${res.status}`);
    }
    return { data: parsed.data, meta: parsed.meta ?? null };
  }

  function localState(id) {
    const row = stmts.plugin.get(id);
    const install = stmts.install.get(id);
    if (!row && !install) return null;
    return { version: row?.version ?? install?.version ?? null, state: row?.state ?? 'missing', source: row?.source ?? 'marketplace', consentState: install?.consent_state ?? null, marketplace: Boolean(install), update: pendingUpdates().find((u) => u.id === id) ?? null };
  }
  const annotate = (entry) => (entry && typeof entry === 'object' ? { ...entry, installed: localState(entry.id) } : entry);

  async function catalog(query = {}) {
    const res = await publicGet('/v1/market/catalog', { q: query.q, category: query.category, channel: query.channel, page: query.page, pageSize: query.pageSize, sort: query.sort, dir: query.dir, featured: query.featured });
    saveState({ last_catalog_sync_at: nowIso() });
    return { data: Array.isArray(res.data) ? res.data.map(annotate) : [], meta: res.meta ?? { page: 1, pageSize: 24, total: 0 } };
  }
  const categories = async () => (await publicGet('/v1/market/categories')).data;
  async function plugin(id) {
    const res = await publicGet(`/v1/market/plugins/${encodeURIComponent(id)}`, { host: HOST_API_VERSION });
    return annotate(res.data);
  }
  const versions = async (id) => (await publicGet(`/v1/market/plugins/${encodeURIComponent(id)}/versions`)).data;

  // ---- package download ----------------------------------------------------

  async function fetchPackage(url, { expectedSha, expectedBytes }) {
    if (!isHttps(url)) throw new HttpError(502, 'download_url_insecure', 'The hub issued a download URL that is not https://');
    let res;
    try {
      res = await license().transport.request(url, { method: 'GET', headers: { Accept: 'application/gzip', 'User-Agent': `whm-panel/${ctx.version}` }, timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes: MAX_PACKAGE_BYTES });
    } catch (err) {
      throw new HttpError(503, 'download_failed', `The package could not be downloaded: ${err.message}`);
    }
    if (res.status !== 200 || !Buffer.isBuffer(res.body)) {
      let code = 'download_failed';
      try { code = JSON.parse(res.body.toString('utf8')).error?.code || code; } catch { /* not JSON */ }
      throw new HttpError(res.status === 410 ? 410 : 502, code, `The hub answered HTTP ${res.status} for the package download`);
    }
    if (res.body.length > MAX_PACKAGE_BYTES) throw new HttpError(422, 'invalid_package', `package exceeds ${MAX_PACKAGE_BYTES} bytes`);
    if (Number.isInteger(expectedBytes) && expectedBytes !== res.body.length) throw new HttpError(422, 'sha256_mismatch', `The hub announced ${expectedBytes} bytes but ${res.body.length} arrived`);
    const sha = crypto.createHash('sha256').update(res.body).digest('hex');
    if (sha !== expectedSha) throw new HttpError(422, 'sha256_mismatch', 'The downloaded package does not match the sha256 in the signed descriptor');
    return res.body;
  }

  async function fingerprintFields() {
    const lic = license().get();
    if (lic.fingerprint) return { fingerprint: lic.fingerprint };
    try {
      const fp = await ctx.agent.op('sys.fingerprint', {});
      if (fp?.fingerprint) return { fingerprint: fp.fingerprint, fp_components: fp.components };
    } catch (err) { log.warn({ err: err.message }, 'fingerprint unavailable for the download descriptor'); }
    throw new HttpError(503, 'fingerprint_unavailable', 'The server fingerprint could not be read (is whm-agentd running?)');
  }

  // A job runs without an HTTP request; audit rows still name who asked for it.
  function jobRequest(params) {
    const req = { user: { id: params.userId ?? null, username: params.username || 'system', role: 'root' }, ip: params.ip ?? null, id: null, get: () => undefined };
    req.audit = (entry) => ctx.auditRecord?.(req, entry);
    return req;
  }
  const audit = (req, entry) => { try { if (typeof req?.audit === 'function') req.audit(entry); else ctx.auditRecord?.(req ?? null, entry); } catch (err) { log.warn({ err }, 'audit write failed'); } };
  function notify(event, payload) {
    try { const r = ctx.contacts?.notify?.(event, payload); if (r && typeof r.catch === 'function') r.catch((err) => log.warn({ err, event }, 'notification failed')); } catch (err) { log.warn({ err, event }, 'notification failed'); }
  }

  const requiredScopes = (id) => scopes(ctx.plugins.get(id).permissions);
  const covers = (granted, required) => required.every((s) => granted.includes(s));

  async function justificationsFor(id) {
    try {
      const detail = await plugin(id);
      return Object.fromEntries((detail?.permissions || []).filter((p) => p && typeof p.scope === 'string' && p.justification).map((p) => [p.scope, String(p.justification).slice(0, 500)]));
    } catch { return {}; }
  }

  // ---- install / update job ------------------------------------------------

  async function runInstall(jobCtx) {
    const p = jobCtx.params || {};
    const { pluginId } = p;
    const req = jobRequest(p);
    requireHub();
    requireLicensed();
    const previous = stmts.install.get(pluginId);
    const channel = CHANNELS.has(p.channel) ? p.channel : previous?.channel || 'stable';
    jobCtx.progress(5, 'requesting the download descriptor');
    const fp = await fingerprintFields();
    const body = { plugin_id: pluginId, ...(p.version ? { version: p.version } : {}), channel, token: license().token(), ...fp, panel_version: String(ctx.version || '0.0.0').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32) || '0.0.0', host_api: HOST_API_VERSION };
    const descriptor = (await license().hub.request('/v1/market/download', body)).data;
    if (!descriptor || typeof descriptor.url !== 'string' || !HEX64.test(descriptor.sha256 || '') || !VERSION_RE.test(descriptor.version || '')) throw new HttpError(502, 'hub_answer_invalid', 'The download descriptor is incomplete');
    const version = descriptor.version;
    if (previous && semver?.valid(previous.version) && semver.valid(version) && semver.compare(version, previous.version) < 0 && p.allowDowngrade !== true) {
      throw new HttpError(422, 'downgrade_refused', `${pluginId} ${previous.version} is installed; ${version} is older. Repeat with allowDowngrade to install it anyway.`);
    }
    const hubKids = license().pluginSigningKids();
    if (KID_RE.test(descriptor.kid || '') && !hubKids.includes(descriptor.kid)) jobCtx.log(`the hub signed this package with key ${descriptor.kid}, which this panel does not trust yet (check in to refresh the pinned keys)`, 'warn');
    jobCtx.progress(20, `downloading ${pluginId} ${version}`);
    const buffer = await fetchPackage(descriptor.url, { expectedSha: descriptor.sha256, expectedBytes: Number.isInteger(descriptor.bytes) ? descriptor.bytes : null });
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o750 });
    const cacheFile = path.join(cacheDir, `${pluginId}-${version}.whmplugin`);
    fs.writeFileSync(cacheFile, buffer, { mode: 0o640 });
    try {
      jobCtx.progress(55, 'verifying and installing the package');
      const installed = await ctx.plugins.install({ buffer, source: 'marketplace' }, { user: req.user, req, policy: { requireSigned: true, signers: hubKids, activate: false } });
      const id = installed.plugin.id;
      if (id !== pluginId) {
        await ctx.plugins.uninstall(id, { purge: false, req });
        throw new HttpError(422, 'plugin_id_mismatch', `The package declares plugin id ${id}, not ${pluginId}`);
      }
      const required = requiredScopes(id);
      const consented = scopes(previous ? json.parse(previous.consented_permissions_json, []) : []);
      const granted = Array.isArray(p.consent?.permissions) ? scopes(p.consent.permissions) : consented;
      const firstInstall = !previous;
      const shouldEnable = firstInstall || installed.wasEnabled === true || previous.was_enabled === 1;
      const base = { plugin_id: id, version: installed.plugin.version, channel, package_sha256: descriptor.sha256, hub_kid: installed.plugin.signer };
      if (covers(granted, required)) {
        stmts.upsertInstall.run({ ...base, consented_permissions_json: JSON.stringify(uniq([...granted, ...required]).sort()), consented_by: req.user.username, consented_at: nowIso(), consent_state: 'consented', was_enabled: 0 });
        if (shouldEnable) {
          jobCtx.progress(85, 'enabling');
          await ctx.plugins.enable(id, { from: installed.previousVersion && installed.previousVersion !== installed.plugin.version ? installed.previousVersion : undefined, req });
        }
        audit(req, { action: 'plugin.marketplace.install', target: id, args: { version: installed.plugin.version, previousVersion: installed.previousVersion, kid: installed.plugin.signer, sha256: descriptor.sha256, consent: 'consented', enabled: shouldEnable } });
        dropPendingUpdate(id);
        jobCtx.progress(100, 'installed');
        return { status: 'installed', pluginId: id, version: installed.plugin.version, enabled: shouldEnable };
      }
      stmts.upsertInstall.run({ ...base, consented_permissions_json: JSON.stringify(consented), consented_by: previous?.consented_by ?? null, consented_at: previous?.consented_at ?? null, consent_state: 'pending', was_enabled: shouldEnable ? 1 : 0 });
      const added = required.filter((s) => !consented.includes(s));
      audit(req, { action: 'plugin.marketplace.install', target: id, args: { version: installed.plugin.version, previousVersion: installed.previousVersion, kid: installed.plugin.signer, sha256: descriptor.sha256, consent: 'pending', added } });
      dropPendingUpdate(id);
      jobCtx.progress(100, 'installed; waiting for permission consent');
      return { status: 'pending_consent', pluginId: id, version: installed.plugin.version, required, added, justifications: await justificationsFor(id) };
    } finally {
      try { fs.rmSync(cacheFile, { force: true }); } catch { /* already gone */ }
    }
  }

  function dropPendingUpdate(id) {
    const list = pendingUpdates();
    if (list.some((u) => u.id === id)) saveState({ pending_updates_json: JSON.stringify(list.filter((u) => u.id !== id)) });
  }

  function installParams(input, user, req) {
    return { ...input, userId: user?.id ?? null, username: user?.username ?? 'system', ip: req?.ip ?? null };
  }

  async function install({ pluginId, version, channel, consent, allowDowngrade } = {}, user, req) {
    requireHub();
    requireLicensed();
    if (!ID_RE.test(pluginId || '')) throw new HttpError(422, 'validation_failed', 'Malformed plugin id', { pluginId: ['Reverse-DNS plugin id with at least three segments'] });
    const local = stmts.plugin.get(pluginId);
    if (local && local.source !== 'marketplace') throw new HttpError(409, 'not_marketplace', `${pluginId} is installed from ${local.source === 'bundled' ? 'the bundled plugins' : 'a sideloaded package'}; uninstall it before installing the marketplace version`);
    let detail = null;
    try { detail = await plugin(pluginId); } catch (err) { if (err.status === 404) throw err; log.warn({ err: err.message, pluginId }, 'catalog lookup failed before install; the hub decides at download time'); }
    if (detail) requirePaidFeature(detail.pricing);
    const job = ctx.jobs.enqueue(INSTALL_JOB, installParams({ pluginId, version, channel, consent: consent ? { permissions: scopes(consent.permissions) } : undefined, allowDowngrade: allowDowngrade === true }, user, req), { userId: user?.id ?? null });
    audit(req, { action: 'plugin.marketplace.install.request', target: pluginId, args: { version: version ?? null, channel: channel ?? null, allowDowngrade: allowDowngrade === true, job: job.id } });
    return { job };
  }

  async function update(id, user, req) {
    requireHub();
    requireLicensed();
    const row = stmts.install.get(id);
    if (!row) throw new HttpError(409, 'not_marketplace', `${id} was not installed from the marketplace; bundled and sideloaded plugins are never updated from the hub`);
    const pending = pendingUpdates().find((u) => u.id === id);
    let detail = null;
    try { detail = await plugin(id); } catch (err) { if (err.status === 404) throw err; }
    if (detail) requirePaidFeature(detail.pricing);
    const job = ctx.jobs.enqueue(UPDATE_JOB, installParams({ pluginId: id, version: pending?.latest, channel: row.channel }, user, req), { userId: user?.id ?? null });
    audit(req, { action: 'plugin.marketplace.update.request', target: id, args: { from: row.version, to: pending?.latest ?? 'latest', job: job.id } });
    return { job };
  }

  async function consent(id, permissions, user, req) {
    const row = stmts.install.get(id);
    if (!row) throw notFound(`Marketplace install "${id}"`);
    const required = requiredScopes(id);
    const granted = scopes(permissions);
    const missing = required.filter((s) => !granted.includes(s));
    if (missing.length) throw new HttpError(422, 'consent_incomplete', `The installed ${id} needs ${missing.length} more permission${missing.length === 1 ? '' : 's'}`, { permissions: missing });
    const shouldEnable = row.consent_state === 'pending' && (row.was_enabled === 1 || row.consented_at === null);
    stmts.consent.run(JSON.stringify(uniq([...granted, ...required]).sort()), user?.username ?? 'system', id);
    if (shouldEnable) await ctx.plugins.enable(id, { req });
    audit(req, { action: 'plugin.consent', target: id, args: { permissions: required, version: row.version, enabled: shouldEnable } });
    return { plugin: ctx.plugins.get(id), install: shapeInstall(stmts.install.get(id)) };
  }

  async function uninstall(id, { purge = false } = {}, user, req) {
    const row = stmts.install.get(id);
    if (!row) throw notFound(`Marketplace install "${id}"`);
    let result = { id, uninstalled: true, purged: Boolean(purge) };
    try { result = await ctx.plugins.uninstall(id, { purge, req }); } catch (err) { if (err.status !== 404) throw err; }
    stmts.removeInstall.run(id);
    dropPendingUpdate(id);
    audit(req, { action: 'plugin.marketplace.uninstall', target: id, args: { purge: Boolean(purge), version: row.version } });
    return result;
  }

  // ---- update feed ---------------------------------------------------------

  async function checkUpdates({ req = null } = {}) {
    requireHub();
    requireLicensed();
    const installed = stmts.installs.all().map((r) => ({ id: r.plugin_id, version: r.version }));
    if (!installed.length) { saveState({ last_update_check_at: nowIso(), pending_updates_json: '[]' }); return []; }
    const res = await license().hub.request('/v1/market/updates', { token: license().token(), installed, host: HOST_API_VERSION, channel: 'stable' });
    const before = new Set(pendingUpdates().map((u) => `${u.id}@${u.latest}`));
    const list = (Array.isArray(res.data) ? res.data : [])
      .filter((u) => u && typeof u === 'object' && ID_RE.test(u.id || '') && VERSION_RE.test(u.latest || '') && VERSION_RE.test(u.current || ''))
      .filter((u) => installed.some((i) => i.id === u.id) && u.latest !== u.current && (!semver || !semver.valid(u.latest) || !semver.valid(u.current) || semver.compare(u.latest, u.current) > 0))
      .map((u) => ({ id: u.id, current: u.current, latest: u.latest, channel: CHANNELS.has(u.channel) ? u.channel : 'stable', security: u.security === true, changelogUrl: typeof u.changelog_url === 'string' && isHttps(u.changelog_url) ? u.changelog_url : null }));
    saveState({ last_update_check_at: nowIso(), pending_updates_json: JSON.stringify(list) });
    const fresh = list.filter((u) => !before.has(`${u.id}@${u.latest}`));
    if (fresh.length) {
      audit(req, { action: 'plugin.update_available', target: fresh.map((u) => u.id).join(','), args: { updates: fresh } });
      notify('plugin.update_available', { subject: `${fresh.length} marketplace plugin update${fresh.length === 1 ? '' : 's'} available`, body: fresh.map((u) => `${u.id}: ${u.current} → ${u.latest}${u.security ? ' (security)' : ''}`).join('\n'), severity: fresh.some((u) => u.security) ? 'warning' : 'info', data: { updates: fresh } });
    }
    return list;
  }

  const updates = () => ({ pending: pendingUpdates(), lastCheckAt: state().last_update_check_at });

  // ---- revocations ---------------------------------------------------------

  function matchesLocally(rev, hubKids) {
    const row = stmts.plugin.get(rev.plugin_id);
    if (!row) return [];
    if (rev.version && row.version !== rev.version) return [];
    const trusted = row.signer && hubKids.includes(row.signer);
    if (trusted || rev.severity === 'critical') return [{ id: row.id, version: row.version, source: row.source, signer: row.signer, state: row.state, signed: Boolean(row.signed) }];
    return [];
  }

  async function pollRevocations({ req = null, reason = 'scheduled' } = {}) {
    const s = status();
    if (!s.enabled || s.hubMismatch) return { skipped: s.enabled ? 'hub_mismatch' : 'disabled', applied: [] };
    if (!license().token()) return { skipped: 'no_token', applied: [] };
    const st = state();
    const res = await license().hub.request('/v1/market/revocations', { token: license().token(), since: st.last_revocation_ts });
    const now = Math.floor((license().clock?.now?.() ?? Date.now()) / 1000);
    const meta = res.meta || {};
    const stale = (why) => {
      const next = (st.fail_count || 0) + 1;
      saveState({ fail_count: next });
      audit(req, { action: 'marketplace.feed_stale', target: 'revocations', args: { reason: why, now: meta.now ?? null, headTs: meta.head_ts ?? null, lastNow: st.last_revocation_now, storedHeadTs: st.revocations_head_ts }, result: 'error:hub_feed_stale' });
      throw new HttpError(502, 'hub_feed_stale', `The revocation feed was refused: ${why}`);
    };
    if (!Number.isInteger(meta.now) || Math.abs(meta.now - now) > FEED_SKEW_S) stale('its timestamp is more than 300 s from the panel clock');
    if (meta.now < st.last_revocation_now) stale('its timestamp is older than the last accepted feed (replay)');
    if (!Number.isInteger(meta.head_ts) || meta.head_ts < st.revocations_head_ts) stale('its head is behind the head the hub signed at check-in (stripped feed)');
    const rows = (Array.isArray(res.data) ? res.data : []).filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) && ID_RE.test(r.plugin_id || '') && Number.isInteger(r.ts) && ['info', 'warning', 'critical'].includes(r.severity) && ['disable', 'uninstall'].includes(r.action));
    const hubKids = license().pluginSigningKids();
    const applied = [];
    let maxTs = st.last_revocation_ts;
    for (const rev of rows) {
      maxTs = Math.max(maxTs, rev.ts);
      if (stmts.revocation.get(rev.id)) continue;
      const matches = matchesLocally(rev, hubKids);
      const appliedTo = [];
      for (const m of matches) {
        try {
          if (rev.action === 'uninstall') await ctx.plugins.uninstall(m.id, { purge: false, req });
          else await ctx.plugins.disable(m.id, { req });
          appliedTo.push({ ...m, action: rev.action });
        } catch (err) {
          log.error({ err, plugin: m.id }, 'revocation could not be applied');
          appliedTo.push({ ...m, action: rev.action, error: err.message });
        }
      }
      const version = typeof rev.version === 'string' && VERSION_RE.test(rev.version) ? rev.version : null;
      const reasonText = typeof rev.reason === 'string' ? rev.reason.slice(0, 1000) : null;
      stmts.insertRevocation.run({ id: rev.id, plugin_id: rev.plugin_id, version, severity: rev.severity, action: rev.action, reason: reasonText, ts: rev.ts, applied_at: nowIso(), applied_to_json: JSON.stringify(appliedTo), acknowledged_by: appliedTo.length ? null : 'system', acknowledged_at: appliedTo.length ? null : nowIso() });
      if (appliedTo.length) {
        audit(req, { action: 'plugin.revoked', target: rev.plugin_id, args: { revocation: rev.id, version, severity: rev.severity, action: rev.action, reason: reasonText, appliedTo, trigger: reason } });
        notify('plugin.revoked', { subject: `Plugin ${rev.plugin_id}${version ? ` ${version}` : ''} was revoked by the marketplace`, body: `${reasonText || 'No reason given.'}\n\nAction: ${rev.action}. Affected: ${appliedTo.map((a) => `${a.id} ${a.version} (${a.source})`).join(', ')}. Acknowledge the notice in the panel.`, severity: 'error', data: { revocation: rev.id, plugin_id: rev.plugin_id, version, severity: rev.severity, action: rev.action, appliedTo } });
        applied.push({ id: rev.id, pluginId: rev.plugin_id, version, severity: rev.severity, action: rev.action, appliedTo });
      }
    }
    saveState({ last_revocation_ts: maxTs, last_revocation_now: meta.now, revocations_head_ts: Math.max(st.revocations_head_ts, meta.head_ts), fail_count: 0 });
    return { applied, received: rows.length, headTs: meta.head_ts };
  }

  const shapeRevocation = (r) => ({ id: r.id, pluginId: r.plugin_id, version: r.version, severity: r.severity, action: r.action, reason: r.reason, ts: r.ts, appliedAt: r.applied_at, appliedTo: json.parse(r.applied_to_json, []) || [], acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at });
  const revocations = ({ unacknowledged = false } = {}) => (unacknowledged ? stmts.unacked.all() : stmts.revocations.all()).map(shapeRevocation);

  function acknowledgeRevocation(id, user, req) {
    const row = stmts.revocation.get(id);
    if (!row) throw notFound(`Revocation "${id}"`);
    stmts.ack.run(user?.username ?? 'system', id);
    audit(req, { action: 'marketplace.revocation.ack', target: row.plugin_id, args: { revocation: id } });
    return shapeRevocation(stmts.revocation.get(id));
  }

  // The host asks before every activation: a revoked plugin stays off until
  // root acknowledges the notice or turns developer mode on.
  function enableGuard(id) {
    if (developerMode()) return;
    const rev = stmts.unackedFor.get(id);
    if (rev) throw new HttpError(409, 'plugin_revoked', `${id}${rev.version ? ` ${rev.version}` : ''} was revoked by the marketplace (${rev.reason || rev.severity}); acknowledge the revocation notice before enabling it again`, { revocation: [rev.id] });
  }

  // ---- reviews and listings ------------------------------------------------

  async function review(id, { rating, title, body }, user, req) {
    requireHub();
    requireLicensed();
    const res = await license().hub.request(`/v1/market/plugins/${encodeURIComponent(id)}/reviews`, { token: license().token(), rating, ...(title ? { title } : {}), ...(body ? { body } : {}) });
    audit(req, { action: 'plugin.marketplace.review', target: id, args: { rating } });
    return res.data;
  }

  const shapeInstall = (r) => (r ? { pluginId: r.plugin_id, version: r.version, channel: r.channel, packageSha256: r.package_sha256, hubKid: r.hub_kid, consentedPermissions: json.parse(r.consented_permissions_json, []) || [], consentedBy: r.consented_by, consentedAt: r.consented_at, consentState: r.consent_state, wasEnabled: r.was_enabled === 1, installedAt: r.installed_at, updatedAt: r.updated_at } : null);
  const installs = () => stmts.installs.all().map(shapeInstall);

  // ---- jobs, schedules, hooks ----------------------------------------------

  ctx.jobs.register(INSTALL_JOB, runInstall);
  ctx.jobs.register(UPDATE_JOB, runInstall);
  ctx.jobs.register(REVOCATIONS_JOB, async (jobCtx) => pollRevocations({ reason: jobCtx.params?.reason || 'scheduled' }));
  ctx.jobs.register(UPDATE_CHECK_JOB, async () => {
    const s = status();
    if (!s.enabled || s.hubMismatch || !s.hasToken) return { skipped: true };
    return { updates: await checkUpdates() };
  });

  let scheduled = null;
  // Schedules exist once and are switched with the hub row, so the scheduler
  // never enqueues a job the handler would skip.
  function syncSchedules(enabled) {
    if (scheduled === enabled) return;
    try {
      ctx.scheduler.ensure(REVOCATIONS_SCHEDULE, `${crypto.randomInt(0, 60)} */6 * * *`, REVOCATIONS_JOB, { reason: 'scheduled' });
      ctx.scheduler.ensure(UPDATE_CHECK_SCHEDULE, `${crypto.randomInt(0, 60)} 4 * * *`, UPDATE_CHECK_JOB);
      ctx.scheduler.update(REVOCATIONS_SCHEDULE, { enabled });
      ctx.scheduler.update(UPDATE_CHECK_SCHEDULE, { enabled });
      scheduled = enabled;
    } catch (err) { log.warn({ err }, 'marketplace schedules could not be synchronised'); }
  }

  function enqueueRevocationPoll(reason) {
    try {
      const s = status();
      if (!s.enabled || s.hubMismatch) return null;
      return ctx.jobs.enqueue(REVOCATIONS_JOB, { reason });
    } catch (err) { log.warn({ err }, 'could not queue the revocation poll'); return null; }
  }

  if (ctx.license?.on) {
    ctx.license.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.code === 'plugin_revocations_pending') enqueueRevocationPoll('checkin_message');
      else if (msg.code === 'revocations_head_ts' && Number.isInteger(msg.value) && msg.value > state().revocations_head_ts) enqueueRevocationPoll('head_advanced');
    });
  }
  if (ctx.plugins?.guards?.enable) ctx.plugins.guards.enable.push(enableGuard);

  return {
    INSTALL_JOB, UPDATE_JOB, REVOCATIONS_JOB, UPDATE_CHECK_JOB, cacheDir,
    status, requireHub, catalog, categories, plugin, versions, updates, checkUpdates,
    install, update, consent, uninstall, installs,
    pollRevocations, revocations, acknowledgeRevocation, enableGuard, review,
  };
}
