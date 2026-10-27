// Fills the tables the list endpoints page over with `rows` rows each, inside
// one transaction so a 20k-row seed takes well under a second. Used by the
// list-endpoint performance test; safe to run against any freshly booted test DB.
export function seedLargeTables(db, { rows = 20_000, ownerIds = [1] } = {}) {
  const pick = (arr, i) => arr[i % arr.length];
  const ts = (i) => `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')} ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
  const packages = ['starter', 'business', 'pro', 'reseller-basic', 'enterprise'];
  const actions = ['account.create', 'account.suspend', 'dns.record.add', 'settings.update', 'auth.login', 'backup.run', 'ssl.install', 'mail.queue.deliver', 'plugin.install', 'job.cancel'];
  const principals = ['root', 'resell1', 'resell2', 'ops', 'api-token-7', 'support', 'alice', 'bob', 'carol', 'dave'];
  const jobTypes = ['backup.run', 'security.advisor.scan', 'accounts.terminate', 'software.php.resync', 'dns.sync', 'mail.queue.flush', 'transfers.run', 'multi.modify', 'ssl.renew', 'plugins.bundled.install'];
  const jobStatus = ['done', 'done', 'done', 'failed', 'cancelled', 'queued', 'running'];
  const eventKinds = ['peer.test', 'dns.receive', 'config.push', 'config.pull'];
  const eventStatus = ['ok', 'ok', 'ok', 'failed', 'skipped'];
  const backupStatus = ['done', 'done', 'done', 'failed', 'running'];

  const ins = {
    account: db.prepare(`INSERT INTO accounts (username, domain, owner_id, package_name, ip, contact_email, suspended, disk_used_mb, disk_quota_mb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    audit: db.prepare(`INSERT INTO audit_log (ts, principal, role, ip, action, target, args_redacted, result, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    job: db.prepare(`INSERT INTO jobs (type, status, progress, params_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
    zone: db.prepare(`INSERT INTO dns_zones (domain, account_id, serial, ttl, updated_at) VALUES (?, ?, ?, ?, ?)`),
    record: db.prepare(`INSERT INTO dns_records (zone_id, name, type, ttl, value, line_index) VALUES (?, ?, ?, ?, ?, ?)`),
    backup: db.prepare(`INSERT INTO backups (account_id, account_name, type, path, size, status, created_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    event: db.prepare(`INSERT INTO cluster_events (cluster_id, kind, direction, source, status, message, ts) VALUES (NULL, ?, ?, ?, ?, ?, ?)`),
    pluginLog: db.prepare(`INSERT INTO plugin_logs (plugin_id, ts, level, msg, fields_json) VALUES (?, ?, ?, ?, NULL)`),
    login: db.prepare(`INSERT INTO login_attempts (ip, username, ok, created_at) VALUES (?, ?, ?, ?)`),
  };

  const seeded = { accounts: [], zones: [], bigZoneId: null };
  db.transaction(() => {
    const firstAccount = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM accounts').get().n);
    for (let i = 0; i < rows; i++) {
      const username = `perf${String(i).padStart(5, '0')}`;
      ins.account.run(username, `${username}.example.test`, pick(ownerIds, i), pick(packages, i), `203.0.113.${i % 250}`, `${username}@example.test`, i % 17 === 0 ? 1 : 0, i % 900, 1000, ts(i));
      seeded.accounts.push({ id: firstAccount + i, username });
    }
    for (let i = 0; i < rows; i++) ins.audit.run(ts(i), pick(principals, i), i % 3 ? 'root' : 'reseller', `198.51.100.${i % 200}`, pick(actions, i), `target-${i % 500}`, '{}', i % 23 === 0 ? 'error' : 'ok', `req-${i}`);
    for (let i = 0; i < rows; i++) ins.job.run(pick(jobTypes, i), pick(jobStatus, i), 100, '{}', pick(ownerIds, i), ts(i));
    const firstZone = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM dns_zones').get().n);
    for (let i = 0; i < rows; i++) {
      const acct = seeded.accounts[i];
      ins.zone.run(`${acct.username}.example.test`, acct.id, 2026010100 + (i % 99), 14400, ts(i));
      seeded.zones.push({ id: firstZone + i, domain: `${acct.username}.example.test`, accountId: acct.id });
    }
    // One record per zone plus a 2 000-record zone: the per-zone record list is what
    // the DNS Zone Manager pages over.
    seeded.bigZoneId = seeded.zones[0].id;
    for (let i = 0; i < rows; i++) ins.record.run(seeded.zones[i].id, '@', 'A', 14400, `203.0.113.${i % 250}`, 1);
    for (let i = 0; i < 2000; i++) ins.record.run(seeded.bigZoneId, `host${i}`, i % 2 ? 'A' : 'TXT', 300, i % 2 ? `198.51.100.${i % 250}` : `v=spf1 -all ${i}`, 2 + i);
    for (let i = 0; i < rows; i++) { const acct = seeded.accounts[i]; ins.backup.run(acct.id, acct.username, i % 4 ? 'full' : 'incremental', `/backup/${acct.username}-${i}.tar.gz`, 1024 * (i % 5000), pick(backupStatus, i), ts(i), pick(ownerIds, i)); }
    for (let i = 0; i < rows; i++) ins.event.run(pick(eventKinds, i), i % 2 ? 'out' : 'in', `peer${i % 7}.example.test`, pick(eventStatus, i), `event ${i}`, ts(i));
    for (let i = 0; i < rows; i++) ins.pluginLog.run(i % 3 ? 'net.whm.server-monitoring' : 'net.whm.other', `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`, i % 11 ? 'info' : 'error', `log line ${i}`);
    for (let i = 0; i < rows; i++) ins.login.run(`192.0.2.${i % 250}`, pick(principals, i), i % 5 ? 0 : 1, ts(i));
  })();
  return seeded;
}

// A 20k-message Exim queue as mail.queue.list would report it.
export function fakeMailQueue(rows = 20_000) {
  const messages = [];
  for (let i = 0; i < rows; i++) messages.push({ id: `1v${String(i).padStart(4, '0')}-00000${i % 10}-Ab`, sender: i % 9 ? `user${i % 300}@example.test` : '', recipients: [{ address: `rcpt${i % 500}@example.org`, delivered: false }], frozen: i % 13 === 0, ageSeconds: (i * 37) % 90_000, sizeBytes: 1000 + (i * 91) % 50_000 });
  return { messages, total: rows, frozen: messages.filter((m) => m.frozen).length, truncated: false };
}
