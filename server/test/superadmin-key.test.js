import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './support/app.js';
import { keyExists, keyPath, readKey, verifyKey, writeKey, assertSetupPassword, MIN_SETUP_PASSWORD_LENGTH } from '../src/lib/superadmin-key.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'whm-cli.js');
const PASSWORD = 'owner-setup-password-1';

describe('super admin setup key', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sakey-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('refuses short passwords, writes a 0600 bcrypt hash and verifies only the right password', async () => {
    expect(() => assertSetupPassword('short')).toThrow(/at least/);
    expect(() => assertSetupPassword('x'.repeat(MIN_SETUP_PASSWORD_LENGTH))).not.toThrow();
    expect(keyExists(dir)).toBe(false);
    expect(await verifyKey(dir, PASSWORD)).toBe(false);
    await expect(writeKey(dir, 'tooshort')).rejects.toThrow(/at least/);
    const { file } = await writeKey(dir, PASSWORD);
    expect(file).toBe(keyPath(dir));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const key = readKey(dir);
    expect(key.hash).toMatch(/^\$2[aby]\$12\$/);
    expect(key.hash).not.toContain(PASSWORD);
    expect(await verifyKey(dir, PASSWORD)).toBe(true);
    expect(await verifyKey(dir, 'owner-setup-password-2')).toBe(false);
    expect(await verifyKey(dir, '')).toBe(false);
    expect(await verifyKey(dir, null)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('never overwrites an existing key without the current password', async () => {
    await expect(writeKey(dir, 'another-setup-password')).rejects.toThrow(/already exists/);
    await expect(writeKey(dir, 'another-setup-password', { current: 'wrong-current-pw' })).rejects.toThrow(/already exists/);
    expect(await verifyKey(dir, PASSWORD)).toBe(true);
    await writeKey(dir, 'another-setup-password', { current: PASSWORD });
    expect(await verifyKey(dir, PASSWORD)).toBe(false);
    expect(await verifyKey(dir, 'another-setup-password')).toBe(true);
  });

  it('rejects a file that is not a key file', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sakey-bad-'));
    try {
      fs.writeFileSync(keyPath(other), '{"v":1,"hash":"plain"}');
      expect(() => readKey(other)).toThrow(/not a super admin key file/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

describe('whm-cli superadmin', () => {
  let app;
  const env = (extra = {}) => ({ ...process.env, WHM_DATA_DIR: app.dir, WHM_CONFIG: path.join(app.dir, 'none.conf'), NODE_ENV: 'test', ...extra });
  const cli = (args, extra) => run(process.execPath, [CLI, ...args], { env: env(extra) });
  const flagOf = (username) => app.ctx.db.prepare('SELECT superadmin FROM users WHERE username = ?').get(username)?.superadmin;
  beforeAll(async () => { app = await createTestApp(); });
  afterAll(async () => { await app.close(); });

  it('refuses to grant without the key file and explains how to create it', async () => {
    await expect(cli(['superadmin', 'root'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD })).rejects.toThrow(/no super admin key .*superadmin --init/s);
    expect(flagOf('root')).toBe(0);
  });

  it('creates the key with --init, refuses a wrong password, grants and revokes with the right one', async () => {
    await expect(cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'short' })).rejects.toThrow(/at least/);
    const init = await cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD });
    expect(init.stdout).toContain(keyPath(app.dir));
    expect(fs.statSync(keyPath(app.dir)).mode & 0o777).toBe(0o600);
    // A second --init with the environment password must not replace the key.
    await expect(cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'replacement-password-9' })).rejects.toThrow(/already exists/);
    expect(await verifyKey(app.dir, PASSWORD)).toBe(true);

    await expect(cli(['superadmin', 'root'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'wrong-password-12' })).rejects.toThrow(/does not match/);
    expect(flagOf('root')).toBe(0);
    await expect(cli(['superadmin', 'nobody'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD })).rejects.toThrow(/no panel user/);
    const reseller = await app.createUser('clires', 'reseller');
    await expect(cli(['superadmin', reseller.username], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD })).rejects.toThrow(/only a root user/);
    expect(flagOf(reseller.username)).toBe(0);

    const grant = await cli(['superadmin', 'root'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD });
    expect(grant.stdout).toMatch(/root is now the super admin/);
    expect(flagOf('root')).toBe(1);
    expect(app.ctx.auth.isSuperadmin({ id: app.ctx.db.prepare("SELECT id FROM users WHERE username = 'root'").get().id, role: 'root' })).toBe(true);
    const audit = app.ctx.db.prepare("SELECT action, target, principal FROM audit_log WHERE action LIKE 'auth.superadmin.%' ORDER BY id").all();
    expect(audit).toEqual([{ action: 'auth.superadmin.grant', target: 'root', principal: 'whm-cli' }]);

    await expect(cli(['superadmin', '--revoke', 'root'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'wrong-password-12' })).rejects.toThrow(/does not match/);
    expect(flagOf('root')).toBe(1);
    const revoke = await cli(['superadmin', '--revoke', 'root'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD });
    expect(revoke.stdout).toMatch(/no longer the super admin/);
    expect(flagOf('root')).toBe(0);
    expect((await cli(['status'])).stdout).toContain('"superadminKey": true');
  }, 60_000);
});
