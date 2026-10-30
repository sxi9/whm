import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, migrate, hasColumn, skipExistingColumns } from '../shared/db.js';
import { LICENSE_MIGRATIONS } from '../src/index.js';

test('follow-up migrations stay idempotent: ADD COLUMN statements are skipped when the column exists', () => {
  const db = openDb(':memory:', { migrationsDir: LICENSE_MIGRATIONS });
  const files = fs.readdirSync(LICENSE_MIGRATIONS).filter((f) => /^\d{3}[a-z]_.+\.sql$/.test(f));
  assert.ok(files.length >= 2, 'the fix-round migrations exist');
  assert.ok(hasColumn(db, 'licenses', 'suspend_after') && hasColumn(db, 'portal_users', 'totp_pending_enc') && hasColumn(db, 'customers', 'source'));
  // a restored database whose ledger lags its schema re-applies every follow-up file without error
  db.prepare("DELETE FROM schema_migrations WHERE name GLOB '[0-9][0-9][0-9][a-z]_*'").run();
  assert.deepEqual(migrate(db, LICENSE_MIGRATIONS).sort(), files.sort());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pragma_table_info(\'licenses\') WHERE name = \'suspend_after\'').get().n, 1);
  assert.deepEqual(migrate(db, LICENSE_MIGRATIONS), [], 'nothing left to apply');
  db.close();
});

test('skipExistingColumns drops only single-line ADD COLUMN statements for existing columns', () => {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE t (a TEXT)');
  const sql = "ALTER TABLE t ADD COLUMN a TEXT;\nALTER TABLE t ADD COLUMN b INTEGER NOT NULL DEFAULT 0;\nCREATE INDEX IF NOT EXISTS t_b ON t(b);\n";
  const out = skipExistingColumns(db, sql);
  assert.ok(!out.includes('ADD COLUMN a '));
  assert.ok(out.includes('ADD COLUMN b INTEGER'));
  assert.ok(out.includes('CREATE INDEX'));
  db.exec(out);
  assert.ok(hasColumn(db, 't', 'b'));
  assert.throws(() => hasColumn(db, 't; DROP TABLE t', 'a'), /invalid table name/);
  db.close();
});

test('001f purges the portal password-change bodies an earlier hub stored in audit_log', () => {
  const db = openDb(':memory:', { migrationsDir: LICENSE_MIGRATIONS });
  const insert = db.prepare("INSERT INTO audit_log (ts, principal, action, args_redacted, result) VALUES ('2026-10-01T00:00:00.000Z', 'portal:pu_1', ?, ?, 'ok')");
  insert.run('POST /v1/portal/password', JSON.stringify({ current: 'Old-Pass-123', next: 'New-Pass-456' }));
  insert.run('POST /password', JSON.stringify({ current: 'Old-Pass-124', next: 'New-Pass-456' }));
  insert.run('POST /v1/portal/settings', JSON.stringify({ require_totp_for_admins: true }));
  db.prepare("DELETE FROM schema_migrations WHERE name = '001f_portal-audit-purge.sql'").run();
  assert.deepEqual(migrate(db, LICENSE_MIGRATIONS), ['001f_portal-audit-purge.sql']);
  const rows = db.prepare('SELECT action, args_redacted FROM audit_log ORDER BY id').all();
  assert.equal(rows[0].args_redacted, null);
  assert.equal(rows[1].args_redacted, null, 'refused attempts recorded under the bare route path are purged too');
  assert.equal(rows[2].args_redacted, JSON.stringify({ require_totp_for_admins: true }), 'other rows keep their args');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE args_redacted LIKE '%Old-Pass-%' OR args_redacted LIKE '%New-Pass-%'").get().n, 0);
  db.close();
});

test('migrations run against a file database the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-mig-'));
  const db = openDb(path.join(dir, 'license.db'), { migrationsDir: LICENSE_MIGRATIONS });
  assert.ok(hasColumn(db, 'customers', 'source'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
