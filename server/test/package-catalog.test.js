import { describe, it, expect } from 'vitest';
import {
  PACKAGE_CATALOG, PACKAGE_GROUPS, PACKAGE_GROUP_KEYS, PACKAGE_FAMILIES, catalogEntries, entryByKey, groupByKey, resolveEntry,
  packagesFor, phpExtensionPackage, matchesEntry,
} from '../src/lib/package-catalog.js';
import { STACK_COMPONENTS, componentByKey } from '../src/lib/stack-catalog.js';

const PKG_NAME = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,99}$/;
const KEY = /^[a-z][a-z0-9-]{0,39}$/;

describe('package catalog shape', () => {
  const entries = catalogEntries();

  it('has one entry per piece of software with a unique, route-safe key and a known group', () => {
    expect(entries.length).toBeGreaterThanOrEqual(60);
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of entries) {
      expect(e.key, e.key).toMatch(KEY);
      expect(PACKAGE_GROUP_KEYS, `${e.key} group`).toContain(e.category);
      expect(e.label.length, `${e.key} label`).toBeGreaterThan(2);
      expect(e.description.length, `${e.key} description`).toBeGreaterThan(10);
      expect(typeof e.recommended).toBe('boolean');
    }
    expect(new Set(PACKAGE_GROUPS.map((g) => g.key)).size).toBe(PACKAGE_GROUPS.length);
    for (const g of PACKAGE_GROUPS) expect(entries.some((e) => e.category === g.key), `group ${g.key} is empty`).toBe(true);
  });

  it('carries real package names for both families on every entry', () => {
    expect(PACKAGE_FAMILIES).toEqual(['debian', 'rhel']);
    for (const e of entries) {
      for (const fam of PACKAGE_FAMILIES) {
        expect(e.packages[fam].length, `${e.key} has no ${fam} packages`).toBeGreaterThan(0);
        for (const name of e.packages[fam]) expect(name, `${e.key} ${fam} "${name}"`).toMatch(PKG_NAME);
        expect(new Set(e.packages[fam]).size, `${e.key} ${fam} repeats a name`).toBe(e.packages[fam].length);
      }
    }
  });

  it('covers the groups the owner asked for with the expected software', () => {
    const groups = Object.fromEntries(PACKAGE_GROUPS.map((g) => [g.key, entries.filter((e) => e.category === g.key).map((e) => e.key)]));
    expect(groups.web).toEqual(expect.arrayContaining(['apache', 'nginx', 'certbot', 'apache-mod-fcgid']));
    expect(groups.php).toEqual(expect.arrayContaining(['php', 'php-mysql', 'php-gd', 'php-imagick', 'php-redis', 'php-opcache', 'php-intl']));
    expect(groups.databases).toEqual(expect.arrayContaining(['mariadb', 'postgresql', 'redis', 'memcached', 'phpmyadmin']));
    expect(groups.mail).toEqual(expect.arrayContaining(['exim', 'dovecot', 'spamassassin', 'clamav', 'roundcube']));
    expect(groups.security).toEqual(expect.arrayContaining(['fail2ban', 'modsecurity', 'rkhunter', 'lynis']));
    expect(groups.tools).toEqual(expect.arrayContaining(['git', 'rsync', 'archivers', 'imagemagick', 'ghostscript', 'ffmpeg', 'wkhtmltopdf', 'nodejs', 'python']));
    expect(groups.monitoring).toEqual(expect.arrayContaining(['htop', 'iotop', 'sysstat', 'netdata']));
    expect(groups.services).toEqual(expect.arrayContaining(['bind', 'ftp', 'quota']));
  });

  it('uses the real distribution names (no invented packages)', () => {
    expect(entryByKey('redis').packages).toEqual({ debian: ['redis-server'], rhel: ['redis'] });
    expect(entryByKey('phpmyadmin').packages).toEqual({ debian: ['phpmyadmin'], rhel: ['phpMyAdmin'] });
    expect(entryByKey('imagemagick').packages).toEqual({ debian: ['imagemagick'], rhel: ['ImageMagick'] });
    expect(entryByKey('archivers').packages.debian).toContain('xz-utils');
    expect(entryByKey('archivers').packages.rhel).toContain('xz');
    expect(entryByKey('ffmpeg').packages.rhel).toEqual(['ffmpeg-free']);
    expect(entryByKey('cpanminus').packages).toEqual({ debian: ['cpanminus'], rhel: ['perl-App-cpanminus'] });
    expect(entryByKey('build-tools').packages.debian).toContain('build-essential');
    expect(entryByKey('build-tools').packages.rhel).toEqual(expect.arrayContaining(['gcc', 'make']));
  });
});

