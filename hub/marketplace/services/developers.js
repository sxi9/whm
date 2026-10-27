import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json, paginate } from '../../shared/db.js';
import * as ns from '../lib/namespace.js';

const STATUSES = ['pending', 'verified', 'rejected', 'suspended'];
const REJECT_CODES = ['duplicate_identity', 'evidence_failed', 'namespace_conflict', 'policy'];

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'developer';
}

// Registration is open; publishing is gated by status = 'verified' (§18.2).
export function createDevelopersService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    byId: db.prepare('SELECT * FROM developers WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM developers WHERE email = ?'),
    bySlug: db.prepare('SELECT id FROM developers WHERE slug = ?'),
    insert: db.prepare(`INSERT INTO developers (id, email, email_verify_token_hash, email_verify_expires_at, password_hash, display_name, slug, status, created_at, updated_at)
      VALUES (@id, @email, @email_verify_token_hash, @email_verify_expires_at, @password_hash, @display_name, @slug, 'pending', @now, @now)`),
    namespaces: db.prepare('SELECT * FROM developer_namespaces WHERE developer_id = ? ORDER BY ns'),
    allNamespaces: db.prepare("SELECT ns, developer_id FROM developer_namespaces WHERE status != 'revoked'"),
    nsRow: db.prepare('SELECT * FROM developer_namespaces WHERE ns = ?'),
    insertNs: db.prepare("INSERT INTO developer_namespaces (ns, developer_id, domain, status, created_at) VALUES (?, ?, ?, 'claimed', ?)"),
    deleteNs: db.prepare('DELETE FROM developer_namespaces WHERE ns = ? AND developer_id = ?'),
    reassignNs: db.prepare("UPDATE developer_namespaces SET developer_id = ?, status = 'claimed', verified_at = NULL WHERE ns = ?"),
    setStatus: db.prepare('UPDATE developers SET status = @status, status_reason = @reason, verified_at = COALESCE(@verified_at, verified_at), verified_by = COALESCE(@verified_by, verified_by), reverify_due_at = @reverify_due_at, updated_at = @now WHERE id = @id'),
    setNsList: db.prepare('UPDATE developers SET namespaces_json = ?, updated_at = ? WHERE id = ?'),
  };

  function get(id) {
    const row = stmts.byId.get(id);
    if (!row) throw notFound('Developer');
    return row;
  }

  function syncNamespaceList(developerId) {
    const list = stmts.namespaces.all(developerId).filter((n) => n.status !== 'revoked').map((n) => n.ns);
    stmts.setNsList.run(JSON.stringify(list), m.nowIso(), developerId);
    return list;
  }

  function publicView(d) {
    return { id: d.id, email: d.email, email_verified: !!d.email_verified_at, display_name: d.display_name, slug: d.slug, company: d.company, website: d.website, country: d.country, support_email: d.support_email, support_url: d.support_url, status: d.status, status_reason: d.status_reason, verified_at: d.verified_at, reverify_due_at: d.reverify_due_at, totp_enabled: !!d.totp_enabled, namespaces: json.parse(d.namespaces_json, []), has_payout: !!d.payout_json_enc, revenue_share_pct: d.revenue_share_pct ?? cfg.revenue_share_pct, created_at: d.created_at };
  }
  const card = (d) => ({ slug: d.slug, display_name: d.display_name, verified: d.status === 'verified', website: d.website || null, support_url: d.support_url || null });

  const canUpload = (d) => ['verified', 'pending'].includes(d.status) && !!d.verified_at;
  const canPublish = (d) => d.status === 'verified';

  function transition(developer, status, { reason = null, by = 'system', ip = null, mail = null, reverifyDue = undefined } = {}) {
    if (!STATUSES.includes(status)) throw new HttpError(422, 'validation_failed', 'Unknown developer status');
    const now = m.nowIso();
    stmts.setStatus.run({
      id: developer.id, status, reason, now,
      verified_at: status === 'verified' ? now : null, verified_by: status === 'verified' ? by : null,
      reverify_due_at: reverifyDue !== undefined ? reverifyDue : status === 'verified' ? m.nowIso(m.now() + 365 * 86_400_000) : developer.reverify_due_at,
    });
    m.audit({ principal: by, role: by.startsWith('developer:') ? 'developer' : 'vendor', ip, action: `developer.${status}`, target: developer.id, args: { from: developer.status, reason }, result: 'ok' });
    m.webhook(developer.id, 'developer.status_changed', { developer_id: developer.id, from: developer.status, to: status, reason });
    if (mail) m.mail(developer.email, mail, { display_name: developer.display_name, reason, status });
    return get(developer.id);
  }

  const svc = {
    get, publicView, card, canUpload, canPublish, REJECT_CODES, syncNamespaceList,
    find: (id) => stmts.byId.get(id) || null,
    findByEmail: (email) => stmts.byEmail.get(String(email).toLowerCase()) || null,
    findBySlug: (slug) => db.prepare('SELECT * FROM developers WHERE slug = ?').get(slug) || null,

    async register({ email, password, display_name }, { ip } = {}) {
      if (cfg.disposable_domains.includes(email.split('@')[1])) throw new HttpError(422, 'disposable_email', 'Disposable e-mail addresses are not accepted');
      // The per-IP budget counts every attempt, so e-mail enumeration through 409s is bounded too.
      m.limits.assert(`register:${m.hashIp(ip)}`, cfg.rate_limits.register.max, cfg.rate_limits.register.windowMs, 'Too many registrations from this address');
      if (stmts.byEmail.get(email)) throw new HttpError(409, 'email_taken', 'An account with that e-mail already exists');
      let slug = slugify(display_name);
      for (let i = 2; stmts.bySlug.get(slug); i++) slug = `${slugify(display_name)}-${i}`;
      const id = newId('dev', m.now());
      const token = ctx.crypto.randomToken(32);
      stmts.insert.run({ id, email, email_verify_token_hash: ctx.crypto.hashToken(token), email_verify_expires_at: m.nowIso(m.now() + 24 * 3600_000), password_hash: await ctx.crypto.hashPassword(password), display_name, slug, now: m.nowIso() });
      m.mail(email, 'dev.email_verify', { display_name, link: `${ctx.config.public_url}/dev/verify-email/${token}` });
      m.audit({ principal: `developer:${id}`, role: 'developer', ip, action: 'developer.register', target: id, args: { email, display_name }, result: 'ok' });
      return { id, status: 'pending', email_verification_required: true, _token: token };
    },
    verifyEmail(token) {
      const row = db.prepare('SELECT * FROM developers WHERE email_verify_token_hash = ?').get(ctx.crypto.hashToken(String(token)));
      if (!row || new Date(row.email_verify_expires_at).getTime() < m.now()) throw new HttpError(410, 'verify_invalid', 'The verification link is invalid or expired');
      db.prepare('UPDATE developers SET email_verified_at = ?, email_verify_token_hash = NULL, updated_at = ? WHERE id = ?').run(m.nowIso(), m.nowIso(), row.id);
      return { verified: true };
    },
    async login({ email, password, totp }, { ip } = {}) {
      const d = stmts.byEmail.get(email);
      if (!d) { await ctx.crypto.verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid'); throw new HttpError(401, 'invalid_credentials', 'Invalid e-mail or password'); }
      m.devSecurity.assertNotLocked(d);
      if (!(await ctx.crypto.verifyPassword(password, d.password_hash))) {
        const r = m.devSecurity.recordFailedLogin(d, ip);
        if (r.locked) throw Object.assign(new HttpError(423, 'account_locked', 'Too many failed logins; the account is locked for a while'), { retryAfterS: 900 });
        throw new HttpError(401, 'invalid_credentials', 'Invalid e-mail or password');
      }
      if (!d.email_verified_at) throw new HttpError(403, 'email_unverified', 'Verify your e-mail address first');
      if (d.totp_enabled) {
        if (!totp) throw new HttpError(401, 'totp_required', 'A TOTP code is required');
        m.devSecurity.verifyTotp(d, totp, { ip });
      }
      m.devSecurity.recordSuccessfulLogin(d, ip);
      return { developer: get(d.id), totpVerified: !!d.totp_enabled };
    },
    updateProfile(developer, patch, { ip } = {}) {
      const allowed = ['display_name', 'company', 'website', 'country', 'support_email', 'support_url'];
      const sets = [];
      const params = { id: developer.id, now: m.nowIso() };
      for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
      if (sets.length) db.prepare(`UPDATE developers SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      let reverify = false;
      if (patch.email !== undefined && patch.email !== developer.email) {
        if (stmts.byEmail.get(patch.email)) throw new HttpError(409, 'email_taken', 'That e-mail is already in use');
        db.prepare('UPDATE developers SET email = ?, updated_at = ? WHERE id = ?').run(patch.email, m.nowIso(), developer.id);
        m.devSecurity.invalidateCredentials(developer, { reason: 'email_changed', ip, oldEmail: developer.email });
        reverify = true;
      }
      if (patch.payout !== undefined) {
        db.prepare('UPDATE developers SET payout_json_enc = ?, updated_at = ? WHERE id = ?').run(patch.payout ? ctx.crypto.encrypt(JSON.stringify(patch.payout)) : null, m.nowIso(), developer.id);
        m.devSecurity.securityEvent(developer, 'payout_changed', { ip });
        reverify = true;
      }
      if (reverify) svc.triggerReverification(developer.id, patch.email !== undefined ? 'email_changed' : 'payout_changed');
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.profile.update', target: developer.id, args: { ...patch, payout: patch.payout === undefined ? undefined : '[redacted]' }, result: 'ok' });
      return publicView(get(developer.id));
    },
    // TOTP enrolment: start → confirm; disabling revokes every API key.
    totpStart(developer) {
      const secret = ctx.crypto.totp.generateSecret();
      db.prepare('UPDATE developers SET totp_secret_enc = ?, updated_at = ? WHERE id = ? AND totp_enabled = 0').run(ctx.crypto.encrypt(secret), m.nowIso(), developer.id);
      return { secret, uri: ctx.crypto.totp.keyUri(developer.email, 'WHM Marketplace', secret) };
    },
    totpConfirm(developer, code, { ip } = {}) {
      const d = get(developer.id);
      if (d.totp_enabled) throw new HttpError(409, 'totp_enabled', 'TOTP is already enabled');
      if (!d.totp_secret_enc) throw new HttpError(409, 'totp_not_started', 'Start TOTP enrolment first');
      m.devSecurity.verifyTotp(d, code, { ip });
      db.prepare('UPDATE developers SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(m.nowIso(), d.id);
      m.devSecurity.securityEvent(d, 'totp_enabled', { ip });
      return { enabled: true };
    },
    totpDisable(developer, code, { ip } = {}) {
      const d = get(developer.id);
      if (!d.totp_enabled) throw new HttpError(409, 'totp_not_enabled', 'TOTP is not enabled');
      m.devSecurity.verifyTotp(d, code, { ip });
      db.prepare('UPDATE developers SET totp_enabled = 0, totp_secret_enc = NULL, updated_at = ? WHERE id = ?').run(m.nowIso(), d.id);
      const revoked = m.devSecurity.revokeAllApiKeys(d.id);
      m.devSecurity.securityEvent(d, 'totp_disabled', { ip, detail: `${revoked} API key(s) revoked` });
      return { enabled: false, api_keys_revoked: revoked };
    },

    // Namespaces (§18.2 ownership rule).
    namespacesOf: (developerId) => stmts.namespaces.all(developerId).map((n) => ({ ns: n.ns, domain: n.domain, status: n.status, verified_at: n.verified_at, last_check_at: n.last_check_at, last_check_result: n.last_check_result })),
    claimNamespace(developer, input, { ip } = {}) {
      const name = ns.normalize(input);
      if (ns.isReserved(name, { reserved: cfg.reserved_namespaces, bundledIds: cfg.bundled_ids })) throw new HttpError(422, 'namespace_reserved', `"${name}" is reserved`);
      const domain = ns.assertClaimable(name, ctx.psl);
      const held = stmts.allNamespaces.all();
      const clash = ns.conflicts(name, held.map((h) => h.ns));
      const foreign = clash.filter((c) => held.find((h) => h.ns === c).developer_id !== developer.id);
      if (foreign.length) {
        m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.namespace.conflict', target: name, args: { conflicts: foreign }, result: 'error:namespace_conflict' });
        throw Object.assign(new HttpError(409, 'namespace_conflict', `"${name}" conflicts with a namespace held by another developer (${foreign.join(', ')})`), { extra: { conflicts: foreign } });
      }
      if (clash.includes(name)) return svc.namespacesOf(developer.id).find((n) => n.ns === name);
      stmts.insertNs.run(name, developer.id, domain, m.nowIso());
      syncNamespaceList(developer.id);
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.namespace.claim', target: name, args: { domain }, result: 'ok' });
      return { ns: name, domain, status: 'claimed', verified_at: null };
    },
    releaseNamespace(developer, input, { ip } = {}) {
      const name = ns.normalize(input);
      if (db.prepare('SELECT 1 FROM plugins WHERE developer_id = ? AND id LIKE ?').get(developer.id, `${name}.%`)) throw new HttpError(409, 'namespace_in_use', 'Plugins are published under this namespace');
      if (!stmts.deleteNs.run(name, developer.id).changes) throw notFound('Namespace');
      syncNamespaceList(developer.id);
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.namespace.release', target: name, args: null, result: 'ok' });
      return { released: true };
    },
    // Admin: assigns a namespace (including reserved ones) to a developer after a dispute.
    reassignNamespace(ns_, developerId, { by, ip } = {}) {
      const name = ns.normalize(ns_);
      const target = get(developerId);
      const row = stmts.nsRow.get(name);
      const previous = row?.developer_id || null;
      if (row) stmts.reassignNs.run(target.id, name);
      else stmts.insertNs.run(name, target.id, ns.domainOf(name), m.nowIso());
      syncNamespaceList(target.id);
      if (previous && previous !== target.id) syncNamespaceList(previous);
      m.audit({ principal: by, role: 'vendor', ip, action: 'developer.namespace.reassign', target: name, args: { from: previous, to: target.id }, result: 'ok' });
      return { ns: name, developer_id: target.id, previous_developer_id: previous };
    },
    ownsNamespaceFor(developer, pluginId) {
      return json.parse(developer.namespaces_json, []).some((n) => ns.covers(n, pluginId));
    },
    assertCanUpload(developer, pluginId) {
      if (!canUpload(developer)) throw new HttpError(403, 'developer_not_verified', 'Your developer account must be verified before uploading');
      if (!svc.ownsNamespaceFor(developer, pluginId)) throw new HttpError(403, 'namespace_not_owned', `"${pluginId}" is not under one of your namespaces`);
    },
    assertCanPublish(developer) {
      if (!canPublish(developer)) throw new HttpError(403, 'developer_not_verified', 'Publishing requires a verified developer account');
    },

    // Admin transitions.
    approve(id, { by, ip, note = null } = {}) {
      const d = get(id);
      if (d.status === 'suspended') throw new HttpError(409, 'suspended', 'Reinstate the developer first');
      db.prepare("UPDATE developer_namespaces SET status = 'verified', verified_at = ? WHERE developer_id = ? AND status = 'claimed'").run(m.nowIso(), id);
      return publicView(transition(d, 'verified', { reason: note, by, ip, mail: 'dev.verified' }));
    },
    reject(id, { code, text, by, ip } = {}) {
      const d = get(id);
      if (!REJECT_CODES.includes(code)) throw new HttpError(422, 'validation_failed', `Reason code must be one of ${REJECT_CODES.join(', ')}`);
      const rejections = json.parse(d.rejections_json, []).filter((t) => new Date(t).getTime() > m.now() - 90 * 86_400_000);
      rejections.push(m.nowIso());
      db.prepare('UPDATE developers SET rejections_json = ? WHERE id = ?').run(JSON.stringify(rejections), id);
      return publicView(transition(d, 'rejected', { reason: `${code}: ${text || ''}`.trim(), by, ip, mail: 'dev.rejected' }));
    },
    resubmit(developer) {
      const d = get(developer.id);
      if (d.status !== 'rejected') return publicView(d);
      return publicView(transition(d, 'pending', { reason: 'resubmitted', by: `developer:${d.id}` }));
    },
    // Suspension freezes publishing (canPublish/canUpload) and hides the
    // developer's unpublished versions from the scan and review queues; the
    // versions keep their status so reinstating needs no re-upload (§18.2 step 7).
    suspend(id, { reason, by, ip } = {}) {
      const d = get(id);
      return publicView(transition(d, 'suspended', { reason, by, ip, mail: 'dev.suspended' }));
    },
    reinstate(id, { by, ip } = {}) {
      const d = get(id);
      if (d.status !== 'suspended') throw new HttpError(409, 'not_suspended', 'Developer is not suspended');
      return publicView(transition(d, d.verified_at ? 'verified' : 'pending', { reason: 'reinstated', by, ip, reverifyDue: d.reverify_due_at }));
    },
    closeAccount(id, { reason, by, ip } = {}) {
      return publicView(transition(get(id), 'rejected', { reason: reason || 'closed', by, ip }));
    },
    // Re-verification: a verified developer drops back to pending (uploads
    // still accepted, publishing not) until a reviewer approves again.
    triggerReverification(id, trigger, { by = 'system', ip = null } = {}) {
      const d = get(id);
      if (d.status !== 'verified') return publicView(d);
      m.mail(d.email, 'dev.reverify_due', { display_name: d.display_name, trigger });
      return publicView(transition(d, 'pending', { reason: `reverify:${trigger}`, by, ip, reverifyDue: null }));
    },
    reverifyDue() {
      const rows = db.prepare("SELECT id FROM developers WHERE status = 'verified' AND reverify_due_at IS NOT NULL AND reverify_due_at <= ?").all(m.nowIso());
      for (const r of rows) svc.triggerReverification(r.id, 'reverify_due');
      return { triggered: rows.length };
    },
    rejectionsIn90Days: (id) => json.parse(get(id).rejections_json, []).filter((t) => new Date(t).getTime() > m.now() - 90 * 86_400_000).length,
    setRevenueShare(id, pct, { by, ip } = {}) {
      get(id);
      db.prepare('UPDATE developers SET revenue_share_pct = ?, updated_at = ? WHERE id = ?').run(pct, m.nowIso(), id);
      m.audit({ principal: by, role: 'vendor', ip, action: 'developer.revenue_share', target: id, args: { pct }, result: 'ok' });
      return publicView(get(id));
    },
    adminPatch(id, patch, { by, ip } = {}) {
      const d = get(id);
      const allowed = ['display_name', 'company', 'website', 'country', 'support_email', 'support_url', 'status_reason'];
      const sets = []; const params = { id, now: m.nowIso() };
      for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
      if (sets.length) db.prepare(`UPDATE developers SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
      m.audit({ principal: by, role: 'vendor', ip, action: 'developer.admin_patch', target: d.id, args: patch, result: 'ok' });
      return publicView(get(id));
    },
    list(query = {}) {
      const where = []; const params = {};
      if (query.status) { where.push('status = @status'); params.status = query.status; }
      if (query.q) { where.push('(email LIKE @q OR display_name LIKE @q OR slug LIKE @q OR namespaces_json LIKE @q)'); params.q = `%${query.q}%`; }
      const page = paginate(db, { from: 'developers', where, params, sortable: { created_at: 'created_at', status: 'status', display_name: 'display_name' }, defaultSort: 'created_at', query: { dir: 'desc', ...query } });
      return { ...page, data: page.data.map(publicView) };
    },
    history(id) {
      get(id);
      return {
        audit: db.prepare('SELECT ts, principal, action, target, result FROM audit_log WHERE target = ? OR principal = ? ORDER BY id DESC LIMIT 200').all(id, `developer:${id}`),
        security_events: m.devSecurity.events(id),
        keys: m.devKeys.list(id),
        namespaces: svc.namespacesOf(id),
        verifications: m.verification.listFor(id),
        plugins: db.prepare('SELECT id, name, status, latest_stable_version, latest_beta_version FROM plugins WHERE developer_id = ? ORDER BY created_at').all(id),
      };
    },
  };
  return svc;
}
