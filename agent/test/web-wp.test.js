import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../src/exec.js';
import { runOp, createContext, OpError } from '../src/lib.js';
import { parseWpVersion, parseWpConfig, assertUnderHome, WP_HARDENING_FIXES } from '../src/ops/web.js';

// WP-CLI ops added for the bundled WP Toolkit plugin. WP-CLI is absent on the
// test host, so every op either fails the schema or reports capability_missing
// before runuser could ever be spawned.

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});

const ctx = createContext();
const SITE = { username: 'alice', path: '/home/alice/public_html' };

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

describe('web.wp.* schemas reject injection before anything runs', () => {
  it('unknown ops and extra keys', async () => {
    expect((await opError(runOp('web.wp.shell', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('web.wp.inspect', { ...SITE, extra: 1 }, ctx))).code).toBe('invalid_args');
  });

  it('usernames, paths, slugs, URLs and names', async () => {
    exec.mockClear();
    for (const username of ['-u', 'a;b', 'Alice', '../x', '']) expect((await opError(runOp('web.wp.inspect', { username, path: SITE.path }, ctx))).code, username).toBe('invalid_args');
    for (const p of ['public_html', '/home/alice/../root', '/home/alice/x\0y', '']) expect((await opError(runOp('web.wp.inspect', { username: 'alice', path: p }, ctx))).code, p).toBe('invalid_args');
    for (const name of ['../x', 'Plugin', 'a b', '--all', 'x'.repeat(101)]) expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'plugin', name }, ctx))).code, name).toBe('invalid_args');
    expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'plugin' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.update', { ...SITE, kind: 'everything', all: true }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.hardenfix', { ...SITE, fixes: ['rm-rf'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.hardenfix', { ...SITE, fixes: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.discover', { usernames: ['alice', '-x'] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.discover', { usernames: [] }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('web.wp.maintenance', { ...SITE, enabled: 'yes' }, ctx))).code).toBe('invalid_args');
    const install = { ...SITE, url: 'https://alice.com', title: 'Blog', adminUser: 'admin', adminEmail: 'a@b.co', adminPassword: 'Str0ng-Passw0rd!', dbName: 'alice_wp', dbUser: 'alice_wp', dbPassword: 'Str0ng-Passw0rd!' };
    for (const bad of [
      { url: 'javascript:alert(1)' }, { url: 'https://alice.com/$(id)' }, { title: 'line\nbreak' }, { adminUser: 'ad min' }, { adminUser: '--admin' }, { adminEmail: 'nope' }, { adminPassword: 'short' },
      { dbName: 'alice-wp' }, { dbName: 'x'.repeat(65) }, { dbUser: 'a b' }, { dbHost: 'local host' }, { tablePrefix: 'wp' }, { tablePrefix: 'WP_' }, { locale: 'en_US; id' },
    ]) expect((await opError(runOp('web.wp.install', { ...install, ...bad }, ctx))).code, JSON.stringify(bad)).toBe('invalid_args');
    expect(exec).not.toHaveBeenCalled();
  });

  it('a host without WP-CLI reports capability_missing and never spawns runuser', async () => {
    exec.mockClear();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
    try {
      expect((await runOp('web.wp.detect', {}, ctx)).installed).toBe(false);
      // Unknown users never reach the WP-CLI step either.
      expect((await opError(runOp('web.wp.inspect', { username: 'nosuchuser', path: '/home/nosuchuser/public_html' }, ctx))).code).toBe('not_found');
      expect((await opError(runOp('web.wp.update', { username: 'nosuchuser', path: '/home/nosuchuser/public_html', kind: 'core' }, ctx))).code).toBe('not_found');
      expect((await runOp('web.wp.discover', { usernames: ['nosuchuser'] }, ctx))).toEqual({ installs: [], missing: ['nosuchuser'] });
      expect(exec).not.toHaveBeenCalled();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('WordPress helpers', () => {
  it('parses the core version and wp-config constants', () => {
    expect(parseWpVersion("<?php\n$wp_version = '6.5.2';\n")).toBe('6.5.2');
    expect(parseWpVersion('nothing')).toBe(null);
    expect(parseWpConfig("define( 'DB_NAME', 'alice_wp' );\ndefine('DB_USER', \"alice_u\");\ndefine( 'DB_HOST', 'localhost' );\n$table_prefix = 'wp_';")).toEqual({ dbName: 'alice_wp', dbUser: 'alice_u', dbHost: 'localhost', tablePrefix: 'wp_' });
    expect(WP_HARDENING_FIXES).toContain('config-perms');
  });

  it('a site directory must sit under the home directory, symlinks included', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-home-'));
    try {
      const home = path.join(tmp, 'alice');
      fs.mkdirSync(path.join(home, 'public_html'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'elsewhere'));
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(home, 'public_html', 'link'));
      expect(assertUnderHome(home, path.join(home, 'public_html'))).toBe(path.join(home, 'public_html'));
      expect(assertUnderHome(home, path.join(home, 'public_html', 'new', 'site'))).toBe(path.join(home, 'public_html', 'new', 'site'));
      expect(() => assertUnderHome(home, path.join(tmp, 'elsewhere'))).toThrow(/not inside/);
      expect(() => assertUnderHome(home, `${home}2/public_html`)).toThrow(/not inside/);
      expect(() => assertUnderHome(home, path.join(home, 'public_html', 'link'))).toThrow(/symbolic link/);
      expect(() => assertUnderHome(home, path.join(home, 'public_html', 'link', 'deeper'))).toThrow(/symbolic link/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
