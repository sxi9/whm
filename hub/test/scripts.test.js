import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../shared/db.js';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args, env = {}) => execFileSync(process.execPath, [path.join(HUB, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, WHM_HUB_CONFIG: '/nonexistent/hub.conf', ...env } });

test('gen-key.js writes master key, download HMAC and purpose-tagged signing keys; hub-cli.js drives the lifecycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-scripts-'));
  const keysDir = path.join(dir, 'keys');
  try {
    const master = run('gen-key.js', ['--master', '--out', path.join(dir, 'master.key')]);
    assert.match(master, /written:/);
    assert.equal(fs.statSync(path.join(dir, 'master.key')).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(path.join(dir, 'master.key'), 'utf8').trim(), /^[0-9a-f]{64}$/);
    assert.throws(() => run('gen-key.js', ['--master', '--out', path.join(dir, 'master.key')]), /exists/);

    const hmac = run('gen-key.js', ['--hmac', '--dir', keysDir]);
    assert.match(hmac, /download\.hmac/);
    assert.equal(fs.readFileSync(path.join(keysDir, 'download.hmac')).length, 32);

    const env = { WHM_HUB_DB_DIR: dir, WHM_HUB_KEYS_DIR: keysDir, WHM_HUB_MASTER_KEY_FILE: path.join(dir, 'master.key') };
    const lic = JSON.parse(run('gen-key.js', ['--license', '--json'], env));
    assert.match(lic.kid, /^[0-9a-f]{8}$/);
    assert.equal(lic.purpose, 'license');
    assert.equal(lic.status, 'active', 'the first key of a purpose becomes active');
    assert.ok(lic.pub.includes('BEGIN PUBLIC KEY'));
    assert.equal(fs.statSync(path.join(keysDir, `${lic.kid}.ed25519`)).mode & 0o777, 0o600);
    const plugin = JSON.parse(run('gen-key.js', ['--plugin', '--json'], env));
    assert.equal(plugin.purpose, 'plugin');
    assert.equal(plugin.status, 'active');
    const second = JSON.parse(run('gen-key.js', ['--plugin', '--json'], env));
    assert.equal(second.status, 'pending', 'later keys wait for activation');
    const db = openDb(path.join(dir, 'license.db'));
    assert.deepEqual(db.prepare('SELECT kid, purpose, status FROM signing_keys ORDER BY created_at').all(), [
      { kid: lic.kid, purpose: 'license', status: 'active' }, { kid: plugin.kid, purpose: 'plugin', status: 'active' }, { kid: second.kid, purpose: 'plugin', status: 'pending' },
    ]);
    db.close();

    const admin = JSON.parse(run('hub-cli.js', ['create-admin', 'root@vendor.test', '--db-dir', dir, '--keys-dir', keysDir, '--json'], { ...env, WHM_HUB_ADMIN_PASSWORD: 'Cli-Pass-12345' }));
    assert.equal(admin.role, 'vendor_admin');
    assert.equal(admin.password, '(as given)');
    const issued = JSON.parse(run('hub-cli.js', ['issue', 'whm-pro-annual', 'ops@acme.test', '--months', '12', '--json'], env));
    assert.match(issued.key, /^WHM-/);
    assert.equal(issued.edition, 'pro');
    const status = JSON.parse(run('hub-cli.js', ['status', issued.license_id, '--json'], env));
    assert.equal(status.status_now, 'active');
    const byPrefix = JSON.parse(run('hub-cli.js', ['status', issued.key.slice(0, 8), '--json'], env));
    assert.equal(byPrefix.matches.length, 1);
    const activated = JSON.parse(run('hub-cli.js', ['activate-key', second.kid, '--json'], env));
    assert.equal(activated.status, 'active');
    const health = JSON.parse(run('hub-cli.js', ['status', '--json'], env));
    assert.equal(health.health.ok, true);
    assert.equal(health.health.keys.plugin, second.kid);
    assert.equal(health.keys.find((k) => k.kid === plugin.kid).status, 'retiring');
    const revoked = JSON.parse(run('hub-cli.js', ['revoke', issued.license_id, '--reason', 'test', '--json'], env));
    assert.equal(revoked.status, 'revoked');
    assert.throws(() => run('hub-cli.js', ['bogus'], env));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('index.js --check-config boots against a temp dir and answers /healthz', () => {
  const out = execFileSync(process.execPath, [path.join(HUB, 'src/index.js'), '--check-config'], { encoding: 'utf8', env: { ...process.env, WHM_HUB_CONFIG: '/nonexistent/hub.conf' } });
  assert.match(out, /healthz: 200/);
  assert.match(out, /"ok":true/);
});
