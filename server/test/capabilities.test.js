import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createCapabilities, newestUnitMatching, resolveUnit } from '../src/lib/capabilities.js';
import { migrate } from '../src/db/index.js';
import { SERVICE_REGISTRY } from '../src/db/seed.js';

const OLD_PHP_FPM = '["php-fpm","php8.3-fpm","php8.2-fpm","php8.1-fpm"]';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fakeDb(rows) {
  return { prepare: () => ({ all: () => rows }) };
}

function fakeAgent({ binaries = {}, units = [] } = {}) {
  const calls = [];
  return {
    calls,
    async op(name, args) {
      calls.push(name);
      if (name === 'sys.binaries') return Object.fromEntries(args.names.map((n) => [n, Boolean(binaries[n])]));
      if (name === 'svc.list_units') return units;
      throw new Error(`unexpected op ${name}`);
    },
  };
}

describe('unit resolution', () => {
  it('prefers a listed candidate and otherwise the newest php<major>.<minor>-fpm unit', () => {
    const seeded = SERVICE_REGISTRY.find((s) => s.name === 'php-fpm').units;
    expect(resolveUnit('php-fpm', seeded, new Set(['php8.5-fpm', 'php-fpm']))).toBe('php-fpm');
    expect(resolveUnit('php-fpm', JSON.parse(OLD_PHP_FPM), new Set(['apache2', 'php8.5-fpm']))).toBe('php8.5-fpm');
    expect(resolveUnit('php-fpm', JSON.parse(OLD_PHP_FPM), new Set(['php8.6-fpm', 'php8.5-fpm', 'php8.10-fpm']))).toBe('php8.10-fpm');
    expect(resolveUnit('php-fpm', JSON.parse(OLD_PHP_FPM), new Set(['php9.0-fpm', 'php8.10-fpm']))).toBe('php9.0-fpm');
    expect(resolveUnit('php-fpm', JSON.parse(OLD_PHP_FPM), new Set(['php8.5-fpm-extra', 'phpsessionclean']))).toBeNull();
    expect(resolveUnit('php-fpm', JSON.parse(OLD_PHP_FPM), new Set())).toBeNull();
  });

  it('never guesses for services without a pattern', () => {
    expect(resolveUnit('httpd', ['apache2', 'httpd'], new Set(['php8.5-fpm', 'nginx']))).toBeNull();
    expect(resolveUnit('httpd', ['apache2', 'httpd'], new Set(['httpd']))).toBe('httpd');
    expect(newestUnitMatching(/^php(\d+)\.(\d+)-fpm$/, new Set(['php8.4-fpm', 'php8.5-fpm']))).toBe('php8.5-fpm');
  });

  it('resolves php-fpm to the host unit through a detection run', async () => {
    const rows = [{ name: 'php-fpm', unit_candidates: OLD_PHP_FPM }, { name: 'httpd', unit_candidates: '["apache2","httpd"]' }];
    const caps = createCapabilities({ agent: fakeAgent({ binaries: { php: true }, units: ['apache2', 'php8.5-fpm'] }), db: fakeDb(rows), logger: silent });
    await caps.refresh();
    expect(caps.unitFor('php-fpm')).toBe('php8.5-fpm');
    expect(caps.unitFor('httpd')).toBe('apache2');
    expect(caps.unitFor('named')).toBeNull();
  });
});

describe('001d migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-caps-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('upgrades an existing php-fpm row in place and is re-runnable', () => {
    const db = new Database(path.join(dir, 'whm.db'));
    migrate(db);
    db.prepare("INSERT INTO services (name, display_name, unit_candidates, position) VALUES ('php-fpm', 'PHP-FPM', ?, 70)").run(OLD_PHP_FPM);
    db.prepare("INSERT INTO services (name, display_name, unit_candidates, position) VALUES ('httpd', 'Apache', '[\"apache2\",\"httpd\"]', 30)").run();
    const rerun = () => {
      db.prepare("DELETE FROM schema_migrations WHERE name = '001d_core-services-php-fpm-units.sql'").run();
      migrate(db);
    };
    rerun();
    const upgraded = JSON.parse(db.prepare("SELECT unit_candidates FROM services WHERE name = 'php-fpm'").get().unit_candidates);
    expect(upgraded).toEqual(['php-fpm', 'php8.5-fpm', 'php8.4-fpm', 'php8.3-fpm', 'php8.2-fpm', 'php8.1-fpm']);
    expect(JSON.parse(db.prepare("SELECT unit_candidates FROM services WHERE name = 'httpd'").get().unit_candidates)).toEqual(['apache2', 'httpd']);
    rerun();
    expect(JSON.parse(db.prepare("SELECT unit_candidates FROM services WHERE name = 'php-fpm'").get().unit_candidates)).toEqual(upgraded);
    db.close();
  });
});
