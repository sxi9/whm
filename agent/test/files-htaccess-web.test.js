import { describe, it, expect } from 'vitest';
import * as ht from '../src/ops/htaccess.js';
import { DEFLATE_TYPES, HOTLINK_EXTENSIONS, HOTLINK_HOST, HOTLINK_REDIRECT, hotlinkSchema, deflateSchema, redirectLoops, parseRefererCond, parseHotlinkRule, parseDeflateLine } from '../src/ops/htaccess-web.js';

// Optimize website (mod_deflate) and hotlink protection (mod_rewrite) extend
// the managed block: these tests cover the grammar, the renderer and the
// round trip only; the file ops themselves are exercised in files-htaccess.test.js.

const HOME = '/home/alice';
const render = (spec) => ht.validateBlock(ht.renderBlock(spec, { home: HOME }));
const roundTrip = (spec) => ht.parseFile(ht.mergeBlock('', render(spec)));

describe('optimize website (mod_deflate)', () => {
  it('renders the pinned MIME list in an IfModule guard, in catalogue order, six per line', () => {
    const lines = render({ deflate: { types: ['text/css', 'text/html'] } });
    expect(lines).toEqual([ht.BEGIN, expect.stringMatching(/^# Managed/), '<IfModule mod_deflate.c>', '  AddOutputFilterByType DEFLATE text/html text/css', '</IfModule>', ht.END]);
    const all = render({ deflate: { types: [...DEFLATE_TYPES] } });
    const filters = all.filter((l) => l.startsWith('  AddOutputFilterByType DEFLATE '));
    expect(filters).toHaveLength(Math.ceil(DEFLATE_TYPES.length / 6));
    expect(filters.flatMap((l) => l.replace('  AddOutputFilterByType DEFLATE ', '').split(' '))).toEqual(DEFLATE_TYPES);
    expect(roundTrip({ deflate: { types: [...DEFLATE_TYPES] } }).spec.deflate).toEqual({ types: DEFLATE_TYPES });
    expect(roundTrip({ deflate: { types: ['image/svg+xml', 'text/html', 'text/html'] } }).spec.deflate).toEqual({ types: ['text/html', 'image/svg+xml'] });
    expect(roundTrip({}).spec).toMatchObject({ deflate: null, hotlink: null });
  });

  it('refuses MIME types outside the catalogue and any other directive', () => {
    for (const bad of [{ types: [] }, { types: ['text/html; charset=utf-8'] }, { types: ['application/x-httpd-php'] }, { types: ['text/html\nphp_value x y'] }, { types: ['*/*'] }, { extra: 1, types: ['text/html'] }]) {
      expect(deflateSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(ht.blockSchema.safeParse({ deflate: { types: ['text/html'] } }).success).toBe(true);
    expect(ht.blockSchema.safeParse({ deflate: 'on' }).success).toBe(false);
    for (const line of ['  AddOutputFilterByType DEFLATE text/html application/x-httpd-php', '  AddOutputFilterByType DEFLATE', 'AddOutputFilterByType DEFLATE text/html', '  SetOutputFilter DEFLATE', '  AddOutputFilterByType INCLUDES text/html', '<IfModule mod_php.c>']) {
      expect(() => ht.validateBlock([ht.BEGIN, line, ht.END]), line).toThrow(/grammar/);
    }
    expect(parseDeflateLine('  AddOutputFilterByType DEFLATE text/html text/css')).toEqual(['text/html', 'text/css']);
    expect(parseDeflateLine('  AddOutputFilterByType DEFLATE text/evil')).toBe(null);
  });
});

describe('hotlink protection (mod_rewrite)', () => {
  const spec = { hotlink: { hosts: ['example.com', 'cdn.example.net'], extensions: ['png', 'jpg', 'jpeg'], allowBlank: true, redirect: null } };

  it('renders a referer allow-list with escaped hosts, a pinned extension rule and the F or R=302 target', () => {
    const lines = render(spec);
    expect(lines.slice(2, -1)).toEqual([
      '<IfModule mod_rewrite.c>',
      '  RewriteEngine On',
      '  RewriteCond %{HTTP_REFERER} !^$',
      '  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?example\\.com(:[0-9]+)?(/|$) [NC]',
      '  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?cdn\\.example\\.net(:[0-9]+)?(/|$) [NC]',
      '  RewriteRule \\.(jpg|jpeg|png)$ - [F,NC,L]',
      '</IfModule>',
    ]);
    const strict = render({ hotlink: { hosts: ['example.com'], extensions: ['gif'], allowBlank: false, redirect: 'https://example.com/hotlink.html' } });
    expect(strict).not.toContain('  RewriteCond %{HTTP_REFERER} !^$');
    expect(strict).toContain('  RewriteRule \\.(gif)$ https://example.com/hotlink.html [R=302,NC,L]');
    expect(roundTrip(spec).spec.hotlink).toEqual({ hosts: ['example.com', 'cdn.example.net'], extensions: ['jpg', 'jpeg', 'png'], allowBlank: true, redirect: null });
    expect(roundTrip({ hotlink: { hosts: ['example.com'], extensions: ['gif'], allowBlank: false, redirect: 'https://example.com/hotlink.html' } }).spec.hotlink).toEqual({ hosts: ['example.com'], extensions: ['gif'], allowBlank: false, redirect: 'https://example.com/hotlink.html' });
  });

  it('coexists with the other directives of the family and survives a merge', () => {
    const full = { denyIps: ['203.0.113.9'], indexes: 'off', deflate: { types: ['text/html'] }, hotlink: spec.hotlink };
    const text = ht.mergeBlock('RewriteEngine On\nRewriteRule ^old$ /new [R=301]\n', render(full));
    expect(text.startsWith('RewriteEngine On\nRewriteRule ^old$ /new [R=301]\n\n# BEGIN Keel')).toBe(true);
    const parsed = ht.parseFile(text);
    expect(parsed.foreign).toBe(0);
    expect(parsed.spec).toEqual({ denyIps: ['203.0.113.9'], errorDocuments: {}, indexes: 'off', auth: null, deflate: { types: ['text/html'] }, hotlink: { hosts: ['example.com', 'cdn.example.net'], extensions: ['jpg', 'jpeg', 'png'], allowBlank: true, redirect: null } });
    expect(ht.mergeBlock(text, null)).toBe('RewriteEngine On\nRewriteRule ^old$ /new [R=301]\n');
  });

  it('refuses injection in hosts, extensions and the redirect at the schema', () => {
    const ok = { hosts: ['example.com'], extensions: ['jpg'] };
    const bad = [
      { ...ok, hosts: [] }, { ...ok, hosts: ['example'] }, { ...ok, hosts: ['exa mple.com'] }, { ...ok, hosts: ['example.com/'] }, { ...ok, hosts: ['Example.com'] }, { ...ok, hosts: ['example.com [OR]'] },
      { ...ok, hosts: ['example.com\n  RewriteRule . /x'] }, { ...ok, hosts: ['.*'] }, { ...ok, hosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) },
      { ...ok, extensions: [] }, { ...ok, extensions: ['php'] }, { ...ok, extensions: ['jpg|php'] }, { ...ok, extensions: ['JPG'] }, { ...ok, extensions: ['.jpg'] },
      { ...ok, redirect: '/hotlink.html' }, { ...ok, redirect: 'https://example.com/x.jpg' }, { ...ok, redirect: 'https://example.com/x.JPG' }, { ...ok, redirect: 'https://example.com/a b' },
      { ...ok, redirect: 'https://example.com/$1' }, { ...ok, redirect: 'https://example.com/%{REQUEST_URI}' }, { ...ok, redirect: 'https://example.com/x [E=x:y]' }, { ...ok, redirect: 'https://example.com/x"' },
      { ...ok, redirect: 'ftp://example.com/x' }, { ...ok, redirect: 'https://example.com/#frag' }, { ...ok, redirect: 'https://example.com/x\\y' },
      { ...ok, allowBlank: 'yes' }, { ...ok, extra: 1 },
    ];
    for (const b of bad) expect(hotlinkSchema.safeParse(b).success, JSON.stringify(b).slice(0, 120)).toBe(false);
    expect(hotlinkSchema.parse(ok)).toEqual({ hosts: ['example.com'], extensions: ['jpg'], allowBlank: true, redirect: null });
    expect(hotlinkSchema.safeParse({ ...ok, redirect: 'https://example.com/hotlink.html?from=panel' }).success).toBe(true);
    expect(hotlinkSchema.safeParse({ ...ok, redirect: 'http://static.example.com:8080/no.html' }).success).toBe(true);
    expect(redirectLoops('https://example.com/x.png', ['png'])).toBe(true);
    expect(redirectLoops('https://example.com/x.html', ['png'])).toBe(false);
    expect(redirectLoops('not a url', ['png'])).toBe(true);
    for (const h of ['example.com', 'a-b.example.co.uk', 'xn--bcher-kva.example']) expect(HOTLINK_HOST.test(h), h).toBe(true);
    for (const h of ['localhost', '-a.example.com', 'a..com', 'a.com.']) expect(HOTLINK_HOST.test(h), h).toBe(false);
    expect(HOTLINK_REDIRECT.test('https://example.com')).toBe(true);
    expect(HOTLINK_EXTENSIONS).toContain('jpg');
    expect(HOTLINK_EXTENSIONS).not.toContain('php');
  });

  it('validateBlock refuses hand-written rewrite lines and parse reports them as foreign', () => {
    for (const line of [
      '  RewriteRule . /index.php [L]', '  RewriteRule \\.(php)$ - [F,NC,L]', '  RewriteRule \\.(jpg)$ - [F]', '  RewriteRule \\.(jpg)$ /x.html [R=302,NC,L]',
      '  RewriteRule \\.(jpg)$ https://example.com/x.jpg [R=302,NC,L]', '  RewriteRule \\.(jpg)$ https://example.com/$1 [R=302,NC,L]', '  RewriteRule \\.(jpg|jpg)$ - [F,NC,L]',
      '  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?.*(:[0-9]+)?(/|$) [NC]', '  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?example.com(:[0-9]+)?(/|$) [NC]',
      '  RewriteCond %{REQUEST_URI} ^/admin', '  RewriteCond %{HTTP_REFERER} !^$ [OR]', 'RewriteEngine On', '  RewriteEngine Off', '  RewriteBase /', '<IfModule mod_rewrite.c> ',
    ]) {
      expect(() => ht.validateBlock([ht.BEGIN, line, ht.END]), line).toThrow(/grammar/);
    }
    expect(parseRefererCond('  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?example\\.com(:[0-9]+)?(/|$) [NC]')).toBe('example.com');
    expect(parseRefererCond('  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?exam\\ple\\.com(:[0-9]+)?(/|$) [NC]')).toBe(null);
    expect(parseHotlinkRule('  RewriteRule \\.(jpg|png)$ - [F,NC,L]')).toEqual({ extensions: ['jpg', 'png'], redirect: null });
    const text = ht.mergeBlock('', render(spec)).replace('  RewriteEngine On', '  RewriteEngine On\n  RewriteRule ^secret$ /x [L]');
    expect(ht.parseFile(text)).toMatchObject({ managed: true, foreign: 1 });
    const headless = ht.mergeBlock('', render(spec)).split('\n').filter((l) => !l.includes('example')).join('\n');
    expect(ht.parseFile(headless)).toMatchObject({ foreign: 1, spec: { hotlink: null } });
  });
});
