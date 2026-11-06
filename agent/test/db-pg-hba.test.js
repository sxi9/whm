import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog, DEFAULT_ALLOWED_ROOTS } from '../src/lib.js';
import { pgHbaAddress, renderPgHbaBlock, replacePgHbaBlock, findPgHbaCandidates } from '../src/ops/db.js';
import { PG_HBA_ROOTS } from '../src/managed-paths.js';

// db.pg.hba.write (contract §67). exec is spied with the real implementation
// behind it so a test can prove the op refused before any program ran; the file
// itself is only written on a host with PostgreSQL, which the CI box is not.
vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec), hasBinary: vi.fn(mod.hasBinary) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
const hasPgHba = findPgHbaCandidates().length > 0;

async function opError(promise) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OpError);
    return err;
  }
  throw new Error('expected the op to reject');
}

const SAMPLE = [
  '# PostgreSQL Client Authentication Configuration File',
  'local   all             postgres                                peer',
  'local   all             all                                     peer',
  'host    all             all             127.0.0.1/32            scram-sha-256',
  'host    all             all             ::1/128                 scram-sha-256',
  '',
].join('\n');

describe('db.pg.hba.write catalog and schema', () => {
  it('is registered, not destructive, and its roots are allowed', () => {
    expect(catalog.has('db.pg.hba.write')).toBe(true);
    expect(catalog.get('db.pg.hba.write').destructive).toBe(false);
    for (const root of PG_HBA_ROOTS) expect(DEFAULT_ALLOWED_ROOTS).toContain(root);
    expect(PG_HBA_ROOTS).toEqual(['/etc/postgresql', '/var/lib/pgsql']);
  });

  it('accepts pg_hba.conf addresses only', () => {
    for (const ok of ['all', '203.0.113.5', '203.0.113.0/24', '2001:db8::1', '2001:db8::/32', 'office.example.com', '.example.com', 'host-1']) expect(pgHbaAddress.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '%', '203.0.113.%', '203.0.113.0/33', '2001:db8::/129', 'samehost', 'samenet', 'a b', 'db_%', 'x;y', '-bad.example.com', 'evil.example.com peer', '10.0.0.0/8\nhost', 'a'.repeat(256)]) expect(pgHbaAddress.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('rejects bad usernames, addresses and identifiers before any program runs', async () => {
    exec.mockClear();
    const base = { username: 'alice', hosts: ['203.0.113.5'], databases: ['alice_shop'], users: ['alice_app'] };
    for (const args of [
      { ...base, username: 'Alice' }, { ...base, username: 'a;b' }, { ...base, username: '../etc' },
      { ...base, hosts: ['203.0.113.%'] }, { ...base, hosts: ['samehost'] }, { ...base, hosts: ['10.0.0.0/8; drop'] }, { ...base, hosts: 'all' },
      { ...base, databases: ['Alice_Shop'] }, { ...base, databases: ['alice_shop; drop'] }, { ...base, users: ['alice app'] }, { ...base, users: ['a"b'] },
      { ...base, extra: 1 }, { hosts: ['all'] }, { ...base, credentials: { user: 'a b' } },
    ]) {
      expect((await opError(runOp('db.pg.hba.write', args, ctx))).code, JSON.stringify(args)).toBe('invalid_args');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses objects outside the account prefix before touching the file', async () => {
    exec.mockClear();
    for (const args of [
      { username: 'alice', hosts: ['203.0.113.5'], databases: ['bob_shop'], users: ['alice_app'] },
      { username: 'alice', hosts: ['203.0.113.5'], databases: ['alice_shop'], users: ['postgres'] },
      { username: 'alice', hosts: ['203.0.113.5'], databases: ['alicex_shop'], users: ['alice_app'] },
    ]) {
      const err = await opError(runOp('db.pg.hba.write', args, ctx));
      expect(err.code, JSON.stringify(args)).toBe('refused');
      expect(err.message).toMatch(/alice_/);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('stops with capability_missing on a host without pg_hba.conf', async () => {
    if (hasPgHba || fs.existsSync('/usr/bin/psql')) return;
    const err = await opError(runOp('db.pg.hba.write', { username: 'alice', hosts: ['203.0.113.5'], databases: ['alice_shop'], users: ['alice_app'] }, ctx));
    expect(err.code).toBe('capability_missing');
  });
});

describe('pg_hba.conf rendering', () => {
  it('renders one scram-sha-256 line per address with explicit databases and users, bare IPs as /32 or /128', () => {
    const block = renderPgHbaBlock('alice', { databases: ['alice_crm', 'alice_shop'], users: ['alice_app', 'alice_ro'], hosts: ['203.0.113.5', '2001:db8::7', '198.51.100.0/24', 'office.example.com', 'all'] });
    const lines = block.split('\n');
    expect(lines[0]).toBe('# BEGIN Keel remote access: alice');
    expect(lines.at(-2)).toBe('# END Keel remote access: alice');
    expect(lines.at(-1)).toBe('');
    expect(lines.slice(1, -2)).toEqual([
      'host\talice_crm,alice_shop\talice_app,alice_ro\t203.0.113.5/32\tscram-sha-256',
      'host\talice_crm,alice_shop\talice_app,alice_ro\t2001:db8::7/128\tscram-sha-256',
      'host\talice_crm,alice_shop\talice_app,alice_ro\t198.51.100.0/24\tscram-sha-256',
      'host\talice_crm,alice_shop\talice_app,alice_ro\toffice.example.com\tscram-sha-256',
      'host\talice_crm,alice_shop\talice_app,alice_ro\tall\tscram-sha-256',
    ]);
    // Nothing to open: no block at all (never "all all").
    expect(renderPgHbaBlock('alice', { databases: [], users: ['alice_app'], hosts: ['all'] })).toBe('');
    expect(renderPgHbaBlock('alice', { databases: ['alice_shop'], users: [], hosts: ['all'] })).toBe('');
    expect(renderPgHbaBlock('alice', { databases: ['alice_shop'], users: ['alice_app'], hosts: [] })).toBe('');
    expect(block).not.toMatch(/\tall\tall\t/);
  });

  it('appends a block at the end, replaces it in place, removes it, and leaves other accounts alone', () => {
    const alice = renderPgHbaBlock('alice', { databases: ['alice_shop'], users: ['alice_app'], hosts: ['203.0.113.5'] });
    const bob = renderPgHbaBlock('bob', { databases: ['bob_shop'], users: ['bob_app'], hosts: ['all'] });
    const withAlice = replacePgHbaBlock(SAMPLE, 'alice', alice);
    expect(withAlice.startsWith(SAMPLE.replace(/\n$/, ''))).toBe(true);
    expect(withAlice.endsWith(`${alice}`)).toBe(true);
    const both = replacePgHbaBlock(withAlice, 'bob', bob);
    expect(both.indexOf('# BEGIN Keel remote access: alice')).toBeLessThan(both.indexOf('# BEGIN Keel remote access: bob'));
    // Distribution lines keep their position in front of the managed blocks.
    expect(both.indexOf('127.0.0.1/32')).toBeLessThan(both.indexOf('# BEGIN Keel'));
    const alice2 = renderPgHbaBlock('alice', { databases: ['alice_crm', 'alice_shop'], users: ['alice_app'], hosts: ['203.0.113.5', '10.0.0.0/8'] });
    const replaced = replacePgHbaBlock(both, 'alice', alice2);
    expect(replaced.match(/# BEGIN Keel remote access: alice/g)).toHaveLength(1);
    expect(replaced).toContain('alice_crm,alice_shop\talice_app\t10.0.0.0/8');
    expect(replaced).not.toContain('alice_shop\talice_app\t203.0.113.5/32\tscram-sha-256\n# END Keel remote access: bob');
    expect(replaced).toContain(bob.replace(/\n$/, ''));
    const removed = replacePgHbaBlock(replaced, 'alice', '');
    expect(removed).not.toContain('alice');
    expect(removed).toContain(bob.replace(/\n$/, ''));
    expect(replacePgHbaBlock(removed, 'bob', '')).toBe(SAMPLE);
    // Removing a block that is not there changes nothing; the same input renders the same output.
    expect(replacePgHbaBlock(SAMPLE, 'nobody', '')).toBe(SAMPLE);
    expect(replacePgHbaBlock(replaced, 'alice', alice2)).toBe(replaced);
    expect(replacePgHbaBlock('', 'alice', alice)).toBe(alice);
  });

  it('refuses an unterminated managed block instead of guessing where it ends', () => {
    expect(() => replacePgHbaBlock(`${SAMPLE}# BEGIN Keel remote access: alice\nhost\talice_shop\talice_app\tall\tscram-sha-256\n`, 'alice', '')).toThrow(/unterminated/);
  });

  it('lists candidate files newest cluster first (host-dependent)', () => {
    const files = findPgHbaCandidates();
    for (const f of files) expect(f).toMatch(/^\/(etc\/postgresql\/[\d.]+\/[^/]+|var\/lib\/pgsql(\/[\d.]+)?\/data)\/pg_hba\.conf$/);
  });
});
