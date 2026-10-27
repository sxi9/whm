import { HttpError, notFound } from '../../shared/errors.js';
import { newId, json } from '../../shared/db.js';
import * as nsLib from '../lib/namespace.js';

export const METHODS = ['dns_txt', 'well_known', 'github_org', 'id_document'];
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Namespace evidence (§18.2 step 4): automated checks produce inputs
// (passed|failed) for the human decision in the admin queue. Every outbound
// check goes through ctx.safeFetch (SSRF policy); re-checks are rate limited.
export function createVerificationService(m) {
  const { ctx, db, cfg } = m;
  const stmts = {
    byId: db.prepare('SELECT * FROM developer_verifications WHERE id = ?'),
    forDev: db.prepare('SELECT * FROM developer_verifications WHERE developer_id = ? ORDER BY created_at DESC'),
    insert: db.prepare(`INSERT INTO developer_verifications (id, developer_id, ns, method, evidence_json, result, result_detail, checked_at, document_enc, created_at)
      VALUES (@id, @developer_id, @ns, @method, @evidence_json, @result, @result_detail, @checked_at, @document_enc, @created_at)`),
    setResult: db.prepare('UPDATE developer_verifications SET result = ?, result_detail = ?, checked_at = ? WHERE id = ?'),
    review: db.prepare('UPDATE developer_verifications SET reviewer_id = ?, reviewer_note = ? WHERE developer_id = ?'),
    nsCheck: db.prepare('UPDATE developer_namespaces SET last_check_at = ?, last_check_result = ? WHERE ns = ?'),
    purge: db.prepare("UPDATE developer_verifications SET document_enc = NULL, result = CASE WHEN result = 'pending' THEN 'expired' ELSE result END WHERE method = 'id_document' AND document_enc IS NOT NULL AND created_at < ?"),
  };

  const view = (v) => ({ id: v.id, developer_id: v.developer_id, ns: v.ns, method: v.method, evidence: redactEvidence(json.parse(v.evidence_json, {})), result: v.result, result_detail: v.result_detail, checked_at: v.checked_at, reviewer_id: v.reviewer_id, reviewer_note: v.reviewer_note, has_document: !!v.document_enc, created_at: v.created_at });
  function redactEvidence(e) {
    const { access_token_enc, ...rest } = e;
    return rest;
  }

  function get(id) {
    const row = stmts.byId.get(id);
    if (!row) throw notFound('Verification');
    return row;
  }

  function assertDomain(developer, ns, domain) {
    const d = ctx.psl.normalizeHost(domain);
    if (!d || !DOMAIN_RE.test(d)) throw new HttpError(422, 'invalid_domain', 'A valid domain name is required');
    const owned = db.prepare('SELECT ns FROM developer_namespaces WHERE ns = ? AND developer_id = ?').get(ns, developer.id);
    if (!owned) throw new HttpError(404, 'not_found', 'Claim the namespace first');
    return d;
  }

  async function runCheck(row) {
    const ev = json.parse(row.evidence_json, {});
    if (row.method === 'id_document') return { result: 'pending', detail: 'awaiting reviewer' };
    if (row.method === 'github_org') {
      if (!ev.access_token_enc) return { result: 'pending', detail: 'complete the GitHub OAuth flow' };
      const expected = `com.github.${String(ev.org).toLowerCase()}`;
      if (row.ns !== expected) return { result: 'failed', detail: `the GitHub organisation method proves ${expected} only` };
      try {
        const res = await ctx.safeFetch(`https://api.github.com/orgs/${encodeURIComponent(ev.org)}/memberships/${encodeURIComponent(ev.login)}`, { headers: { authorization: `Bearer ${ctx.crypto.decrypt(ev.access_token_enc)}`, accept: 'application/vnd.github+json' }, maxBytes: 16384 });
        if (res.status !== 200) return { result: 'failed', detail: `GitHub answered ${res.status}` };
        const body = JSON.parse(res.text());
        return body.state === 'active' && body.role === 'admin' ? { result: 'passed', detail: `admin of ${ev.org}` } : { result: 'failed', detail: `membership role ${body.role || 'none'}` };
      } catch (err) {
        return { result: 'failed', detail: `${err.code || 'error'}: ${err.message}`, code: err.code };
      }
    }
    if (!nsLib.evidenceHostAllowed(row.ns, ev.domain, ctx.psl)) return { result: 'failed', detail: `evidence_host_not_allowed: ${ev.domain} does not prove ${row.ns}` };
    try {
      if (row.method === 'dns_txt') {
        const records = await ctx.safeFetch.safeResolveTxt(`_whm-dev.${ev.domain}`);
        return records.some((r) => r.trim() === `whm-dev-verify=${ev.token}`) ? { result: 'passed', detail: 'TXT record found' } : { result: 'failed', detail: `no matching TXT record (${records.length} seen)` };
      }
      const res = await ctx.safeFetch(`https://${ev.domain}/.well-known/whm-developer.txt`, { maxBytes: 4096, timeoutMs: 5000 });
      if (res.status !== 200) return { result: 'failed', detail: `HTTP ${res.status}` };
      return res.text().split(/\r?\n/).some((l) => l.trim() === ev.token) ? { result: 'passed', detail: 'well-known file found' } : { result: 'failed', detail: 'token not in the well-known file' };
    } catch (err) {
      return { result: 'failed', detail: `${err.code || 'error'}: ${err.message}`, code: err.code };
    }
  }

  async function check(id, { by = 'system' } = {}) {
    const row = get(id);
    const out = await runCheck(row);
    stmts.setResult.run(out.result, out.detail, m.nowIso(), id);
    if (row.ns) stmts.nsCheck.run(m.nowIso(), out.result, row.ns);
    if (out.result === 'passed' && row.ns) db.prepare("UPDATE developer_namespaces SET status = CASE WHEN status = 'claimed' THEN 'claimed' ELSE status END, verified_at = COALESCE(verified_at, ?) WHERE ns = ?").run(m.nowIso(), row.ns);
    m.audit({ principal: by, role: by.startsWith('developer:') ? 'developer' : 'system', ip: null, action: 'developer.verification.check', target: id, args: { method: row.method, ns: row.ns }, result: out.result === 'passed' ? 'ok' : `error:${out.code || out.result}` });
    return { ...view(get(id)), code: out.code || null };
  }

  const svc = {
    METHODS, view, get, check,
    listFor: (developerId) => stmts.forDev.all(developerId).map(view),
    submit(developer, input, { ip } = {}) {
      const id = newId('dvf', m.now());
      let ns = null; let evidence = {}; let documentEnc = null;
      if (input.method === 'id_document') {
        if (!input.document) throw new HttpError(422, 'validation_failed', 'document (base64) is required');
        documentEnc = ctx.crypto.encrypt(JSON.stringify({ content_type: input.content_type || 'application/octet-stream', data: input.document }));
        evidence = { content_type: input.content_type || 'application/octet-stream' };
      } else {
        ns = nsLib.normalize(input.ns);
        if (input.method === 'github_org') {
          if (!/^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/i.test(input.org || '')) throw new HttpError(422, 'validation_failed', 'org is required');
          evidence = { org: input.org, login: input.login || null };
          if (!db.prepare('SELECT 1 FROM developer_namespaces WHERE ns = ? AND developer_id = ?').get(ns, developer.id)) throw new HttpError(404, 'not_found', 'Claim the namespace first');
        } else {
          const domain = assertDomain(developer, ns, input.domain || nsLib.domainOf(ns));
          evidence = { domain, token: `whm-dev-${ctx.crypto.randomToken(18)}` };
        }
      }
      stmts.insert.run({ id, developer_id: developer.id, ns, method: input.method, evidence_json: JSON.stringify(evidence), result: 'pending', result_detail: null, checked_at: null, document_enc: documentEnc, created_at: m.nowIso() });
      if (developer.status === 'rejected') m.developers.resubmit(developer);
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.verification.submit', target: id, args: { method: input.method, ns }, result: 'ok' });
      m.mail(developer.email, 'dev.verification_received', { display_name: developer.display_name, method: input.method, ns });
      const out = view(get(id));
      if (evidence.token) out.instructions = input.method === 'dns_txt'
        ? { record: `_whm-dev.${evidence.domain}`, type: 'TXT', value: `whm-dev-verify=${evidence.token}` }
        : { url: `https://${evidence.domain}/.well-known/whm-developer.txt`, content: evidence.token };
      return out;
    },
    // 5/h per developer and 1/min per target domain (§18.2 step 4).
    async recheck(developer, id, { ip } = {}) {
      const row = get(id);
      if (row.developer_id !== developer.id) throw notFound('Verification');
      m.limits.assert(`recheck:${developer.id}`, cfg.rate_limits.recheck.max, cfg.rate_limits.recheck.windowMs, 'Re-check limit reached (5 per hour)');
      const ev = json.parse(row.evidence_json, {});
      if (ev.domain) m.limits.assert(`recheck-domain:${ev.domain}`, 1, 60_000, 'This domain was checked less than a minute ago');
      const out = await check(id, { by: `developer:${developer.id}` });
      m.audit({ principal: `developer:${developer.id}`, role: 'developer', ip, action: 'developer.verification.recheck', target: id, args: null, result: out.result === 'passed' ? 'ok' : `error:${out.code || out.result}` });
      return out;
    },
    // GitHub organisation method: OAuth start/callback through safe-fetch.
    githubStart(developer, verificationId) {
      const gh = cfg.github_oauth;
      if (!gh?.client_id) throw new HttpError(501, 'github_not_configured', 'GitHub OAuth is not configured on this hub');
      const row = get(verificationId);
      if (row.developer_id !== developer.id || row.method !== 'github_org') throw notFound('Verification');
      const state = ctx.crypto.randomToken(24);
      db.prepare('UPDATE developer_verifications SET evidence_json = ? WHERE id = ?').run(JSON.stringify({ ...json.parse(row.evidence_json, {}), state_hash: ctx.crypto.hashToken(state) }), row.id);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', gh.client_id);
      url.searchParams.set('redirect_uri', gh.redirect_url || `${ctx.config.public_url}/v1/dev/verification/github/callback`);
      url.searchParams.set('scope', 'read:org');
      url.searchParams.set('state', `${row.id}.${state}`);
      return { url: url.toString() };
    },
    async githubCallback(developer, { code, state }) {
      const gh = cfg.github_oauth;
      const [id, secret] = String(state).split('.');
      const row = get(id);
      const ev = json.parse(row.evidence_json, {});
      if (row.developer_id !== developer.id || !ev.state_hash || ev.state_hash !== ctx.crypto.hashToken(secret || '')) throw new HttpError(403, 'oauth_state_invalid', 'OAuth state does not match');
      const clientSecret = gh.client_secret_enc ? ctx.crypto.decrypt(gh.client_secret_enc) : gh.client_secret;
      const tokenRes = await ctx.safeFetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_id: gh.client_id, client_secret: clientSecret, code }), maxBytes: 16384 });
      const tok = JSON.parse(tokenRes.text());
      if (!tok.access_token) throw new HttpError(422, 'oauth_failed', 'GitHub did not return an access token');
      const me = await ctx.safeFetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json' }, maxBytes: 16384 });
      const login = JSON.parse(me.text()).login;
      db.prepare('UPDATE developer_verifications SET evidence_json = ? WHERE id = ?').run(JSON.stringify({ org: ev.org, login, access_token_enc: ctx.crypto.encrypt(tok.access_token) }), row.id);
      return check(row.id, { by: `developer:${developer.id}` });
    },
    // Admin queue: developers awaiting a decision with their evidence.
    queue(query = {}) {
      const status = query.status || 'pending';
      const rows = db.prepare('SELECT * FROM developers WHERE status = ? ORDER BY updated_at').all(status);
      return rows.map((d) => ({ developer: m.developers.publicView(d), namespaces: m.developers.namespacesOf(d.id), verifications: svc.listFor(d.id), keys: m.devKeys.list(d.id), rejections_90d: m.developers.rejectionsIn90Days(d.id) }));
    },
    resolveDeveloperId(id) {
      if (id.startsWith('dvf_')) return get(id).developer_id;
      return id;
    },
    approve(id, { by, ip, note } = {}) {
      const devId = svc.resolveDeveloperId(id);
      stmts.review.run(by, note || null, devId);
      return m.developers.approve(devId, { by, ip, note });
    },
    reject(id, { code, text, by, ip } = {}) {
      const devId = svc.resolveDeveloperId(id);
      stmts.review.run(by, `${code}: ${text || ''}`, devId);
      const out = m.developers.reject(devId, { code, text, by, ip });
      if (m.developers.rejectionsIn90Days(devId) >= 2) m.audit({ principal: by, role: 'vendor', ip, action: 'developer.reverify_flag', target: devId, args: { reason: 'two_rejections_90d' }, result: 'ok' });
      return out;
    },
    requestEvidence(id, { text, by, ip } = {}) {
      const devId = svc.resolveDeveloperId(id);
      const d = m.developers.get(devId);
      stmts.review.run(by, text || 'more evidence requested', devId);
      m.mail(d.email, 'dev.evidence_requested', { display_name: d.display_name, text });
      m.audit({ principal: by, role: 'vendor', ip, action: 'developer.request_evidence', target: devId, args: { text }, result: 'ok' });
      return { requested: true };
    },
    document(id) {
      const row = get(id);
      if (!row.document_enc) throw notFound('Document');
      return JSON.parse(ctx.crypto.decrypt(row.document_enc));
    },
    purgeDocuments: (days = cfg.evidence_purge_days) => ({ purged: stmts.purge.run(m.nowIso(m.now() - days * 86_400_000)).changes }),
    // Monthly: re-run the last passed dns/well-known check of every verified namespace.
    async monthlyRecheck() {
      const rows = db.prepare("SELECT v.id, v.ns, v.developer_id FROM developer_verifications v JOIN developer_namespaces n ON n.ns = v.ns AND n.developer_id = v.developer_id WHERE v.result = 'passed' AND v.method IN ('dns_txt', 'well_known') AND (n.last_check_at IS NULL OR n.last_check_at < ?) GROUP BY v.ns").all(m.nowIso(m.now() - 28 * 86_400_000));
      let failed = 0;
      for (const r of rows) {
        const out = await check(r.id);
        if (out.result !== 'passed') { failed++; m.developers.triggerReverification(r.developer_id, `namespace_recheck_failed:${r.ns}`); }
      }
      return { checked: rows.length, failed };
    },
  };
  return svc;
}
