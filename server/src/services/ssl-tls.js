import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, forbidden, unprocessable, CapabilityError } from '../lib/errors.js';
import { isRoot } from '../middleware/rbac.js';

// SSL/TLS. Attached as ctx.ssl; other categories may call:
//   ssl.certForDomain(domain)                         -> installed ssl_certs row (shaped) or null
//   ssl.bundlePaths(domain)                           -> { dir, cert, key, chain, fullchain } under /etc/ssl/whm/<domain>/
//   ssl.install({ domain, certPem, keyPem, chainPem }, user, req) -> write bundle + ctx.web.applySsl
//   ssl.uninstall(domain, user, req)
//   ssl.issueFor(domain, user, req, { force })        -> one synchronous AutoSSL issuance for internal callers
//                                                        (account creation / jobs); HTTP callers go through
//                                                        ssl.autossl.issueNow, which enqueues the ssl.autossl.run job
//   ssl.installServiceCert(service, { certPem, keyPem, chainPem }, req)  service ∈ exim|dovecot|apache|ftp|panel
//   ssl.serviceCertStatus()
//   ssl.inspect(certPem, chainPem?)                   -> parsed certificate (+ chain verification)
//   ssl.removeAccountCerts(accountId, req)            -> async; call BEFORE the accounts row is deleted: uninstalls
//                                                        every installed bundle (files, vhost SSL, ACME client) then purges rows
// The web category (ctx.web) is reached lazily: applySsl(domain, paths, req) / removeSsl(domain, req), and the
// Exim/Dovecot TLS presets go through applyEximTls / applyMailserverTls (service-configuration renders those files;
// this category only writes certificate paths for Dovecot and owns the Apache protocol/cipher include).

export const TLS_PRESETS = {
  modern: {
    label: 'Modern', description: 'TLS 1.3 only. Newest clients (2019+); no legacy browsers or mail clients.',
    protocols: ['TLSv1.3'], ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305',
    ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256', preferServerCiphers: false,
  },
  intermediate: {
    label: 'Intermediate (recommended)', description: 'TLS 1.2 and 1.3 with forward-secret AEAD ciphers. Works with every browser released since 2013.',
    protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384',
    ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256', preferServerCiphers: true,
  },
  old: {
    label: 'Old (compatibility)', description: 'TLS 1.0 through 1.3 for very old mail clients and devices. Avoid unless required.',
    protocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:AES256-SHA:@SECLEVEL=0',
    ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256', preferServerCiphers: true,
  },
};

export const SSL_SERVICES = ['exim', 'dovecot', 'apache', 'ftp', 'panel'];
const BUNDLE_ROOT = '/etc/ssl/whm';
const AUTOSSL_DEFAULTS = { provider: 'disabled', email: '', method: 'webroot', staging: false, key_type: 'ecdsa', renew_days: 30, include_www: true, replace_custom: false };
const INSTALL_STATE = { 0: 'stored', 1: 'installed', 2: 'pending' };

// Does a certificate (CN + SANs) cover a hostname? Wildcards match one label.
export function certCovers(certificate, domain) {
  const names = new Set([certificate?.commonName, ...(certificate?.sans || [])].filter(Boolean).map((n) => n.toLowerCase()));
  if (names.has(domain)) return true;
  const parent = domain.split('.').slice(1).join('.');
  return parent.length > 0 && names.has(`*.${parent}`);
}

export function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86_400_000);
}

