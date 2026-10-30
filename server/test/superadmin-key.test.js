import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './support/app.js';
import { keyExists, keyPath, readKey, verifyKey, writeKey, assertKeyDir, assertSetupPassword, MIN_SETUP_PASSWORD_LENGTH } from '../src/lib/superadmin-key.js';
import { readConfig } from '../src/config.js';

const run = promisify(execFile);
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'whm-cli.js');
const PASSWORD = 'owner-setup-password-1';

describe('super admin setup key', () => {
  let dir;
  let file;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sakey-')); file = keyPath(dir); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('refuses short passwords, writes a 0600 bcrypt hash and verifies only the right password', async () => {
    expect(() => assertSetupPassword('short')).toThrow(/at least/);
    expect(() => assertSetupPassword('x'.repeat(MIN_SETUP_PASSWORD_LENGTH))).not.toThrow();
    expect(keyExists(file)).toBe(false);
    expect(await verifyKey(file, PASSWORD)).toBe(false);
    await expect(writeKey(file, 'tooshort')).rejects.toThrow(/at least/);
    expect((await writeKey(file, PASSWORD)).file).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const key = readKey(file);
    expect(key.hash).toMatch(/^\$2[aby]\$12\$/);
    expect(key.hash).not.toContain(PASSWORD);
    expect(await verifyKey(file, PASSWORD)).toBe(true);
    expect(await verifyKey(file, 'owner-setup-password-2')).toBe(false);
    expect(await verifyKey(file, '')).toBe(false);
    expect(await verifyKey(file, null)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('never overwrites an existing key without the current password', async () => {
    await expect(writeKey(file, 'another-setup-password')).rejects.toThrow(/already exists/);
    await expect(writeKey(file, 'another-setup-password', { current: 'wrong-current-pw' })).rejects.toThrow(/already exists/);
    expect(await verifyKey(file, PASSWORD)).toBe(true);
    await writeKey(file, 'another-setup-password', { current: PASSWORD });
    expect(await verifyKey(file, PASSWORD)).toBe(false);
    expect(await verifyKey(file, 'another-setup-password')).toBe(true);
  });

  it('rejects a file that is not a key file', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sakey-bad-'));
    try {
      fs.writeFileSync(keyPath(other), '{"v":1,"hash":"plain"}');
      expect(() => readKey(keyPath(other))).toThrow(/not a super admin key file/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('never creates the key directory: a missing one is explained, not made', async () => {
    const missing = path.join(dir, 'not-yet', 'superadmin.key');
    expect(() => assertKeyDir(missing)).toThrow(/does not exist yet.*start the panel once/s);
    await expect(writeKey(missing, PASSWORD)).rejects.toThrow(/does not exist yet/);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  it('lives next to the config file in use, else in the data directory; WHM_SUPERADMIN_KEY_FILE overrides', () => {
    const etc = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sakey-etc-'));
    try {
      const conf = path.join(etc, 'whm.conf');
      fs.writeFileSync(conf, JSON.stringify({ dataDir: path.join(etc, 'data') }));
      const saved = { WHM_CONFIG: process.env.WHM_CONFIG, WHM_DATA_DIR: process.env.WHM_DATA_DIR, WHM_SUPERADMIN_KEY_FILE: process.env.WHM_SUPERADMIN_KEY_FILE };
      try {
        process.env.WHM_CONFIG = conf; delete process.env.WHM_DATA_DIR; delete process.env.WHM_SUPERADMIN_KEY_FILE;
        expect(readConfig()).toMatchObject({ configFile: conf, dataDir: path.join(etc, 'data'), superadminKeyFile: path.join(etc, 'superadmin.key') });
        process.env.WHM_CONFIG = path.join(etc, 'none.conf'); process.env.WHM_DATA_DIR = dir;
        expect(readConfig()).toMatchObject({ configFile: null, superadminKeyFile: keyPath(dir) });
        process.env.WHM_SUPERADMIN_KEY_FILE = path.join(etc, 'elsewhere.key');
        expect(readConfig().superadminKeyFile).toBe(path.join(etc, 'elsewhere.key'));
        expect(readConfig({ superadminKeyFile: path.join(etc, 'override.key') }).superadminKeyFile).toBe(path.join(etc, 'override.key'));
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    } finally { fs.rmSync(etc, { recursive: true, force: true }); }
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

  it('--init before the panel has created its data directory explains what is missing instead of ENOENT', async () => {
    const missing = path.join(app.dir, 'never-booted');
    const err = await cli(['superadmin', '--init'], { WHM_DATA_DIR: missing, WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD }).catch((e) => e);
    expect(err.stderr).toMatch(/does not exist yet.*start the panel once/s);
    expect(err.stderr).not.toMatch(/ENOENT/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('creates the key with --init, refuses a wrong password, grants and revokes with the right one', async () => {
    await expect(cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'short' })).rejects.toThrow(/at least/);
    const init = await cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: PASSWORD });
    expect(init.stdout).toContain(keyPath(app.dir));
    expect(fs.statSync(keyPath(app.dir)).mode & 0o777).toBe(0o600);
    // A second --init with the environment password must not replace the key.
    await expect(cli(['superadmin', '--init'], { WHM_SUPERADMIN_SETUP_PASSWORD: 'replacement-password-9' })).rejects.toThrow(/already exists/);
    expect(await verifyKey(keyPath(app.dir), PASSWORD)).toBe(true);

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
    const status = JSON.parse((await cli(['status'])).stdout);
    expect(status).toMatchObject({ superadminKey: true, superadminKeyFile: keyPath(app.dir), superadmins: 0 });
  }, 60_000);
});
