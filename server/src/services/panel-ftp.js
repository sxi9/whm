import path from 'node:path';
import { notFound, conflict, badRequest, HttpError, CapabilityError } from '../lib/errors.js';
import { effectiveLimit, featureDisabled, limitReached } from './panel-databases.js';

// Customer panel: FTP virtual users of one hosting account. The daemon-side
// login is derived here (design §9.12: <name>@<main domain> on pure-ftpd,
// <name>.<account> on proftpd); the agent derives uid/gid/home from /etc/passwd
// and pins the login directory under that home, so nothing a customer sends
// can map a login onto another account's tree. vsftpd has no virtual users.
//
// The separator is one no hosting username can contain ("@" and "." are both
// outside arg.username), so a virtual login can never spell another account's
// system login: on proftpd mod_auth_file answers before mod_auth_unix and such
// a login would shadow that account's own FTP access. The agent refuses any
// login present in /etc/passwd as well.

export const FTP_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const REL_PATH = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,512}$/;
export const SUPPORTED_DAEMONS = ['pure-ftpd', 'proftpd'];

export const PROFTPD_SEPARATOR = '.';

export function loginFor(daemon, name, account) {
  return daemon === 'pure-ftpd' ? `${name}@${account.domain}` : `${name}${PROFTPD_SEPARATOR}${account.username}`;
}

