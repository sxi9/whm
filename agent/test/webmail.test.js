import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { roundcubeVersion, aliasFor, aliasesIn, renderRoundcubeBlock, mergeConfigBlock, stripConfigBlock, readConfigBlock, CONFIG_BLOCK, ROUNDCUBE_CONFIG, WEBMAIL_CANDIDATES } from '../src/ops/webmail.js';

vi.mock('../src/exec.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, exec: vi.fn(mod.exec) };
});
const { exec } = await import('../src/exec.js');

const ctx = createContext();
// The host clone runs on a server with Roundcube installed; the not_found path only exists elsewhere.
const roundcubeInstalled = fs.existsSync(ROUNDCUBE_CONFIG);

describe('web.webmail.detect', () => {
  it('is registered, read-only and rejects unknown arguments', async () => {
    expect(catalog.has('web.webmail.detect')).toBe(true);
    expect(catalog.get('web.webmail.detect').destructive).toBe(false);
    for (const bad of [{ path: '/usr/share/roundcube' }, { flavor: 'roundcube' }, { probe: true }, { lint: 'yes' }]) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.detect', bad, ctx); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(OpError);
      expect(err.code).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it('never runs a program without lint and reports a stable shape', async () => {
    exec.mockClear();
    const r = await runOp('web.webmail.detect', {}, ctx);
    expect(exec).not.toHaveBeenCalled();
    expect(Object.keys(r).sort()).toEqual(['apacheAlias', 'config', 'configured', 'flavor', 'globalAlias', 'installed', 'path', 'published', 'root', 'version']);
    expect(typeof r.installed).toBe('boolean');
    if (!r.installed) expect(r).toEqual({ installed: false, flavor: null, path: null, root: null, version: null, configured: null, apacheAlias: null, published: null, globalAlias: null, config: null });
    else {
      expect(WEBMAIL_CANDIDATES.map((c) => c.path)).toContain(r.path);
      expect(r.root.startsWith(r.path)).toBe(true);
      if (r.published) { expect(r.apacheAlias).toBe(r.published.alias); expect(['keel-host', 'distro']).toContain(r.published.source); }
      if (r.config) expect(r.config).toMatchObject({ path: ROUNDCUBE_CONFIG, ok: null });
    }
  });

  it('only probes fixed install roots (no config file is ever a candidate root); Debian web root wins', () => {
    for (const c of WEBMAIL_CANDIDATES) {
      expect(c.path.startsWith('/')).toBe(true);
      expect(c.path).not.toMatch(/config\.inc\.php|\.\./);
    }
    expect(WEBMAIL_CANDIDATES[0]).toMatchObject({ flavor: 'roundcube', path: '/var/lib/roundcube', webRoot: 'public_html' });
  });

  it('every candidate root and config file is under an allowed root (Debian and RHEL package names included), so publish and the config block work on both', () => {
    for (const c of WEBMAIL_CANDIDATES) {
      for (const p of [c.path, ...c.related, ...(c.config ? [c.config] : [])]) expect(ctx.assertAllowedPath(p, 'read'), p).toBe(p);
    }
    expect(WEBMAIL_CANDIDATES).toContainEqual(expect.objectContaining({ flavor: 'roundcube', path: '/usr/share/roundcubemail', config: '/etc/roundcubemail/config.inc.php' }));
  });

  it('parses the Roundcube version', () => {
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6');")).toBe('1.6.6');
    expect(roundcubeVersion(' * Version 1.4.13 ')).toBe('1.4.13');
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6'); ${x}")).toBe('1.6.6');
    expect(roundcubeVersion("define('RCMAIL_VERSION', '1.6.6\n');")).toBe(null);
    expect(roundcubeVersion('')).toBe(null);
  });

  it('matches Alias lines against any of the install roots, quoted or not, inside or outside a VirtualHost; comments never match', () => {
    const roots = ['/var/lib/roundcube/public_html', '/var/lib/roundcube', '/usr/share/roundcube'];
    expect(aliasFor('Alias /roundcube /var/lib/roundcube/public_html\n', roots)).toBe('/roundcube');
    expect(aliasFor('  Alias /mail "/var/lib/roundcube/"\n', roots)).toBe('/mail');
    expect(aliasFor('Alias "/webmail" "/var/lib/roundcube/public_html"\n', roots)).toBe('/webmail');
    expect(aliasFor('Alias /roundcube /usr/share/roundcube\n', roots)).toBe('/roundcube');
    expect(aliasFor('Alias /roundcube /usr/share/roundcube\n', '/var/lib/roundcube')).toBe(null);
    expect(aliasFor('Alias /webmail/ /var/lib/roundcube/public_html\n', roots)).toBe('/webmail');
    expect(aliasFor('Alias /x;y /var/lib/roundcube\n', roots)).toBe(null);
    expect(aliasFor('# Alias /roundcube /var/lib/roundcube\n', roots)).toBe(null);
    expect(aliasFor('#    Alias /roundcube /var/lib/roundcube/public_html\n', roots)).toBe(null);
    expect(aliasFor('Alias /roundcube /var/lib/roundcube/public_html/../..\n', roots)).toBe(null);
    const vhost = '<VirtualHost *:443>\n  ServerName nova.example\n  Alias "/webmail" "/var/lib/roundcube/public_html"\n</VirtualHost>\nAlias /roundcube /var/lib/roundcube/public_html\n';
    expect(aliasesIn(vhost, roots)).toEqual([{ alias: '/webmail', global: false }, { alias: '/roundcube', global: true }]);
    expect(aliasesIn('<virtualhost *:80>\nAlias /a /usr/share/roundcube\n</virtualhost>\n', roots)).toEqual([{ alias: '/a', global: false }]);
  });
});

describe('Roundcube config block', () => {
  const args = { hostname: 'nova.example.com', imapScheme: 'ssl', imapPort: 993, smtpScheme: 'tls', smtpPort: 587, productName: 'Keel' };

  it('renders imap_host, smtp_host and product_name as single-quoted PHP strings', () => {
    const block = renderRoundcubeBlock(args);
    expect(block.split('\n')).toEqual(["$config['imap_host'] = 'ssl://nova.example.com:993';", "$config['smtp_host'] = 'tls://nova.example.com:587';", "$config['product_name'] = 'Keel';"]);
    expect(renderRoundcubeBlock({ ...args, imapScheme: 'plain', imapPort: 143 })).toContain("'nova.example.com:143'");
    expect(renderRoundcubeBlock({ ...args, productName: "O'Brien \\ Co" })).toContain("'O\\'Brien \\\\ Co'");
    expect(readConfigBlock(mergeConfigBlock('<?php\n', renderRoundcubeBlock({ ...args, productName: "O'Brien \\ Co" })))).toEqual({ imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: "O'Brien \\ Co" });
  });

  it('appends the block once, replaces it in place, keeps a closing ?> last, and strips cleanly', () => {
    const debian = "<?php\n\n$config = [];\ninclude(\"/etc/roundcube/debian-db-roundcube.php\");\n$config['imap_host'] = [\"localhost:143\"];\n$config['des_key'] = 'secret-secret-secret-123';\n$config['enable_spellcheck'] = false;\n";
    const once = mergeConfigBlock(debian, renderRoundcubeBlock(args));
    expect(once.startsWith(debian.trimEnd())).toBe(true);
    expect(once).toContain(`\n\n${CONFIG_BLOCK.begin}\n$config['imap_host'] = 'ssl://nova.example.com:993';`);
    expect(once.endsWith(`${CONFIG_BLOCK.end}\n`)).toBe(true);
    expect(once).toContain("des_key'] = 'secret-secret-secret-123'");
    const twice = mergeConfigBlock(once, renderRoundcubeBlock({ ...args, hostname: 'other.example.com' }));
    expect(twice.split(CONFIG_BLOCK.begin)).toHaveLength(2);
    expect(twice).toContain('other.example.com');
    expect(twice).not.toContain('nova.example.com');
    expect(mergeConfigBlock(twice, renderRoundcubeBlock({ ...args, hostname: 'other.example.com' }))).toBe(twice);
    expect(stripConfigBlock(twice)).toBe(debian);
    expect(stripConfigBlock(debian)).toBe(debian);
    const closed = "<?php\n$config['skin'] = 'elastic';\n?>\n";
    const merged = mergeConfigBlock(closed, renderRoundcubeBlock(args));
    expect(merged.endsWith(`${CONFIG_BLOCK.end}\n?>\n`)).toBe(true);
    expect(merged.indexOf('?>')).toBeGreaterThan(merged.indexOf(CONFIG_BLOCK.end));
    expect(readConfigBlock(merged)).toEqual({ imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel' });
    expect(readConfigBlock(debian)).toBe(null);
  });
});

describe('web.webmail.config.write / remove', () => {
  it('are registered with the right destructive flags and strict schemas that reject injection', async () => {
    expect(catalog.get('web.webmail.config.write').destructive).toBe(false);
    expect(catalog.get('web.webmail.config.remove').destructive).toBe(true);
    const bad = [
      { hostname: 'nova.example.com' },
      { hostname: 'nova.example.com', productName: 'Keel', path: '/tmp/x' },
      { hostname: 'Nova.Example.com', productName: 'Keel' },
      { hostname: 'nova', productName: 'Keel' },
      { hostname: 'nova.example.com;id', productName: 'Keel' },
      { hostname: 'nova.example.com', productName: 'Keel\n$config[\'x\'] = 1;' },
      { hostname: 'nova.example.com', productName: '' },
      { hostname: 'nova.example.com', productName: 'x'.repeat(81) },
      { hostname: 'nova.example.com', productName: 'Keel', imapPort: 0 },
      { hostname: 'nova.example.com', productName: 'Keel', smtpScheme: 'starttls' },
    ];
    for (const args of bad) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.config.write', args, ctx); } catch (e) { err = e; }
      expect(err, JSON.stringify(args)).toBeInstanceOf(OpError);
      expect(err.code, JSON.stringify(args)).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    }
    let err;
    try { await runOp('web.webmail.config.remove', { path: '/etc/roundcube/config.inc.php' }, ctx); } catch (e) { err = e; }
    expect(err?.code).toBe('invalid_args');
  });

  it('refuses to touch anything but /etc/roundcube/config.inc.php and reports not_found when Roundcube is not configured', async () => {
    const restricted = createContext({ allowedRoots: ['/home'] });
    for (const [name, args] of [['web.webmail.config.write', { hostname: 'nova.example.com', productName: 'Keel' }], ['web.webmail.config.remove', {}]]) {
      let err;
      try { await runOp(name, args, restricted); } catch (e) { err = e; }
      expect(err?.code, name).toBe('path_not_allowed');
    }
    if (roundcubeInstalled) return;
    exec.mockClear();
    let err;
    try { await runOp('web.webmail.config.write', { hostname: 'nova.example.com', productName: 'Keel' }, ctx); } catch (e) { err = e; }
    expect(err?.code).toBe('not_found');
    expect(exec).not.toHaveBeenCalled();
  });
});
