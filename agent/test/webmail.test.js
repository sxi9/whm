import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { roundcubeVersion, aliasFor, WEBMAIL_CANDIDATES } from '../src/ops/webmail.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();

describe('web.webmail.detect', () => {
  it('is registered, read-only and takes no arguments', async () => {
    expect(catalog.has('web.webmail.detect')).toBe(true);
    expect(catalog.get('web.webmail.detect').destructive).toBe(false);
    for (const bad of [{ path: '/usr/share/roundcube' }, { flavor: 'roundcube' }, { probe: true }]) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.detect', bad, ctx); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(OpError);
      expect(err.code).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('never runs a program and reports a stable shape', async () => {
    exec.mockClear();
    const r = await runOp('web.webmail.detect', {}, ctx);
    expect(exec).not.toHaveBeenCalled();
    expect(Object.keys(r).sort()).toEqual(['apacheAlias', 'configured', 'flavor', 'installed', 'path', 'version']);
    expect(typeof r.installed).toBe('boolean');
    if (!r.installed) expect(r).toEqual({ installed: false, flavor: null, path: null, version: null, configured: null, apacheAlias: null });
    else expect(WEBMAIL_CANDIDATES.map((c) => c.path)).toContain(r.path);
  });

  it('only probes fixed install roots (no config file is ever a candidate root)', () => {
    for (const c of WEBMAIL_CANDIDATES) {
      expect(c.path.startsWith('/')).toBe(true);
      expect(c.path).not.toMatch(/config\.inc\.php|\.\./);
    }
  });

  it('parses the Roundcube version and an Alias line pointing at the install root', () => {
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6');")).toBe('1.6.6');
    expect(roundcubeVersion(' * Version 1.4.13 ')).toBe('1.4.13');
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6'); ${x}")).toBe('1.6.6');
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6\n');")).toBe(null);
    expect(roundcubeVersion('')).toBe(null);
    expect(aliasFor('Alias /roundcube /var/lib/roundcube\n', '/var/lib/roundcube')).toBe('/roundcube');
    expect(aliasFor('  Alias /mail "/var/lib/roundcube/"\n', '/var/lib/roundcube')).toBe('/mail');
    expect(aliasFor('Alias /roundcube /usr/share/roundcube\n', '/var/lib/roundcube')).toBe(null);
    expect(aliasFor('Alias /x;y /var/lib/roundcube\n', '/var/lib/roundcube')).toBe(null);
    expect(aliasFor('# Alias /roundcube /var/lib/roundcube\n', '/var/lib/roundcube')).toBe(null);
  });
});