// A path relative to the home (or absolute inside it) resolved and pinned under it.
export function resolveUnderHome(home, rel) {
  const base = path.resolve(home);
  const target = path.resolve(base, rel.replace(/^\/+/, ''));
  if (target !== base && !target.startsWith(`${base}/`)) throw new HttpError(422, 'validation_failed', 'The directory must be inside the account home', { dir: ['Outside the home directory'] });
  return target;
}

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function filezillaXml({ name, host, port, login, protocol, encryption }) {
  const enc = encryption === 'required' ? 4 : encryption === 'optional' ? 1 : 0;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FileZilla3>\n  <Servers>\n    <Server>\n      <Host>${escapeXml(host)}</Host>\n      <Port>${port}</Port>\n      <Protocol>${protocol === 'sftp' ? 1 : 0}</Protocol>\n      <Type>0</Type>\n      <User>${escapeXml(login)}</User>\n      <Logontype>1</Logontype>\n      <EncodingType>Auto</EncodingType>\n      <BypassProxy>0</BypassProxy>\n      <Name>${escapeXml(name)}</Name>\n      <Encryption>${enc}</Encryption>\n    </Server>\n  </Servers>\n</FileZilla3>\n`;
}

export function createPanelFtpService(ctx) {
  const { db, settings, agent } = ctx;

  const stmts = {
    list: db.prepare('SELECT * FROM ftp_accounts WHERE account_id = ? ORDER BY name'),
    byId: db.prepare('SELECT * FROM ftp_accounts WHERE id = ? AND account_id = ?'),
    byName: db.prepare('SELECT id FROM ftp_accounts WHERE account_id = ? AND name = ?'),
    byLogin: db.prepare('SELECT id FROM ftp_accounts WHERE login = ?'),
    accountNamed: db.prepare('SELECT id FROM accounts WHERE username = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM ftp_accounts WHERE account_id = ?'),
    insert: db.prepare('INSERT INTO ftp_accounts (account_id, name, login, daemon, dir, quota_mb) VALUES (?, ?, ?, ?, ?, ?)'),
    setQuota: db.prepare("UPDATE ftp_accounts SET quota_mb = ?, updated_at = datetime('now') WHERE id = ?"),
    touch: db.prepare("UPDATE ftp_accounts SET updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM ftp_accounts WHERE id = ?'),
  };

  const audit = (req, scope, entry) => req?.audit?.({ ...entry, target: scope.username, args: { ...(entry.args || {}), ...(scope.mode === 'acting' ? { actingAs: scope.username, by: scope.actor?.username } : {}) } });
  const featureOn = (scope) => scope.features?.ftpaccts !== false;
  const requireFeature = (scope) => { if (!featureOn(scope)) throw featureDisabled('ftpaccts'); };
  const homeOf = (scope) => scope.account.home_dir || `${settings.get('basic.home_root', '/home')}/${scope.username}`;

  function translate(err) {
    if (err?.code === 'capability_missing' || err?.code === 'binary_not_found') return new CapabilityError('ftp-virtual', err.message);
    if (err?.code === 'exists') return conflict(err.message);
    if (err?.code === 'not_found') return notFound(err.message);
    if (err?.code === 'path_not_allowed') return new HttpError(422, 'validation_failed', err.message, { dir: [err.message] });
    if (err?.code === 'unsupported' || err?.code === 'refused') return new HttpError(422, err.code, err.message);
    if (err?.code === 'invalid_args') return new HttpError(422, 'validation_failed', `The agent rejected the request: ${err.message}`, err.details?.fields);
    return err;
  }

  async function op(name, args, req) {
    try { return await agent.op(name, args, { req }); } catch (err) { throw translate(err); }
  }

  // Which daemon serves FTP and whether it takes virtual users. ctx.web.ftp.get()
  // probes the host; a failure there degrades to the selected daemon only.
  async function daemonInfo() {
    const ftp = ctx.web?.ftp;
    const selected = ftp?.selected?.() ?? 'pure-ftpd';
    let installed = false;
    let active = null;
    try {
      const d = await ftp.get();
      installed = Boolean(d?.installed);
      active = d?.active ?? null;
    } catch { /* degraded: selected only */ }
    const daemon = active || selected;
    const supportedDaemon = SUPPORTED_DAEMONS.includes(daemon);
    let virtual = null;
    if (supportedDaemon) {
      try { virtual = await agent.op('ftp.virtual.status', { daemon }); } catch (err) { virtual = { daemon, enabled: false, error: err.message }; }
    }
    const enabled = Boolean(virtual?.enabled);
    return { daemon, selected, active, installed, supportedDaemon, enabled, supported: supportedDaemon && enabled, virtual, canEnable: supportedDaemon && !enabled && typeof ftp?.enableVirtualUsers === 'function' };
  }

  function connection(scope, info) {
    const tls = ctx.web?.ftp?.settings?.()?.tls ?? 'optional';
    return { host: settings.get('basic.hostname', '') || scope.account.domain, port: Number(settings.get('panel.ftp.port', 21)) || 21, protocol: 'ftp', encryption: tls, daemon: info.daemon };
  }

  const shape = (r) => ({ id: r.id, name: r.name, login: r.login, daemon: r.daemon, dir: r.dir, quotaMb: r.quota_mb, created_at: r.created_at, updated_at: r.updated_at });

  async function list(scope) {
    requireFeature(scope);
    const info = await daemonInfo();
    const rows = stmts.list.all(scope.accountId);
    const max = effectiveLimit(scope, 'max_ftp');
    return {
      data: rows.map(shape),
      meta: {
        total: rows.length, quota: { max, used: rows.length, remaining: max == null ? null : Math.max(0, max - rows.length) },
        daemon: info.daemon, supported: info.supported, supportedDaemon: info.supportedDaemon, virtualUsersEnabled: info.enabled, canEnable: info.canEnable, hint: info.virtual?.hint ?? (info.supportedDaemon ? null : `${info.daemon} serves system users only`),
        mainLogin: scope.username, ...connection(scope, info),
      },
    };
  }

  // Seam S5: service-configuration owns PureDB/AuthUserFile; the panel asks it
  // (idempotently) to enable them when the first virtual login is created.
  async function requireVirtualUsers(req) {
    let info = await daemonInfo();
    if (!info.supportedDaemon) throw new CapabilityError('ftp-virtual', `${info.daemon} does not support per-account FTP logins; this server offers the main account login only`);
    if (!info.enabled && info.canEnable) {
      await ctx.web.ftp.enableVirtualUsers(req);
      info = await daemonInfo();
    }
    if (!info.enabled) throw new CapabilityError('ftp-virtual', info.virtual?.error || info.virtual?.hint || `Virtual FTP users are not enabled for ${info.daemon} on this server`);
    return info;
  }

  function checkPassword(password) {
    const fn = ctx.security?.passwordStrength;
    if (typeof fn !== 'function') return;
    const verdict = fn(password, 'ftp');
    if (verdict && verdict.ok === false) throw badRequest(`Password too weak (strength ${verdict.score}, minimum ${verdict.minimum})`, { password: [`Strength ${verdict.score} is below the required minimum ${verdict.minimum}`] });
  }

  async function create(scope, input, req) {
    requireFeature(scope);
    const max = effectiveLimit(scope, 'max_ftp');
    const used = stmts.count.get(scope.accountId).n;
    if (max != null && used >= max) throw limitReached('max_ftp', max);
    if (stmts.byName.get(scope.accountId, input.login)) throw conflict(`FTP account "${input.login}" already exists`);
    checkPassword(input.password);
    const info = await requireVirtualUsers(req);
    const login = loginFor(info.daemon, input.login, scope.account);
    if (stmts.byLogin.get(login)) throw conflict(`FTP login "${login}" already exists`);
    if (stmts.accountNamed.get(login)) throw conflict(`FTP login "${login}" is the login of a hosting account`);
    const home = homeOf(scope);
    const dir = resolveUnderHome(home, input.dir || `public_html`);
    const quotaMb = info.daemon === 'pure-ftpd' ? input.quotaMb ?? null : null;
    await op('files.mkdir', { username: scope.username, path: dir, mode: '0755' }, req);
    await op('ftp.user.add', { daemon: info.daemon, login, password: input.password, username: scope.username, dir, quotaMb }, req);
    let id;
    try {
      ({ lastInsertRowid: id } = stmts.insert.run(scope.accountId, input.login, login, info.daemon, dir, quotaMb));
    } catch (err) {
      await agent.op('ftp.user.remove', { daemon: info.daemon, login }, { req }).catch(() => {});
      throw err;
    }
    let sync = null;
    try { sync = await op('ftp.sync', { daemon: info.daemon }, req); } catch (err) { sync = { synced: false, error: err.message }; }
    audit(req, scope, { action: 'panel.ftp.create', args: { login, dir: path.relative(home, dir) || '.', quotaMb } });
    return { ...shape(stmts.byId.get(id, scope.accountId)), sync, ...connection(scope, info) };
  }

  function owned(scope, id) {
    const row = stmts.byId.get(id, scope.accountId);
    if (!row) throw notFound('FTP account');
    return row;
  }

  async function setPassword(scope, id, password, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    checkPassword(password);
    await op('ftp.user.passwd', { daemon: row.daemon, login: row.login, password }, req);
    stmts.touch.run(row.id);
    await op('ftp.sync', { daemon: row.daemon }, req).catch(() => {});
    audit(req, scope, { action: 'panel.ftp.password', args: { login: row.login } });
    return { id: row.id, login: row.login, changed: true };
  }

  async function setQuota(scope, id, quotaMb, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    await op('ftp.user.set_quota', { daemon: row.daemon, login: row.login, quotaMb }, req);
    stmts.setQuota.run(quotaMb, row.id);
    await op('ftp.sync', { daemon: row.daemon }, req).catch(() => {});
    audit(req, scope, { action: 'panel.ftp.quota', args: { login: row.login, quotaMb } });
    return shape(stmts.byId.get(row.id, scope.accountId));
  }

  async function remove(scope, id, req) {
    requireFeature(scope);
    const row = owned(scope, id);
    await op('ftp.user.remove', { daemon: row.daemon, login: row.login }, req);
    stmts.remove.run(row.id);
    let sync = null;
    try { sync = await op('ftp.sync', { daemon: row.daemon }, req); } catch (err) { sync = { synced: false, error: err.message }; }
    audit(req, scope, { action: 'panel.ftp.remove', args: { login: row.login } });
    return { id: row.id, login: row.login, removed: true, sync };
  }

  async function clientConfig(scope, id) {
    requireFeature(scope);
    const row = owned(scope, id);
    const info = await daemonInfo();
    const conn = connection(scope, info);
    const settingsOut = { ...conn, login: row.login, dir: row.dir, passiveMode: true, authentication: 'password (the FTP account password)' };
    return { ...settingsOut, filezilla: filezillaXml({ name: `${row.login} on ${conn.host}`, host: conn.host, port: conn.port, login: row.login, protocol: conn.protocol, encryption: conn.encryption }) };
  }

  return { list, create, setPassword, setQuota, remove, clientConfig, daemonInfo, loginFor, resolveUnderHome };
}
