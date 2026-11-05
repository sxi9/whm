import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { roundcubeVersion, aliasFor, aliasesIn, renderRoundcubeBlock, mergeConfigBlock, stripConfigBlock, readConfigBlock, CONFIG_BLOCK, ROUNDCUBE_CONFIG, WEBMAIL_CANDIDATES, PLUGIN_SOURCE_ROOT, PLUGIN_NAME, SSO_ENDPOINT_RE } from '../src/ops/webmail.js';

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
    expect(Object.keys(r).sort()).toEqual(['apacheAlias', 'config', 'configured', 'flavor', 'globalAlias', 'installed', 'path', 'plugins', 'published', 'root', 'version']);
    expect(typeof r.installed).toBe('boolean');
    if (!r.installed) expect(r).toEqual({ installed: false, flavor: null, path: null, root: null, version: null, configured: null, apacheAlias: null, published: null, globalAlias: null, config: null, plugins: null });
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
    expect(readConfigBlock(mergeConfigBlock('<?php\n', renderRoundcubeBlock({ ...args, productName: "O'Brien \\ Co" })))).toEqual({ imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: "O'Brien \\ Co", plugins: [], ssoEndpoint: null });
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
    expect(readConfigBlock(merged)).toEqual({ imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel', plugins: [], ssoEndpoint: null });
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

describe('Roundcube plugins in the Keel block (single sign-on, contract §44)', () => {
  const base = { hostname: 'nova.example.com', imapScheme: 'ssl', imapPort: 993, smtpScheme: 'tls', smtpPort: 587, productName: 'Keel' };

  it('appends $config[\'plugins\'][] lines after the hosts, reads them back, and renders none by default', () => {
    expect(renderRoundcubeBlock(base).split('\n')).toHaveLength(3);
    const block = renderRoundcubeBlock({ ...base, plugins: ['keel_sso'] });
    expect(block.split('\n')).toEqual(["$config['imap_host'] = 'ssl://nova.example.com:993';", "$config['smtp_host'] = 'tls://nova.example.com:587';", "$config['product_name'] = 'Keel';", "$config['plugins'][] = 'keel_sso';"]);
    const merged = mergeConfigBlock("<?php\n$config['plugins'] = [\n    // 'archive',\n];\n", block);
    expect(readConfigBlock(merged)).toEqual({ imapHost: 'ssl://nova.example.com:993', smtpHost: 'tls://nova.example.com:587', productName: 'Keel', plugins: ['keel_sso'], ssoEndpoint: null });
    expect(merged.indexOf("$config['plugins'] = [")).toBeLessThan(merged.indexOf(CONFIG_BLOCK.begin));
    expect(readConfigBlock(mergeConfigBlock('<?php\n', renderRoundcubeBlock(base))).plugins).toEqual([]);
  });

  it('renders the panel loopback endpoint for the plugin and reads it back', () => {
    const endpoint = 'http://127.0.0.1:2086/api/panel/sso/webmail/';
    const block = renderRoundcubeBlock({ ...base, plugins: ['keel_sso'], ssoEndpoint: endpoint });
    expect(block.split('\n').pop()).toBe("$config['keel_sso_endpoint'] = 'http://127.0.0.1:2086/api/panel/sso/webmail/';");
    expect(readConfigBlock(mergeConfigBlock('<?php\n', block))).toMatchObject({ plugins: ['keel_sso'], ssoEndpoint: endpoint });
    expect(renderRoundcubeBlock({ ...base, plugins: ['keel_sso'] })).not.toContain('keel_sso_endpoint');
  });

  it('config.write pins the endpoint to the panel listener on 127.0.0.1', async () => {
    for (const ssoEndpoint of ['https://127.0.0.1:2087/api/panel/sso/phpmyadmin/', 'https://nova.example.com:2087/api/panel/sso/webmail/', "https://127.0.0.1:2087/api/panel/sso/webmail/'; system('id", 'http://127.0.0.1:2086/api/panel/sso/webmail', 'ftp://127.0.0.1:21/api/panel/sso/webmail/', '']) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.config.write', { ...base, plugins: ['keel_sso'], ssoEndpoint }, ctx); } catch (e) { err = e; }
      expect(err?.code, ssoEndpoint).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    }
    expect(SSO_ENDPOINT_RE.test('https://127.0.0.1:2087/api/panel/sso/webmail/')).toBe(true);
    expect(SSO_ENDPOINT_RE.test('http://127.0.0.1:2086/api/panel/sso/webmail/')).toBe(true);
  });

  it('config.write only takes plugin names that are plain identifiers (no path, quote or PHP)', async () => {
    for (const plugins of [['keel_sso', 'x'.repeat(33)], ['Keel_SSO'], ['../keel_sso'], ["a'; system('id"], ['keel sso'], 'keel_sso', new Array(9).fill('a')]) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.config.write', { ...base, plugins }, ctx); } catch (e) { err = e; }
      expect(err?.code, JSON.stringify(plugins)).toBe('invalid_args');
      expect(exec).not.toHaveBeenCalled();
    }
  });
});