export function createSslService(ctx) {
  const { db, agent, capabilities, settings, crypto, logger } = ctx;

  const CERT_SELECT = 'c.*, a.username AS account, a.owner_id';
  const CERT_FROM = 'ssl_certs c LEFT JOIN accounts a ON a.id = c.account_id';
  const stmts = {
    certById: db.prepare(`SELECT ${CERT_SELECT} FROM ${CERT_FROM} WHERE c.id = ?`),
    certsVisible: db.prepare(`SELECT ${CERT_SELECT} FROM ${CERT_FROM} WHERE (@owner IS NULL OR a.owner_id = @owner) ORDER BY c.domain, c.id DESC`),
    installedByDomain: db.prepare(`SELECT ${CERT_SELECT} FROM ${CERT_FROM} WHERE c.domain = ? AND c.installed > 0 ORDER BY c.id DESC LIMIT 1`),
    installedAll: db.prepare(`SELECT ${CERT_SELECT} FROM ${CERT_FROM} WHERE c.installed > 0 AND (@owner IS NULL OR a.owner_id = @owner) ORDER BY c.domain`),
    keyCandidates: db.prepare(`SELECT ${CERT_SELECT} FROM ${CERT_FROM} WHERE c.key_enc IS NOT NULL AND (@owner IS NULL OR a.owner_id = @owner) ORDER BY CASE WHEN c.domain = @domain THEN 0 ELSE 1 END, c.id DESC LIMIT 25`),
    insertCert: db.prepare(`INSERT INTO ssl_certs (account_id, domain, cert_pem, key_enc, chain_pem, csr_pem, issuer, subject, not_before, not_after, autossl, installed)
      VALUES (@account_id, @domain, @cert_pem, @key_enc, @chain_pem, @csr_pem, @issuer, @subject, @not_before, @not_after, @autossl, @installed)`),
    updateCert: db.prepare(`UPDATE ssl_certs SET account_id = @account_id, cert_pem = @cert_pem, key_enc = @key_enc, chain_pem = @chain_pem, csr_pem = @csr_pem, issuer = @issuer, subject = @subject, not_before = @not_before, not_after = @not_after, autossl = @autossl, installed = @installed, domain = @domain WHERE id = @id`),
    setInstalled: db.prepare('UPDATE ssl_certs SET installed = ? WHERE id = ?'),
    supersede: db.prepare('UPDATE ssl_certs SET installed = 0 WHERE domain = ? AND installed > 0 AND id <> ?'),
    clearPart: { key: db.prepare('UPDATE ssl_certs SET key_enc = NULL WHERE id = ?'), csr: db.prepare('UPDATE ssl_certs SET csr_pem = NULL WHERE id = ?'), cert: db.prepare('UPDATE ssl_certs SET cert_pem = NULL, chain_pem = NULL, issuer = NULL, not_before = NULL, not_after = NULL WHERE id = ?') },
    deleteCert: db.prepare('DELETE FROM ssl_certs WHERE id = ?'),
    deleteAccountCerts: db.prepare('DELETE FROM ssl_certs WHERE account_id = ?'),
    installedByAccount: db.prepare('SELECT * FROM ssl_certs WHERE account_id = ? AND installed > 0 ORDER BY domain'),
    accountByUsername: db.prepare('SELECT * FROM accounts WHERE username = ?'),
    accountByDomain: db.prepare('SELECT * FROM accounts WHERE domain = ?'),
    accountDomain: db.prepare('SELECT d.*, a.username, a.owner_id, a.home_dir, a.suspended FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.domain = ?'),
    allDomains: db.prepare(`SELECT a.domain, a.username, a.id AS account_id, a.owner_id, a.home_dir, a.suspended, 'main' AS type, NULL AS docroot FROM accounts a
      UNION ALL SELECT d.domain, a.username, a.id, a.owner_id, a.home_dir, a.suspended, d.type, d.docroot FROM account_domains d JOIN accounts a ON a.id = d.account_id WHERE d.type IN ('addon', 'sub', 'parked', 'alias')
      ORDER BY 1`),
    exclusions: db.prepare('SELECT * FROM ssl_autossl_exclusions ORDER BY kind, value'),
    exclusionById: db.prepare('SELECT * FROM ssl_autossl_exclusions WHERE id = ?'),
    insertExclusion: db.prepare('INSERT INTO ssl_autossl_exclusions (kind, value, reason) VALUES (?, ?, ?)'),
    deleteExclusion: db.prepare('DELETE FROM ssl_autossl_exclusions WHERE id = ?'),
    insertRun: db.prepare('INSERT INTO ssl_autossl_runs (trigger, provider, job_id) VALUES (?, ?, ?)'),
    finishRun: db.prepare(`UPDATE ssl_autossl_runs SET finished_at = datetime('now'), status = ?, summary_json = ?, entries_json = ? WHERE id = ?`),
    runs: db.prepare('SELECT * FROM ssl_autossl_runs ORDER BY id DESC LIMIT ?'),
    runById: db.prepare('SELECT * FROM ssl_autossl_runs WHERE id = ?'),
    pruneRuns: db.prepare('DELETE FROM ssl_autossl_runs WHERE id NOT IN (SELECT id FROM ssl_autossl_runs ORDER BY id DESC LIMIT 50)'),
    orders: db.prepare('SELECT o.*, a.username AS account, a.owner_id FROM ssl_orders o LEFT JOIN accounts a ON a.id = o.account_id WHERE (@owner IS NULL OR a.owner_id = @owner) ORDER BY o.id DESC'),
    orderById: db.prepare('SELECT o.*, a.username AS account, a.owner_id FROM ssl_orders o LEFT JOIN accounts a ON a.id = o.account_id WHERE o.id = ?'),
    insertOrder: db.prepare('INSERT INTO ssl_orders (provider, product, domain, account_id, cert_id, status, price, currency, notes, created_by) VALUES (@provider, @product, @domain, @account_id, @cert_id, @status, @price, @currency, @notes, @created_by)'),
    updateOrder: db.prepare(`UPDATE ssl_orders SET status = @status, cert_id = @cert_id, order_ref = @order_ref, notes = @notes, updated_at = datetime('now') WHERE id = @id`),
    serviceCerts: db.prepare('SELECT service, not_after, updated_at, cert_pem IS NOT NULL AS has_cert FROM ssl_service_certs'),
    upsertServiceCert: db.prepare(`INSERT INTO ssl_service_certs (service, cert_pem, key_enc, chain_pem, not_after, updated_at) VALUES (@service, @cert_pem, @key_enc, @chain_pem, @not_after, datetime('now'))
      ON CONFLICT (service) DO UPDATE SET cert_pem = excluded.cert_pem, key_enc = excluded.key_enc, chain_pem = excluded.chain_pem, not_after = excluded.not_after, updated_at = excluded.updated_at`),
  };

  const op = (name, args, req) => agent.op(name, args, { req });
  const owner = (user) => (isRoot(user) ? null : user.id);

  // openssl rejections name the offending input, so the form can highlight the
  // field instead of showing a bare agent error.
  const FIELD_OF = { invalid_certificate: 'certPem', invalid_cert: 'certPem', invalid_key: 'keyPem', invalid_csr: 'csrPem', key_mismatch: 'keyPem' };
  async function pemOp(name, args, req) {
    try { return await op(name, args, req); } catch (err) {
      const field = err?.agentError ? FIELD_OF[err.code] : null;
      if (field) throw unprocessable(err.message, { [field]: [err.message] });
      throw err;
    }
  }

  function requireOpenssl() {
    capabilities.require('ssl', 'openssl is not installed on this server; install the openssl package');
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id, domain: row.domain, account: row.account || null, accountId: row.account_id,
      subject: row.subject, issuer: row.issuer, notBefore: row.not_before, notAfter: row.not_after,
      daysRemaining: daysUntil(row.not_after), expired: row.not_after ? daysUntil(row.not_after) < 0 : null,
      autossl: Boolean(row.autossl), installed: row.installed, state: INSTALL_STATE[row.installed] || 'stored',
      hasCert: Boolean(row.cert_pem), hasKey: Boolean(row.key_enc), hasCsr: Boolean(row.csr_pem), hasChain: Boolean(row.chain_pem),
      selfSigned: Boolean(row.cert_pem) && row.subject != null && row.subject === row.issuer,
      createdAt: row.created_at,
    };
  }

  function visible(row, user) {
    if (!row) throw notFound('Certificate');
    if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That certificate belongs to another reseller');
    return row;
  }

  function resolveAccount(username, user) {
    if (!username) return null;
    const account = stmts.accountByUsername.get(username);
    if (!account) throw notFound(`Account "${username}"`);
    if (!isRoot(user) && account.owner_id !== user.id) throw forbidden('That account belongs to another reseller');
    return account;
  }

  // Where a hostname lives: the account that owns it and its document root.
  // Root may address hostnames no account owns (the server's own hostname).
  function resolveDomain(domain, user) {
    const main = stmts.accountByDomain.get(domain);
    if (main) {
      if (!isRoot(user) && main.owner_id !== user.id) throw forbidden('That domain belongs to another reseller');
      return { domain, account: main, accountId: main.id, docroot: `${main.home_dir || `/home/${main.username}`}/public_html`, type: 'main' };
    }
    const sub = stmts.accountDomain.get(domain);
    if (sub) {
      if (!isRoot(user) && sub.owner_id !== user.id) throw forbidden('That domain belongs to another reseller');
      return { domain, account: stmts.accountByUsername.get(sub.username), accountId: sub.account_id, docroot: sub.docroot || `${sub.home_dir || `/home/${sub.username}`}/public_html`, type: sub.type };
    }
    if (!isRoot(user)) throw notFound(`Domain "${domain}"`);
    return { domain, account: null, accountId: null, docroot: null, type: 'server' };
  }

  function bundlePaths(domain) {
    const dir = `${BUNDLE_ROOT}/${domain}`;
    return { dir, cert: `${dir}/cert.pem`, key: `${dir}/key.pem`, chain: `${dir}/chain.pem`, fullchain: `${dir}/fullchain.pem` };
  }

  // The web category owns vhosts; when it is absent the bundle files are in
  // place and the row stays "pending" until a vhost picks them up.
  async function applyWeb(domain, paths, req) {
    if (typeof ctx.web?.applySsl !== 'function') return { state: 2, web: 'pending', detail: 'The web server category is not loaded; the certificate files are in place and the vhost is updated once it is.' };
    try {
      const result = await ctx.web.applySsl(domain, paths, req);
      return { state: 1, web: 'applied', detail: result ?? null };
    } catch (err) {
      logger.warn({ err, domain }, 'ssl: web apply failed');
      return { state: 2, web: 'pending', detail: err.message };
    }
  }

  function certRecord(info, { domain, accountId, certPem, keyPem, chainPem, csrPem, autossl = 0, installed = 0 }) {
    return {
      account_id: accountId ?? null, domain, cert_pem: certPem ?? null, key_enc: keyPem ? crypto.encrypt(keyPem) : null, chain_pem: chainPem ?? null, csr_pem: csrPem ?? null,
      issuer: info?.issuerText ?? null, subject: info?.subjectText ?? null, not_before: info?.notBefore ?? null, not_after: info?.notAfter ?? null, autossl: autossl ? 1 : 0, installed,
    };
  }

  async function inspect(certPem, chainPem, hostname) {
    requireOpenssl();
    const certificate = await pemOp('ssl.cert.inspect', { certPem });
    const chain = await op('ssl.cert.verify_chain', { certPem, ...(chainPem ? { chainPem } : {}), ...(hostname ? { hostname } : {}) }).catch((err) => ({ ok: false, error: err.message, output: '' }));
    return { certificate, chain };
  }

  const certs = {
    list(query, user) {
      const where = ['(@owner IS NULL OR a.owner_id = @owner)'];
      const params = { owner: owner(user) };
      if (query.q) { where.push('(c.domain LIKE @q OR c.subject LIKE @q OR c.issuer LIKE @q OR a.username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.account) { where.push('a.username = @account'); params.account = query.account; }
      if (query.kind === 'csr') where.push('c.csr_pem IS NOT NULL');
      if (query.kind === 'key') where.push('c.key_enc IS NOT NULL');
      if (query.kind === 'cert') where.push('c.cert_pem IS NOT NULL');
      if (query.installed) where.push('c.installed > 0');
      const result = paginate(db, { select: CERT_SELECT, from: CERT_FROM, where, params, sortable: { domain: 'c.domain', not_after: 'c.not_after', created_at: 'c.created_at', account: 'a.username' }, defaultSort: 'domain', query });
      return { ...result, data: result.data.map(shape) };
    },
    get(id, user) { return shape(visible(stmts.certById.get(id), user)); },
    raw(id, user) { return visible(stmts.certById.get(id), user); },
    async generateCsr({ account, domain, sans = [], key = {}, subject = {} }, user, req) {
      requireOpenssl();
      const acct = account ? resolveAccount(account, user) : resolveDomain(domain, user).account;
      if (!isRoot(user) && !acct) throw forbidden('Resellers can only generate certificates for their own accounts');
      const generated = await op('ssl.key.generate', { type: key.type || 'rsa', ...(key.bits ? { bits: key.bits } : {}), ...(key.curve ? { curve: key.curve } : {}) }, req);
      const csr = await op('ssl.csr.generate', { keyPem: generated.keyPem, subject: { ...subject, CN: domain }, sans }, req);
      const { lastInsertRowid } = stmts.insertCert.run(certRecord(null, { domain, accountId: acct?.id ?? null, keyPem: generated.keyPem, csrPem: csr.csrPem }));
      db.prepare('UPDATE ssl_certs SET subject = ? WHERE id = ?').run(Object.entries({ ...subject, CN: domain }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(','), lastInsertRowid);
      req?.audit?.({ action: 'ssl.csr.generate', target: domain, args: { account: acct?.username ?? null, sans, key: { type: generated.type, bits: generated.bits, curve: generated.curve } } });
      return { cert: shape(stmts.certById.get(lastInsertRowid)), csrPem: csr.csrPem, keyPem: generated.keyPem, key: { type: generated.type, bits: generated.bits, curve: generated.curve } };
    },
    async generateSelfSigned({ account, domain, sans = [], key = {}, subject = {}, days = 365 }, user, req) {
      requireOpenssl();
      const acct = account ? resolveAccount(account, user) : resolveDomain(domain, user).account;
      if (!isRoot(user) && !acct) throw forbidden('Resellers can only generate certificates for their own accounts');
      const result = await op('ssl.selfsigned.generate', { key: { type: key.type || 'rsa', ...(key.bits ? { bits: key.bits } : {}), ...(key.curve ? { curve: key.curve } : {}) }, subject: { ...subject, CN: domain }, sans, days }, req);
      const { lastInsertRowid } = stmts.insertCert.run(certRecord(result.certificate, { domain, accountId: acct?.id ?? null, certPem: result.certPem, keyPem: result.keyPem }));
      req?.audit?.({ action: 'ssl.selfsigned.generate', target: domain, args: { account: acct?.username ?? null, sans, days } });
      return { cert: shape(stmts.certById.get(lastInsertRowid)), certPem: result.certPem, keyPem: result.keyPem, certificate: result.certificate };
    },
    async upload({ account, domain, certPem, keyPem, chainPem, csrPem }, user, req) {
      requireOpenssl();
      if (!certPem && !keyPem && !csrPem) throw unprocessable('Provide a certificate, a private key or a CSR', { certPem: ['At least one of certPem, keyPem or csrPem is required'] });
      let info = null;
      if (certPem) {
        info = await pemOp('ssl.cert.inspect', { certPem }, req);
        domain = domain || info.commonName || info.sans[0];
        if (keyPem && !(await pemOp('ssl.key.matches', { keyPem, certPem }, req)).matches) throw unprocessable('The private key does not match the certificate', { keyPem: ['Public key differs from the certificate'] });
      } else if (csrPem) {
        const csr = await pemOp('ssl.csr.inspect', { csrPem }, req);
        domain = domain || csr.commonName || csr.sans[0];
        if (keyPem && !(await pemOp('ssl.key.matches', { keyPem, csrPem }, req)).matches) throw unprocessable('The private key does not match the CSR', { keyPem: ['Public key differs from the CSR'] });
      } else {
        await pemOp('ssl.key.inspect', { keyPem }, req);
      }
      if (!domain) throw unprocessable('A domain is required when the upload has no certificate or CSR', { domain: ['Required'] });
      const acct = account ? resolveAccount(account, user) : resolveDomain(domain, user).account;
      if (!isRoot(user) && !acct) throw forbidden('Resellers can only store certificates for their own accounts');
      const { lastInsertRowid } = stmts.insertCert.run(certRecord(info, { domain, accountId: acct?.id ?? null, certPem, keyPem, chainPem, csrPem }));
      if (!info && csrPem) db.prepare('UPDATE ssl_certs SET subject = ? WHERE id = ?').run(`CN=${domain}`, lastInsertRowid);
      req?.audit?.({ action: 'ssl.storage.upload', target: domain, args: { account: acct?.username ?? null, parts: { cert: Boolean(certPem), key: Boolean(keyPem), chain: Boolean(chainPem), csr: Boolean(csrPem) } } });
      return { cert: shape(stmts.certById.get(lastInsertRowid)), certificate: info };
    },
    inspect: (certPem, chainPem, hostname) => inspect(certPem, chainPem, hostname),
    download(id, part, user, req) {
      const row = visible(stmts.certById.get(id), user);
      const content = part === 'key' ? (row.key_enc ? crypto.decrypt(row.key_enc) : null) : part === 'csr' ? row.csr_pem : part === 'chain' ? row.chain_pem : part === 'fullchain' ? (row.cert_pem ? `${row.cert_pem.trim()}\n${(row.chain_pem || '').trim()}`.trim() + '\n' : null) : row.cert_pem;
      if (!content) throw notFound(`${part} for certificate ${id}`);
      if (part === 'key') req?.audit?.({ action: 'ssl.storage.download_key', target: row.domain, args: { id } });
      const ext = part === 'key' ? 'key' : part === 'csr' ? 'csr' : 'crt';
      return { id, part, domain: row.domain, filename: `${row.domain.replace(/^\*\./, 'wildcard.')}${part === 'cert' ? '' : `.${part}`}.${ext}`, content };
    },
    deletePart(id, part, user, req) {
      const row = visible(stmts.certById.get(id), user);
      if (row.installed > 0 && part !== 'csr') throw conflict(`This ${part} is installed on ${row.domain}; uninstall it first (Manage SSL Hosts)`);
      stmts.clearPart[part].run(id);
      const after = stmts.certById.get(id);
      if (!after.cert_pem && !after.key_enc && !after.csr_pem) stmts.deleteCert.run(id);
      req?.audit?.({ action: `ssl.storage.delete_${part}`, target: row.domain, args: { id } });
      return { id, part, deleted: true, rowRemoved: !after.cert_pem && !after.key_enc && !after.csr_pem };
    },
    remove(id, user, req) {
      const row = visible(stmts.certById.get(id), user);
      if (row.installed > 0) throw conflict(`This certificate is installed on ${row.domain}; uninstall it first (Manage SSL Hosts)`);
      stmts.deleteCert.run(id);
      req?.audit?.({ action: 'ssl.storage.delete', target: row.domain, args: { id } });
      return { id, deleted: true };
    },
  };

  // Domains the caller may install certificates on, with their current state.
  function domains(user) {
    const seen = new Set();
    const out = [];
    for (const d of stmts.allDomains.all()) {
      if (seen.has(d.domain)) continue;
      if (!isRoot(user) && d.owner_id !== user.id) continue;
      seen.add(d.domain);
      const cert = shape(stmts.installedByDomain.get(d.domain));
      out.push({ domain: d.domain, account: d.username, accountId: d.account_id, type: d.type, suspended: Boolean(d.suspended), docroot: d.docroot || `${d.home_dir || `/home/${d.username}`}/public_html`, certificate: cert });
    }
    return out;
  }

  async function install({ domain, certId, certPem, keyPem, chainPem, force = false }, user, req) {
    requireOpenssl();
    const target = resolveDomain(domain, user);
    let source = null;
    if (certId != null) {
      source = visible(stmts.certById.get(certId), user);
      if (!source.cert_pem) throw badRequest(`Stored item #${certId} has no certificate (only a key/CSR)`);
      certPem = source.cert_pem;
      keyPem = keyPem || (source.key_enc ? crypto.decrypt(source.key_enc) : null);
      chainPem = chainPem || source.chain_pem || undefined;
    }
    if (!certPem) throw unprocessable('A certificate is required', { certPem: ['Paste a certificate or pick a stored one'] });
    const certificate = await pemOp('ssl.cert.inspect', { certPem }, req);
    if (!keyPem) {
      for (const cand of stmts.keyCandidates.all({ owner: owner(user), domain })) {
        const pemKey = crypto.decrypt(cand.key_enc);
        if ((await op('ssl.key.matches', { keyPem: pemKey, certPem }, req).catch(() => ({ matches: false }))).matches) { keyPem = pemKey; source = source || cand; break; }
      }
      if (!keyPem) throw unprocessable('No private key was provided and no stored key matches this certificate', { keyPem: ['Required: paste the matching private key'] });
    } else if (!(await pemOp('ssl.key.matches', { keyPem, certPem }, req)).matches) {
      throw unprocessable('The private key does not match the certificate', { keyPem: ['Public key differs from the certificate'] });
    }
    if (!certCovers(certificate, domain) && !force) throw unprocessable(`The certificate is issued for ${[certificate.commonName, ...certificate.sans].filter(Boolean).join(', ')}, not ${domain}`, { domain: ['Not covered by the certificate; set force=true to install anyway'] });
    if (certificate.expired && !force) throw unprocessable(`The certificate expired on ${certificate.notAfter}`, { certPem: ['Expired; set force=true to install anyway'] });
    const written = await pemOp('ssl.bundle.install_for_domain', { domain, certPem, keyPem, ...(chainPem ? { chainPem } : {}) }, req);
    const web = await applyWeb(domain, written.paths, req);
    const record = certRecord(certificate, { domain, accountId: target.accountId, certPem, keyPem, chainPem, csrPem: source?.csr_pem ?? null, autossl: source?.autossl ?? 0, installed: web.state });
    // A stored row holding this very certificate follows the install (it moves
    // to the target domain and account) unless it is installed elsewhere, so the
    // Storage Manager does not end up with one copy of the key per hostname.
    const reuse = source && source.cert_pem === certPem && (source.domain === domain || source.installed === 0);
    let id;
    if (reuse) { stmts.updateCert.run({ ...record, id: source.id }); id = source.id; } else id = Number(stmts.insertCert.run(record).lastInsertRowid);
    stmts.supersede.run(domain, id);
    req?.audit?.({ action: 'ssl.install', target: domain, args: { account: target.account?.username ?? null, certId: source?.id ?? null, issuer: certificate.issuerText, notAfter: certificate.notAfter, web: web.web } });
    return { cert: shape(stmts.certById.get(id)), certificate, paths: written.paths, web: web.web, webDetail: web.detail };
  }

  // Tells the ACME client to forget a name it issued, so its own timer stops
  // renewing it. Best effort: the bundle is gone either way.
  async function forgetAcme(domain, req) {
    const provider = settings.get('ssl.autossl.provider', 'disabled');
    if (provider === 'disabled') return { skipped: 'disabled' };
    try { return await op('ssl.acme.remove', { provider, name: domain }, req); } catch (err) {
      logger.warn({ err, domain }, 'ssl: acme client removal failed');
      return { removed: false, error: err.message };
    }
  }

  // Authorised by the DOMAIN's owner, not the stored row's: root may install a
  // reseller's stored certificate on someone else's hostname and that reseller
  // must not be able to strip it again.
  async function uninstall(domain, user, req) {
    resolveDomain(domain, user);
    const row = stmts.installedByDomain.get(domain);
    const removed = await op('ssl.bundle.remove_for_domain', { domain }, req);
    let web = 'skipped';
    if (typeof ctx.web?.removeSsl === 'function') {
      try { await ctx.web.removeSsl(domain, req); web = 'applied'; } catch (err) { logger.warn({ err, domain }, 'ssl: web removal failed'); web = `failed: ${err.message}`; }
    }
    const acme = row?.autossl ? await forgetAcme(domain, req) : null;
    if (row) stmts.setInstalled.run(0, row.id);
    req?.audit?.({ action: 'ssl.uninstall', target: domain, args: { certId: row?.id ?? null, web, acme: acme?.removed ?? null } });
    return { domain, removed: removed.removed, web, acme, cert: shape(row ? stmts.certById.get(row.id) : null) };
  }

  const hosts = {
    async list(user) {
      const rows = stmts.installedAll.all({ owner: owner(user) }).map(shape);
      let bundles = [];
      let listed = false;
      if (isRoot(user)) {
        // Rows the panel knows need no openssl pass on the agent; only strays are inspected.
        try { bundles = (await op('ssl.bundle.list', { knownDomains: rows.map((r) => r.domain) })).bundles; listed = true; } catch (err) { logger.warn({ err }, 'ssl: could not list bundle directory'); }
      }
      const known = new Set(rows.map((r) => r.domain));
      const hostsOut = rows.map((r) => {
        const b = bundles.find((x) => x.domain === r.domain);
        // present: null = unknown (reseller view, or the directory listing failed), never "missing" by default.
        return { ...r, files: b ? { present: true, hasKey: b.hasKey, hasChain: b.hasChain, notAfter: b.certificate?.notAfter ?? r.notAfter ?? null } : { present: listed ? false : null } };
      });
      for (const b of bundles) if (!known.has(b.domain)) hostsOut.push({ id: null, domain: b.domain, account: null, state: 'unmanaged', installed: 0, subject: b.certificate?.subjectText ?? null, issuer: b.certificate?.issuerText ?? null, notAfter: b.certificate?.notAfter ?? null, daysRemaining: daysUntil(b.certificate?.notAfter), expired: b.certificate ? b.certificate.expired : null, autossl: false, selfSigned: b.certificate?.selfSigned ?? false, files: { present: true, hasKey: b.hasKey, hasChain: b.hasChain } });
      return { hosts: hostsOut.sort((a, b) => a.domain.localeCompare(b.domain)), bundleRoot: BUNDLE_ROOT, bundlesListed: listed, webLinked: typeof ctx.web?.applySsl === 'function' };
    },
    // One host with what is on disk (also for "unmanaged" directories that have no row).
    async get(domain, user) {
      resolveDomain(domain, user);
      const row = stmts.installedByDomain.get(domain);
      let files = { exists: null, paths: bundlePaths(domain) };
      let certificate = null;
      let chain = null;
      try {
        const read = await op('ssl.bundle.read_for_domain', { domain });
        files = { exists: read.exists, paths: read.paths, hasChain: Boolean(read.chainPem) };
        if (read.exists) {
          certificate = read.certificate;
          chain = await op('ssl.cert.verify_chain', { certPem: read.certPem, ...(read.chainPem ? { chainPem: read.chainPem } : {}), hostname: domain }).catch((err) => ({ ok: false, error: err.message, output: '' }));
        }
      } catch (err) { logger.warn({ err, domain }, 'ssl: could not read bundle'); files.error = err.message; }
      if (!certificate && row?.cert_pem && capabilities.has('ssl')) {
        const inspected = await inspect(row.cert_pem, row.chain_pem || undefined, domain);
        certificate = inspected.certificate;
        chain = chain || inspected.chain;
      }
      if (!row && !files.exists) throw notFound(`No certificate is installed on ${domain}`);
      return { domain, cert: shape(row), state: row ? INSTALL_STATE[row.installed] : 'unmanaged', files, certificate: certificate ?? null, chain };
    },
    uninstall,
  };

  const storage = {
    list(user, { account } = {}) {
      const rows = stmts.certsVisible.all({ owner: owner(user) }).filter((r) => !account || r.account === account);
      const items = [];
      for (const r of rows) {
        const base = shape(r);
        if (r.key_enc) items.push({ ...base, kind: 'key', itemId: `${r.id}:key` });
        if (r.csr_pem) items.push({ ...base, kind: 'csr', itemId: `${r.id}:csr` });
        if (r.cert_pem) items.push({ ...base, kind: 'cert', itemId: `${r.id}:cert` });
      }
      const accounts = [...new Map(rows.map((r) => [r.account || '(server)', { username: r.account || null, label: r.account || 'Server (no account)' }])).values()];
      return { items, accounts, counts: { key: items.filter((i) => i.kind === 'key').length, csr: items.filter((i) => i.kind === 'csr').length, cert: items.filter((i) => i.kind === 'cert').length } };
    },
  };

  // ---------------------------------------------------------------- AutoSSL ---

  const autossl = {
    settings() {
      const out = {};
      for (const [k, d] of Object.entries(AUTOSSL_DEFAULTS)) out[k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())] = settings.get(`ssl.autossl.${k}`, d);
      return out;
    },
    async detect() { return op('ssl.acme.detect').catch(() => ({ certbot: false, acmeSh: null, providers: [], provider: null })); },
    async status() {
      const detect = await autossl.detect();
      const s = autossl.settings();
      const schedule = ctx.scheduler.list().find((x) => x.name === 'autossl-daily') || null;
      const coverage = domains({ role: 'root' }).map((d) => ({ ...d, excluded: autossl.isExcluded(d) }));
      return {
        settings: s, detect, providerInstalled: s.provider === 'disabled' ? null : detect.providers.includes(s.provider),
        exclusions: stmts.exclusions.all(), schedule: schedule ? { name: schedule.name, cron: schedule.cron, enabled: Boolean(schedule.enabled), lastRunAt: schedule.last_run_at, nextRunAt: schedule.next_run_at } : null,
        lastRun: autossl.runs(1)[0] || null, coverage,
        summary: { domains: coverage.length, secured: coverage.filter((d) => d.certificate && !d.certificate.expired).length, autossl: coverage.filter((d) => d.certificate?.autossl).length, excluded: coverage.filter((d) => d.excluded).length, expiring: coverage.filter((d) => d.certificate && d.certificate.daysRemaining != null && d.certificate.daysRemaining <= Number(s.renewDays)).length },
      };
    },
    async updateSettings(input, req) {
      if (input.provider && input.provider !== 'disabled') {
        const detect = await autossl.detect();
        if (!detect.providers.includes(input.provider)) throw new CapabilityError('acme', `${input.provider} is not installed on this server. Install certbot (python3-certbot) or acme.sh, then select it here.`);
      }
      const map = { provider: 'provider', email: 'email', method: 'method', staging: 'staging', keyType: 'key_type', renewDays: 'renew_days', includeWww: 'include_www', replaceCustom: 'replace_custom' };
      const values = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined && map[k]) values[`ssl.autossl.${map[k]}`] = v;
      settings.setMany(values);
      if (input.provider !== undefined) autossl.syncSchedule();
      req?.audit?.({ action: 'ssl.autossl.settings', args: values });
      return autossl.settings();
    },
    // The daily pass only runs while a provider is selected; otherwise the
    // schedule is paused so no job rows are queued just to be skipped.
    syncSchedule() {
      const enabled = settings.get('ssl.autossl.provider', 'disabled') !== 'disabled';
      ctx.scheduler.update('autossl-daily', { enabled });
      return enabled;
    },
    isExcluded(d) {
      const ex = stmts.exclusions.all();
      if (ex.some((e) => e.kind === 'account' && e.value === d.account)) return 'account';
      if (ex.some((e) => e.kind === 'domain' && (e.value === d.domain || d.domain.endsWith(`.${e.value}`)))) return 'domain';
      return null;
    },
    exclusions: {
      list: () => stmts.exclusions.all(),
      add(kind, value, reason, req) {
        if (kind === 'account' && !stmts.accountByUsername.get(value)) throw notFound(`Account "${value}"`);
        if (stmts.exclusions.all().some((e) => e.kind === kind && e.value === value)) throw conflict(`${value} is already excluded`);
        const { lastInsertRowid } = stmts.insertExclusion.run(kind, value, reason || null);
        req?.audit?.({ action: 'ssl.autossl.exclude', target: value, args: { kind, reason } });
        return stmts.exclusionById.get(lastInsertRowid);
      },
      remove(id, req) {
        const row = stmts.exclusionById.get(id);
        if (!row) throw notFound('Exclusion');
        stmts.deleteExclusion.run(id);
        req?.audit?.({ action: 'ssl.autossl.include', target: row.value, args: { kind: row.kind } });
        return { removed: true };
      },
    },
    async runNow({ domain, account, force = false } = {}, user, req) {
      const s = autossl.settings();
      if (s.provider === 'disabled') throw badRequest('AutoSSL is disabled; choose a provider first');
      const detect = await autossl.detect();
      if (!detect.providers.includes(s.provider)) throw new CapabilityError('acme', `${s.provider} is not installed on this server`);
      if (account) resolveAccount(account, user);
      if (domain) resolveDomain(domain, user);
      const job = ctx.jobs.enqueue('ssl.autossl.run', { trigger: 'manual', domain: domain || null, account: account || null, force }, { userId: user?.id ?? null });
      req?.audit?.({ action: 'ssl.autossl.run', target: domain || account || 'all', args: { force, job: job.id } });
      return { job };
    },
    // Reseller-reachable "issue now" for one domain: the same background job as
    // run-now (ACME takes minutes), scoped to a domain the caller owns. Forcing
    // re-issuance burns the server-wide Let's Encrypt rate limits, so only root may.
    async issueNow({ domain, force = false }, user, req) {
      if (force && !isRoot(user)) throw forbidden('Only root can force re-issuance of a valid certificate');
      return autossl.runNow({ domain, force }, user, req);
    },
    // Job handler: decides per domain whether to issue/renew, then records a run.
    async run(job) {
      const params = job?.params || {};
      const s = autossl.settings();
      const runId = Number(stmts.insertRun.run(params.trigger || 'scheduled', s.provider, job?.job?.id ?? null).lastInsertRowid);
      const entries = [];
      const finish = (status, summary) => { stmts.finishRun.run(status, JSON.stringify(summary), JSON.stringify(entries), runId); stmts.pruneRuns.run(); return { runId, status, ...summary, entries }; };
      if (s.provider === 'disabled') { job?.log?.('AutoSSL is disabled; nothing to do'); return finish('skipped', { reason: 'disabled' }); }
      const detect = await autossl.detect();
      if (!detect.providers.includes(s.provider)) { finish('failed', { reason: 'provider_missing' }); throw new CapabilityError('acme', `${s.provider} is not installed on this server`); }
      let list = domains({ role: 'root' });
      if (params.domain) list = list.filter((d) => d.domain === params.domain);
      if (params.account) list = list.filter((d) => d.account === params.account);
      job?.log?.(`AutoSSL (${s.provider}): checking ${list.length} domain${list.length === 1 ? '' : 's'}`);
      const summary = { checked: list.length, issued: 0, renewed: 0, skipped: 0, failed: 0 };
      let i = 0;
      for (const d of list) {
        i++;
        job?.progress?.((i / Math.max(1, list.length)) * 100, d.domain);
        const entry = { domain: d.domain, account: d.account, action: 'skip', message: '' };
        entries.push(entry);
        const excluded = autossl.isExcluded(d);
        if (d.suspended) { entry.message = 'account suspended'; summary.skipped++; continue; }
        if (excluded) { entry.message = `excluded (${excluded})`; summary.skipped++; continue; }
        const current = d.certificate;
        if (current && !current.autossl && !s.replaceCustom && !current.expired) { entry.message = 'custom certificate installed'; summary.skipped++; continue; }
        if (current && current.autossl && current.daysRemaining != null && current.daysRemaining > Number(s.renewDays) && !params.force) { entry.message = `valid for ${current.daysRemaining} more days`; summary.skipped++; continue; }
        try {
          const result = await autossl.issue(d, s, { force: Boolean(params.force) });
          if (result.renewed === false && current) {
            // The client kept the existing certificate (its own "not due yet" rule), so nothing was renewed.
            entry.message = `not due according to ${s.provider}; valid until ${result.certificate.notAfter}`;
            summary.skipped++;
          } else {
            entry.action = current ? 'renewed' : 'issued';
            entry.message = `${result.certificate.issuerCommonName || s.provider} until ${result.certificate.notAfter} (${result.web})${result.droppedNames?.length ? `; ${result.droppedNames.join(', ')} failed validation and was left out` : ''}`;
            summary[current ? 'renewed' : 'issued']++;
          }
          job?.log?.(`${d.domain}: ${entry.action} — ${entry.message}`);
        } catch (err) {
          entry.action = 'failed';
          entry.message = err.message;
          summary.failed++;
          job?.log?.(`${d.domain}: failed — ${err.message}`, 'warn');
        }
      }
      job?.log?.(`AutoSSL done: ${JSON.stringify(summary)}`);
      return finish(summary.failed && !summary.issued && !summary.renewed && list.length === summary.failed ? 'failed' : 'done', summary);
    },
    // One issuance for a domain row from domains(); stores and applies the result.
    async issue(d, s = autossl.settings(), { force = false, req } = {}) {
      const names = [d.domain];
      if (s.includeWww && d.type !== 'sub' && !d.domain.startsWith('www.')) names.push(`www.${d.domain}`);
      const issueArgs = (domains) => ({
        provider: s.provider, domains, method: s.method, ...(s.method === 'webroot' ? { webroot: d.docroot } : {}),
        ...(s.email ? { email: s.email } : {}), staging: Boolean(s.staging), keyType: s.keyType || 'ecdsa', force,
      });
      let result;
      let droppedNames = [];
      try {
        result = await op('ssl.acme.issue', issueArgs(names), req);
      } catch (err) {
        // Like WHM's AutoSSL: a www name that fails validation must not cost the primary domain its certificate.
        if (names.length === 1 || !(err?.agentError && err.code === 'acme_failed')) throw err;
        logger.warn({ domain: d.domain, err: err.message }, 'ssl: multi-name issuance failed, retrying with the primary name only');
        result = await op('ssl.acme.issue', issueArgs([d.domain]), req);
        droppedNames = names.slice(1);
      }
      const web = await applyWeb(d.domain, result.paths, req);
      const record = certRecord(result.certificate, { domain: d.domain, accountId: d.accountId, certPem: result.certPem, keyPem: result.keyPem, chainPem: result.chainPem, autossl: 1, installed: web.state });
      const existing = stmts.installedByDomain.get(d.domain);
      let id;
      if (existing?.autossl) { stmts.updateCert.run({ ...record, id: existing.id }); id = existing.id; } else id = Number(stmts.insertCert.run(record).lastInsertRowid);
      stmts.supersede.run(d.domain, id);
      return { cert: shape(stmts.certById.get(id)), certificate: result.certificate, renewed: result.renewed, droppedNames, paths: result.paths, web: web.web, output: result.output };
    },
    runs(limit = 20) {
      return stmts.runs.all(limit).map((r) => ({ id: r.id, trigger: r.trigger, provider: r.provider, jobId: r.job_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, summary: json.parse(r.summary_json, {}), entries: json.parse(r.entries_json, []) }));
    },
    getRun(id) {
      const r = stmts.runById.get(id);
      if (!r) throw notFound('AutoSSL run');
      return { id: r.id, trigger: r.trigger, provider: r.provider, jobId: r.job_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, summary: json.parse(r.summary_json, {}), entries: json.parse(r.entries_json, []) };
    },
  };

  async function issueFor(domain, user, req, { force = false } = {}) {
    const s = autossl.settings();
    if (s.provider === 'disabled') throw badRequest('AutoSSL is disabled');
    const detect = await autossl.detect();
    if (!detect.providers.includes(s.provider)) throw new CapabilityError('acme', `${s.provider} is not installed on this server`);
    resolveDomain(domain, user);
    const d = domains(user).find((x) => x.domain === domain);
    if (!d) throw notFound(`Domain "${domain}"`);
    const result = await autossl.issue(d, s, { force, req });
    req?.audit?.({ action: 'ssl.autossl.issue', target: domain, args: { provider: s.provider, renewed: result.renewed } });
    return result;
  }

  // ----------------------------------------------------------------- Market ---

  const market = {
    providers() {
      const list = settings.get('market.providers', []);
      const arr = Array.isArray(list) ? list : [];
      return arr.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: p.name, displayName: p.displayName || p.name, enabled: Boolean(p.enabled), url: p.url || null, products: Array.isArray(p.products) ? p.products.filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: x.name || x.id, price: x.price ?? null, currency: x.currency || 'USD', termMonths: x.termMonths ?? 12, wildcard: Boolean(x.wildcard || /wildcard/i.test(x.name || x.id)) })) : [] }));
    },
    shapeOrder(o) {
      return o && { id: o.id, provider: o.provider, product: o.product, domain: o.domain, account: o.account || null, accountId: o.account_id, certId: o.cert_id, status: o.status, price: o.price, currency: o.currency, orderRef: o.order_ref, notes: o.notes, createdAt: o.created_at, updatedAt: o.updated_at };
    },
    orders(user) { return stmts.orders.all({ owner: owner(user) }).map(market.shapeOrder); },
    order(id, user) {
      const row = stmts.orderById.get(id);
      if (!row) throw notFound('Order');
      if (!isRoot(user) && row.owner_id !== user.id) throw forbidden('That order belongs to another reseller');
      return row;
    },
    async createOrder({ provider, product, domain, account, certId, subject = {} }, user, req) {
      const p = market.providers().find((x) => x.name === provider);
      if (!p) throw notFound(`Provider "${provider}"`);
      if (!p.enabled) throw badRequest(`Provider "${p.displayName}" is disabled. Enable and configure it in Market → Market Provider Manager.`);
      const prod = p.products.find((x) => x.id === product);
      if (!prod) throw notFound(`Product "${product}" at ${p.displayName}`);
      const target = resolveDomain(domain, user);
      if (account) resolveAccount(account, user);
      let csrRow;
      let csrPem = null;
      if (certId != null) {
        csrRow = visible(stmts.certById.get(certId), user);
        if (!csrRow.csr_pem) throw badRequest(`Stored item #${certId} has no CSR`);
        csrPem = csrRow.csr_pem;
      } else {
        const gen = await certs.generateCsr({ account: account || target.account?.username, domain, sans: prod.wildcard ? [`*.${domain}`] : [`www.${domain}`], subject }, user, req);
        csrRow = stmts.certById.get(gen.cert.id);
        csrPem = gen.csrPem;
      }
      const notes = `Order recorded. Submit the CSR to ${p.displayName}${p.url ? ` (${p.url})` : ''} with the "${prod.name}" product, then paste the issued certificate under "Complete order" to install it. Provider credentials and automatic submission are configured in Market → Market Provider Manager.`;
      const { lastInsertRowid } = stmts.insertOrder.run({ provider, product, domain, account_id: target.accountId, cert_id: csrRow.id, status: 'pending', price: prod.price, currency: prod.currency, notes, created_by: user?.id ?? null });
      req?.audit?.({ action: 'ssl.market.order', target: domain, args: { provider, product, certId: csrRow.id, price: prod.price } });
      return { order: market.shapeOrder(stmts.orderById.get(lastInsertRowid)), csrPem, provider: p, product: prod };
    },
    cancelOrder(id, user, req) {
      const row = market.order(id, user);
      if (row.status === 'installed') throw conflict('An installed order cannot be cancelled');
      stmts.updateOrder.run({ id, status: 'cancelled', cert_id: row.cert_id, order_ref: row.order_ref, notes: row.notes });
      req?.audit?.({ action: 'ssl.market.cancel', target: row.domain, args: { id } });
      return market.shapeOrder(stmts.orderById.get(id));
    },
    async completeOrder(id, { certPem, chainPem, orderRef }, user, req) {
      const row = market.order(id, user);
      if (row.status === 'cancelled') throw conflict('This order was cancelled');
      const csrRow = row.cert_id ? stmts.certById.get(row.cert_id) : null;
      if (!csrRow?.key_enc) throw badRequest('The private key generated for this order is no longer stored; paste the key via Install an SSL Certificate instead');
      const result = await install({ domain: row.domain, certPem, keyPem: crypto.decrypt(csrRow.key_enc), chainPem }, user, req);
      stmts.updateOrder.run({ id, status: 'installed', cert_id: result.cert.id, order_ref: orderRef || row.order_ref, notes: row.notes });
      req?.audit?.({ action: 'ssl.market.complete', target: row.domain, args: { id, orderRef } });
      return { order: market.shapeOrder(stmts.orderById.get(id)), ...result };
    },
  };

  // ------------------------------------------------------------- TLS policy ---

  const tls = {
    settings() {
      const g = (k, d) => settings.get(`ssl.tls.${k}`, d);
      return {
        preset: g('preset', 'intermediate'), protocols: g('protocols', TLS_PRESETS.intermediate.protocols), ciphers: g('ciphers', TLS_PRESETS.intermediate.ciphers), ciphersuites: g('ciphersuites', TLS_PRESETS.intermediate.ciphersuites),
        preferServerCiphers: Boolean(g('prefer_server_ciphers', true)), services: g('services', ['apache', 'exim', 'dovecot']),
        hsts: { enabled: Boolean(g('hsts_enabled', false)), maxAge: Number(g('hsts_max_age', 31_536_000)), includeSubdomains: Boolean(g('hsts_include_subdomains', true)), preload: Boolean(g('hsts_preload', false)) },
      };
    },
    policy(s = tls.settings()) {
      return { protocols: s.protocols, ciphers: s.ciphers, ciphersuites: s.ciphersuites || '', preferServerCiphers: s.preferServerCiphers, hsts: s.hsts };
    },
    // Who renders each daemon's TLS options: Apache is this category's include;
    // Exim and Dovecot are service-configuration's files when it exposes the
    // hooks (Dovecot always: this category never writes its protocol/ciphers).
    delegation() {
      return { exim: typeof ctx.web?.applyEximTls === 'function', dovecot: typeof ctx.web?.applyMailserverTls === 'function' };
    },
    async get() {
      const status = await op('ssl.tls_config.status').catch((err) => ({ error: err.message }));
      return { settings: tls.settings(), presets: Object.fromEntries(Object.entries(TLS_PRESETS).map(([k, v]) => [k, { label: v.label, description: v.description, protocols: v.protocols, ciphers: v.ciphers, ciphersuites: v.ciphersuites, preferServerCiphers: v.preferServerCiphers }])), status, delegated: tls.delegation(), daemons: { apache: capabilities.has('apache'), exim: capabilities.has('exim'), dovecot: capabilities.has('dovecot') } };
    },
    // The shape service-configuration's applyEximTls / applyMailserverTls take.
    mailPreset(p) {
      const order = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
      return { minProtocol: order.find((v) => p.protocols.includes(v)) || 'TLSv1.3', protocols: p.protocols, cipherList: p.ciphers, cipherSuites: p.ciphersuites || '', preferServerCiphers: p.preferServerCiphers };
    },
    async apply(next, req) {
      const policy = tls.policy(next);
      const delegated = tls.delegation();
      const present = (svc) => next.services.includes(svc) && capabilities.has(svc);
      const results = {};
      const own = ['apache', 'exim'].filter((svc) => present(svc) && !(svc === 'exim' && delegated.exim));
      const removeLegacy = [...(present('exim') && delegated.exim ? ['exim'] : []), ...(present('dovecot') ? ['dovecot'] : [])];
      if (own.length || removeLegacy.length) {
        const agentResult = await op('ssl.tls_config.apply', { policy, services: own, removeLegacy }, req);
        Object.assign(results, agentResult.results);
        for (const [svc, r] of Object.entries(agentResult.removed || {})) if (r.removed) results[svc] = { ...(results[svc] || {}), legacyRemoved: r.path || r.files };
      }
      const preset = tls.mailPreset(policy);
      for (const [svc, hook] of [['exim', 'applyEximTls'], ['dovecot', 'applyMailserverTls']]) {
        if (!present(svc) || (svc === 'exim' && !delegated.exim)) continue;
        if (!delegated[svc]) { results[svc] = { ...(results[svc] || {}), pending: true, via: 'service-configuration', note: `Applied through Service Configuration (${svc === 'exim' ? 'Exim Configuration Manager' : 'Mailserver Configuration'}), which is not loaded on this server yet; the preset is saved and applies once it is.` }; continue; }
        const result = await ctx.web[hook](preset, req);
        results[svc] = { ...(results[svc] || {}), via: 'service-configuration', ...(result && typeof result === 'object' ? result : {}) };
      }
      return { applied: Object.keys(results).filter((svc) => !results[svc].pending), results };
    },
    async update(input, req) {
      const current = tls.settings();
      const preset = input.preset || (input.protocols || input.ciphers ? 'custom' : current.preset);
      const base = TLS_PRESETS[preset] ? { protocols: TLS_PRESETS[preset].protocols, ciphers: TLS_PRESETS[preset].ciphers, ciphersuites: TLS_PRESETS[preset].ciphersuites, preferServerCiphers: TLS_PRESETS[preset].preferServerCiphers } : {};
      const next = {
        preset, protocols: input.protocols ?? base.protocols ?? current.protocols, ciphers: input.ciphers ?? base.ciphers ?? current.ciphers, ciphersuites: input.ciphersuites ?? base.ciphersuites ?? current.ciphersuites,
        preferServerCiphers: input.preferServerCiphers ?? base.preferServerCiphers ?? current.preferServerCiphers, services: input.services ?? current.services, hsts: { ...current.hsts, ...(input.hsts || {}) },
      };
      if (!next.protocols.length) throw unprocessable('Select at least one TLS protocol', { protocols: ['At least one protocol'] });
      settings.setMany({ 'ssl.tls.preset': next.preset, 'ssl.tls.protocols': next.protocols, 'ssl.tls.ciphers': next.ciphers, 'ssl.tls.ciphersuites': next.ciphersuites, 'ssl.tls.prefer_server_ciphers': next.preferServerCiphers, 'ssl.tls.services': next.services, 'ssl.tls.hsts_enabled': next.hsts.enabled, 'ssl.tls.hsts_max_age': next.hsts.maxAge, 'ssl.tls.hsts_include_subdomains': next.hsts.includeSubdomains, 'ssl.tls.hsts_preload': next.hsts.preload });
      let applied = null;
      if (input.apply !== false) {
        if (!next.services.some((svc) => capabilities.has(svc))) throw new CapabilityError('apache', 'None of Apache, Exim or Dovecot is installed on this server; the TLS policy was saved and is applied once one of them is installed.');
        applied = await tls.apply(next, req);
      }
      req?.audit?.({ action: 'ssl.tls.update', args: { preset: next.preset, protocols: next.protocols, hsts: next.hsts, services: next.services, applied: applied?.applied ?? null } });
      return { settings: tls.settings(), applied };
    },
  };

  // --------------------------------------------------------- service certs ---

  async function installServiceCert(service, { certPem, keyPem, chainPem }, req) {
    if (!SSL_SERVICES.includes(service)) throw badRequest(`Unknown service "${service}"`);
    requireOpenssl();
    if (!(await pemOp('ssl.key.matches', { keyPem, certPem }, req)).matches) throw unprocessable('The private key does not match the certificate', { keyPem: ['Public key differs from the certificate'] });
    const result = await pemOp('ssl.service_cert.install', { service, certPem, keyPem, ...(chainPem ? { chainPem } : {}) }, req);
    stmts.upsertServiceCert.run({ service, cert_pem: certPem, key_enc: crypto.encrypt(keyPem), chain_pem: chainPem ?? null, not_after: result.certificate?.notAfter ?? null });
    req?.audit?.({ action: 'ssl.service_cert.install', target: service, args: { issuer: result.certificate?.issuerText, notAfter: result.certificate?.notAfter, applied: result.applied, removed: result.removed, reload: result.reload } });
    return result;
  }

  async function serviceCertStatus() {
    const files = await op('ssl.service_cert.status').catch(() => ({}));
    const rows = Object.fromEntries(stmts.serviceCerts.all().map((r) => [r.service, r]));
    return SSL_SERVICES.map((service) => ({ service, ...(files[service] || { daemonPresent: null, hasCertificate: false, certificate: null }), stored: rows[service] ? { notAfter: rows[service].not_after, updatedAt: rows[service].updated_at } : null, daysRemaining: daysUntil(files[service]?.certificate?.notAfter ?? rows[service]?.not_after) }));
  }

  // Account termination: every installed bundle (private keys on disk), its vhost
  // SSL and its ACME registration go first, then the rows. A host that cannot be
  // cleaned is logged and reported, never a reason to block the termination.
  async function removeAccountCerts(accountId, req) {
    const installed = stmts.installedByAccount.all(accountId);
    const uninstalled = [];
    const failed = [];
    for (const row of installed) {
      try { uninstalled.push((await uninstall(row.domain, { role: 'root' }, req)).domain); } catch (err) {
        logger.warn({ err, domain: row.domain, accountId }, 'ssl: could not remove bundle during account termination');
        failed.push({ domain: row.domain, error: err.message });
      }
    }
    const { changes } = stmts.deleteAccountCerts.run(accountId);
    req?.audit?.({ action: 'ssl.account.purge', target: String(accountId), args: { removed: changes, uninstalled, failed: failed.map((f) => f.domain) } });
    return { removed: changes, uninstalled, failed };
  }

  return {
    certs, domains, install, uninstall, hosts, storage, autossl, issueFor, market, tls,
    installServiceCert, serviceCertStatus, removeAccountCerts, inspect, bundlePaths,
    certForDomain: (domain) => shape(stmts.installedByDomain.get(domain)),
    presets: TLS_PRESETS, services: SSL_SERVICES,
  };
}