describe('stack catalog links', () => {
  it('takes packages, capability, units and repository notes from the stack component instead of duplicating them', () => {
    const apache = entryByKey('apache');
    const component = componentByKey('apache');
    expect(apache.packages).toEqual(component.packages);
    expect(apache.capability).toBe('apache');
    expect(apache.units).toEqual(component.units);
    expect(apache.label).toBe(component.label);
    const exim = entryByKey('exim');
    expect(exim.requires.rhel).toBe(componentByKey('exim').requires.rhel);
    const raw = PACKAGE_CATALOG.find((e) => e.key === 'apache');
    expect(raw.packages).toBeUndefined();
  });

  it('links every stack component exactly once, so Install Distro Packages and the stack installer agree', () => {
    const linked = catalogEntries().map((e) => e.stack).filter(Boolean);
    expect(new Set(linked).size).toBe(linked.length);
    for (const c of STACK_COMPONENTS) expect(linked, `stack component ${c.key} is missing from the package catalog`).toContain(c.key);
  });

  it('refuses an entry that links to an unknown component', () => {
    expect(() => resolveEntry({ key: 'bogus', category: 'web', stack: 'no-such-component' })).toThrow(/unknown stack component "no-such-component"/);
  });

  it('entries without a stack link may override nothing of a component, and entries with one may override label and description', () => {
    expect(resolveEntry({ key: 'x', category: 'web', stack: 'nginx', label: 'My NGINX', description: 'mine' })).toMatchObject({ label: 'My NGINX', description: 'mine', packages: componentByKey('nginx').packages });
  });
});

describe('PHP extension expansion', () => {
  const redis = entryByKey('php-redis');
  const debian83 = { id: '8.3', layout: 'debian', packagePrefix: 'php8.3-' };
  const debian82 = { id: '8.2', layout: 'debian', packagePrefix: 'php8.2-' };
  const remi83 = { id: 'php83', layout: 'remi', packagePrefix: 'php83-php-' };
  const ea83 = { id: 'ea-php83', layout: 'ea4', packagePrefix: 'ea-php83-php-' };
  const system = { id: 'system', layout: 'rhel', packagePrefix: 'php-' };

  it('names the per-version package for every packaging layout', () => {
    expect(phpExtensionPackage(redis, debian83, 'debian')).toBe('php8.3-redis');
    expect(phpExtensionPackage(redis, remi83, 'rhel')).toBe('php83-php-pecl-redis');
    expect(phpExtensionPackage(redis, ea83, 'rhel')).toBe('ea-php83-php-pecl-redis');
    expect(phpExtensionPackage(redis, system, 'rhel')).toBe('php-pecl-redis');
    expect(phpExtensionPackage(entryByKey('php-mysql'), debian83, 'debian')).toBe('php8.3-mysql');
    expect(phpExtensionPackage(entryByKey('php-mysql'), system, 'rhel')).toBe('php-mysqlnd');
    expect(phpExtensionPackage(entryByKey('apache'), debian83, 'debian')).toBeNull();
  });

  it('falls back to the family name when the layout is unknown', () => {
    expect(phpExtensionPackage(redis, { id: 'system', layout: 'unknown', packagePrefix: 'php-' }, 'debian')).toBe('php-redis');
    expect(phpExtensionPackage(redis, { id: 'system', layout: 'unknown', packagePrefix: 'php-' }, 'rhel')).toBe('php-pecl-redis');
  });

  it('expands to every installed version, deduplicated, and to the unversioned meta-package when no PHP is installed', () => {
    expect(packagesFor(redis, 'debian', { phpVersions: [debian83, debian82] })).toEqual(['php8.3-redis', 'php8.2-redis']);
    expect(packagesFor(redis, 'rhel', { phpVersions: [remi83, system] })).toEqual(['php83-php-pecl-redis', 'php-pecl-redis']);
    expect(packagesFor(redis, 'debian')).toEqual(['php-redis']);
    expect(packagesFor(redis, 'rhel')).toEqual(['php-pecl-redis']);
    expect(packagesFor(entryByKey('nginx'), 'debian', { phpVersions: [debian83] })).toEqual(['nginx']);
    expect(packagesFor(redis, 'alpine')).toEqual([]);
    expect(packagesFor(null, 'debian')).toEqual([]);
  });

  it('never hands the family a mutable reference to the catalog', () => {
    const a = packagesFor(entryByKey('archivers'), 'debian');
    a.push('rm');
    expect(packagesFor(entryByKey('archivers'), 'debian')).not.toContain('rm');
  });
});

describe('catalog lookups', () => {
  it('finds entries by key and groups by key', () => {
    expect(entryByKey('fail2ban')).toMatchObject({ key: 'fail2ban', category: 'security', capability: 'fail2ban' });
    expect(entryByKey('nope')).toBeNull();
    expect(groupByKey('mail')).toMatchObject({ key: 'mail', label: 'Mail' });
    expect(groupByKey('nope')).toBeNull();
  });

  it('matches a filter against key, label, description and package names of either family, case-insensitively', () => {
    const im = entryByKey('php-imagick');
    expect(matchesEntry(im, 'imagick')).toBe(true);
    expect(matchesEntry(im, 'IMAGEMAGICK')).toBe(true);
    expect(matchesEntry(im, 'pecl-imagick')).toBe(true);
    expect(matchesEntry(im, 'wordpress')).toBe(true);
    expect(matchesEntry(im, 'postgres')).toBe(false);
    expect(matchesEntry(im, '')).toBe(true);
    expect(matchesEntry(im, null)).toBe(true);
    expect(matchesEntry(entryByKey('mariadb'), 'mysql')).toBe(true);
    expect(matchesEntry(entryByKey('imagemagick'), 'ImageMagick')).toBe(true);
  });

  it('only points Configure at a page the entry can rely on', () => {
    for (const e of catalogEntries()) if (e.configure) expect(e.configure, e.key).toMatch(/^\/[a-z0-9-]+\/[a-z0-9-]+$/);
  });
});
