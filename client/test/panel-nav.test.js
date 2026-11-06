import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CATEGORIES, FUNCTIONS } from '../src/nav.js';
import {
  PANEL_BASE, PANEL_CATEGORIES, PANEL_CATEGORY_DEFS, PANEL_FUNCTIONS, PANEL_FUNCTION_BY_KEY, PANEL_FUNCTION_BY_PATH, PANEL_PATHS,
  buildNav, featureEnabled, panelId, searchPanelFunctions, visibleCategories,
} from '../src/panel/nav.js';
import { PANEL_PAGE_REGISTRY, registryKeysFrom } from '../src/panel/registry.js';
import { panelRoutes, panelFunctionRoutes } from '../src/panel/routes.jsx';
import { panelIconFor, panelColorFor, PANEL_ICONS } from '../src/panel/icons.js';
import { homePathFor, inShellFor, landingFor, isPanelPath } from '../src/auth/home.js';

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const GROUPS = ['overview', 'domains', 'dns', 'ssl', 'files', 'email', 'databases', 'ftp', 'cron', 'backups', 'logs', 'php', 'security', 'usage', 'advanced', 'software', 'preferences'];

describe('panel/nav.js is the single source of truth for /panel', () => {
  it('lists the v1 groups of design §1.2 in order with unique keys and paths', () => {
    expect(PANEL_CATEGORIES.map((c) => c.slug)).toEqual(GROUPS);
    expect(PANEL_FUNCTIONS).toHaveLength(64);
    expect(new Set(PANEL_FUNCTIONS.map((f) => f.key)).size).toBe(PANEL_FUNCTIONS.length);
    expect(new Set(PANEL_FUNCTIONS.map((f) => f.path)).size).toBe(PANEL_FUNCTIONS.length);
    for (const f of PANEL_FUNCTIONS) {
      expect(f.key).toMatch(/^panel:[a-z0-9-]+\/[a-z0-9-]+$/);
      expect(f.path.startsWith(`${PANEL_BASE}/`)).toBe(true);
      expect(f.path).toBe(`${PANEL_BASE}/${panelId(f)}`);
      expect(PANEL_FUNCTION_BY_KEY[f.key]).toBe(f);
      expect(PANEL_FUNCTION_BY_PATH[f.path]).toBe(f);
    }
    expect(panelId('panel:overview/dashboard')).toBe('overview/dashboard');
  });

  it('carries every page file of design §6.1', () => {
    const expected = [
      'overview/dashboard', 'overview/account', 'overview/preferences', 'domains/domains', 'domains/addon-domains', 'domains/subdomains', 'domains/parked-domains', 'domains/redirects',
      'dns/zone-editor', 'dns/dynamic-dns', 'dns/track', 'ssl/status', 'ssl/install', 'ssl/certificates', 'files/file-manager', 'files/disk-usage', 'files/directory-privacy', 'files/indexes', 'files/git', 'files/webdisk', 'email/accounts', 'email/forwarders',
      'email/default-address', 'email/autoresponders', 'email/filters', 'email/global-filters', 'email/spam', 'email/deliverability', 'email/routing', 'email/webmail', 'email/usage', 'email/calendars', 'databases/databases', 'databases/users',
      'databases/remote-hosts', 'databases/phpmyadmin', 'databases/wizard', 'ftp/accounts', 'cron/cron-jobs', 'backups/backups', 'backups/restore', 'logs/access-logs', 'logs/bandwidth', 'logs/visitors', 'logs/errors',
      'php/versions', 'php/ini', 'security/password', 'security/two-factor', 'security/ssh-keys', 'security/sessions', 'security/tokens', 'security/ip-blocker', 'security/virus-scanner', 'usage/usage', 'advanced/error-pages', 'advanced/optimize-website', 'advanced/hotlink-protection', 'advanced/terminal', 'software/wordpress', 'software/installers', 'software/plugins', 'software/apps', 'preferences/users',
    ];
    expect(PANEL_FUNCTIONS.map(panelId)).toEqual(expected);
    expect(PANEL_PATHS.password).toBe('/panel/security/password');
    expect(PANEL_PATHS.twoFactor).toBe('/panel/security/two-factor');
  });

  it('buildNav with the defaults reproduces the 212 admin entries byte for byte', () => {
    const defs = CATEGORIES.map((c) => [c.label, c.icon, c.functions.map((f) => [f.label, f.description, f.phase, { slug: f.slug }]), { slug: c.slug }]);
    const rebuilt = buildNav(defs);
    expect(rebuilt).toEqual(CATEGORIES);
    expect(rebuilt.flatMap((c) => c.functions)).toEqual(FUNCTIONS);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(CATEGORIES));
    expect(buildNav(PANEL_CATEGORY_DEFS, { basePath: '/panel', keyPrefix: 'panel' })).toEqual(PANEL_CATEGORIES);
  });

  it('every discovered panel page targets a real panel function key', () => {
    const keys = Object.keys(PANEL_PAGE_REGISTRY);
    expect(keys).toContain('panel:overview/dashboard');
    expect(keys).toContain('panel:overview/account');
    for (const key of keys) expect(PANEL_FUNCTION_BY_KEY[key], `page registered for unknown function "${key}"`).toBeTruthy();
    expect(registryKeysFrom(['../pages/panel/email/forwarders.jsx', '../pages/panel/email/parts/Row.jsx'])).toEqual(['panel:email/forwarders']);
  });

  it('generates one route per function under /panel plus index, change-password and the catch-all', () => {
    expect(panelRoutes).toHaveLength(1);
    expect(panelRoutes[0].path).toBe('/panel');
    expect(panelFunctionRoutes.map((r) => r.path)).toEqual(PANEL_FUNCTIONS.map((f) => f.path.slice('/panel/'.length)));
    const children = panelRoutes[0].children;
    expect(children[0].index).toBe(true);
    expect(children[1].path).toBe('change-password');
    expect(children.at(-1).path).toBe('*');
    // index, change-password, plugins/:pluginId/* and the catch-all
    expect(children).toHaveLength(PANEL_FUNCTIONS.length + 4);
  });

  it('gates functions by plan feature (missing keys mean enabled) and searches label, group and description', () => {
    expect(searchPanelFunctions('mail').some((f) => f.categorySlug === 'email')).toBe(true);
    expect(searchPanelFunctions('cron job').map((f) => f.key)).toEqual(['panel:cron/cron-jobs']);
    expect(searchPanelFunctions('')).toHaveLength(PANEL_FUNCTIONS.length);
    expect(searchPanelFunctions('no-such-tool-xyz')).toHaveLength(0);
    expect(featureEnabled({}, 'cron')).toBe(true);
    expect(featureEnabled(null, 'cron')).toBe(true);
    expect(featureEnabled({ cron: false }, 'cron')).toBe(false);
    expect(featureEnabled({ cron: false }, undefined)).toBe(true);
    const visible = visibleCategories({ cron: false, emailaccts: false });
    expect(visible.map((c) => c.slug)).not.toContain('cron');
    expect(visible.find((c) => c.slug === 'email').functions.map(panelId)).not.toContain('email/accounts');
    expect(visible.find((c) => c.slug === 'email').functions.map(panelId)).toContain('email/forwarders');
    expect(searchPanelFunctions('cron', { cron: false })).toHaveLength(0);
    expect(visibleCategories(undefined)).toHaveLength(GROUPS.length);
    const gates = new Set(PANEL_FUNCTIONS.map((f) => f.feature).filter(Boolean));
    for (const key of ['filemanager', 'emailaccts', 'forwarders', 'autoresponders', 'defaultaddress', 'spamassassin', 'mysql', 'phpmyadmin', 'addondomains', 'subdomains', 'parkeddomains', 'redirects', 'cron', 'ftpaccts', 'sslmanager', 'backup', 'phpversion', 'rawlog', 'passwordchange', 'ssh', 'api']) expect(gates.has(key), key).toBe(true);
  });

  it('has an icon and a tile colour for every group', () => {
    for (const c of PANEL_CATEGORIES) {
      expect(PANEL_ICONS[c.icon], `icon ${c.icon} for ${c.slug}`).toBeTruthy();
      expect(panelIconFor(c.icon)).toBe(PANEL_ICONS[c.icon]);
      expect(panelColorFor(c.slug)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(panelIconFor('Nope')).toBeTruthy();
  });

  it('has an en.json label, description and group name for every function (appended panel.* block)', () => {
    for (const c of PANEL_CATEGORIES) expect(en[`panel-category.${c.slug}`]).toBe(c.label);
    for (const f of PANEL_FUNCTIONS) {
      expect(en[`panel.${panelId(f)}.label`]).toBe(f.label);
      expect(en[`panel.${panelId(f)}.description`]).toBe(f.description);
    }
    for (const key of ['panel.shell.acting_as', 'panel.shell.acting_exit', 'panel.shell.sign_out', 'panel.common.home', 'panel.shell.disabled_title']) expect(typeof en[key]).toBe('string');
    const raw = readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8');
    const occurrences = raw.match(/^\s*"[^"]+":/gm).map((l) => l.trim());
    expect(new Set(occurrences).size).toBe(occurrences.length);
  });
});

describe('auth/home.js resolves the shell per role', () => {
  it('homePathFor', () => {
    expect(homePathFor({ role: 'user' })).toBe('/panel');
    expect(homePathFor({ role: 'root' })).toBe('/');
    expect(homePathFor({ role: 'reseller' })).toBe('/');
    expect(homePathFor(null)).toBe('/');
  });

  it('inShellFor confines role user to /panel and lets admins keep any in-app location', () => {
    const user = { role: 'user' };
    expect(inShellFor(user, '/panel')).toBe(true);
    expect(inShellFor(user, '/panel/email/accounts')).toBe(true);
    expect(inShellFor(user, '/panelx')).toBe(false);
    expect(inShellFor(user, '/')).toBe(false);
    expect(inShellFor(user, '/account-information/list-accounts')).toBe(false);
    expect(inShellFor({ role: 'root' }, '/account-information/list-accounts')).toBe(true);
    expect(inShellFor({ role: 'root' }, '/panel')).toBe(true);
    expect(inShellFor({ role: 'root' }, '/login')).toBe(false);
    expect(inShellFor({ role: 'root' }, 'https://evil.example/')).toBe(false);
    expect(inShellFor({ role: 'root' }, '')).toBe(false);
    expect(isPanelPath('/panel/')).toBe(true);
    expect(isPanelPath('/panels')).toBe(false);
  });

  it('landingFor keeps a remembered location only inside the right shell', () => {
    expect(landingFor({ role: 'user' }, '/panel/email/accounts')).toBe('/panel/email/accounts');
    expect(landingFor({ role: 'user' }, '/account-information/list-accounts')).toBe('/panel');
    expect(landingFor({ role: 'root' }, '/packages/add-a-package')).toBe('/packages/add-a-package');
    expect(landingFor({ role: 'root' }, undefined)).toBe('/');
    expect(landingFor({ role: 'user' }, null)).toBe('/panel');
  });

  it('the panel shell sends every role to /panel and keeps only panel locations', () => {
    expect(homePathFor({ role: 'root' }, 'panel')).toBe('/panel');
    expect(homePathFor(null, 'panel')).toBe('/panel');
    expect(inShellFor({ role: 'root' }, '/account-information/list-accounts', 'panel')).toBe(false);
    expect(inShellFor({ role: 'root' }, '/panel/domains', 'panel')).toBe(true);
    expect(landingFor({ role: 'reseller' }, '/packages/add-a-package', 'panel')).toBe('/panel');
    expect(landingFor({ role: 'root' }, '/packages/add-a-package', 'admin')).toBe('/packages/add-a-package');
  });
});