describe('web.webmail.plugin.install / remove', () => {
  it('are registered (remove destructive) and refuse unknown arguments', async () => {
    expect(catalog.has('web.webmail.plugin.install')).toBe(true);
    expect(catalog.get('web.webmail.plugin.install').destructive).toBe(false);
    expect(catalog.get('web.webmail.plugin.remove').destructive).toBe(true);
    for (const args of [{}, { source: `${PLUGIN_SOURCE_ROOT}/keel_sso`, dest: '/tmp' }, { name: 'keel_sso' }]) {
      let err;
      try { await runOp('web.webmail.plugin.install', args, ctx); } catch (e) { err = e; }
      expect(err?.code, JSON.stringify(args)).toBe('invalid_args');
    }
    for (const args of [{}, { name: '../x' }, { name: 'keel_sso', path: '/x' }, { name: 'Keel' }]) {
      let err;
      try { await runOp('web.webmail.plugin.remove', args, ctx); } catch (e) { err = e; }
      expect(err?.code, JSON.stringify(args)).toBe('invalid_args');
    }
  });

  it('pins the source to <deploy>/roundcube/<name> under an allowed root and never copies from anywhere else', async () => {
    const shaped = ['/opt/whm/deploy/roundcube/keel_sso/../../../etc', '/etc/roundcube/keel_sso', '/opt/whm/deploy/roundcube/Keel_SSO', '/opt/whm/deploy/roundcube/keel_sso/keel_sso.php', 'deploy/roundcube/keel_sso', '/opt/whm/deploy/roundcube/'];
    for (const source of shaped) {
      exec.mockClear();
      let err;
      try { await runOp('web.webmail.plugin.install', { source }, ctx); } catch (e) { err = e; }
      expect(err?.code, source).toBe('invalid_args');
    }
    // Well-formed but outside the agent's roots: refused before any file is read.
    let err;
    try { await runOp('web.webmail.plugin.install', { source: '/srv/keel/deploy/roundcube/keel_sso' }, ctx); } catch (e) { err = e; }
    expect(err?.code).toBe('path_not_allowed');
    expect(ctx.assertAllowedPath(`${PLUGIN_SOURCE_ROOT}/keel_sso`, 'read')).toBe(`${PLUGIN_SOURCE_ROOT}/keel_sso`);
    expect(PLUGIN_NAME.test('keel_sso')).toBe(true);
    // A missing deployed tree is not_found (install.sh --upgrade ships it), never a copy from elsewhere.
    if (!fs.existsSync(`${PLUGIN_SOURCE_ROOT}/keel_sso`)) {
      let e2;
      try { await runOp('web.webmail.plugin.install', { source: `${PLUGIN_SOURCE_ROOT}/keel_sso` }, ctx); } catch (e) { e2 = e; }
      expect(['not_found', 'capability_missing']).toContain(e2?.code);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('the shipped plugin exists in the repo with the file the op requires', () => {
    const dir = new URL('../../deploy/roundcube/keel_sso/', import.meta.url);
    expect(fs.existsSync(new URL('keel_sso.php', dir))).toBe(true);
    expect(fs.existsSync(new URL('composer.json', dir))).toBe(true);
    const php = fs.readFileSync(new URL('keel_sso.php', dir), 'utf8');
    expect(php).toContain('class keel_sso extends rcube_plugin');
    expect(php).toContain("'startup'");
    expect(php).toContain('[A-Za-z0-9_-]{32,128}');
    expect(php).toContain('CURLOPT_SSL_VERIFYPEER => !$loopback');
    // One Roundcube user record per mailbox: the mailbox is the login, the master user the SASL authentication identity.
    for (const key of ['imap_auth_type', 'imap_auth_cid', 'imap_auth_pw', 'smtp_auth_type', 'smtp_auth_cid', 'smtp_auth_pw']) expect(php).toContain(`'${key}'`);
    expect(php).toContain("$this->rcmail->login($cred['mailbox']");
    expect(php).not.toContain("'user_create'");
    expect(php).toContain("$_SESSION['keel_sso']");
    expect(php).toContain("config->get('keel_sso_endpoint'");
    expect(JSON.parse(fs.readFileSync(new URL('composer.json', dir), 'utf8')).type).toBe('roundcube-plugin');
  });
});
