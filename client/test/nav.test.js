import { describe, it, expect } from 'vitest';
import { CATEGORIES, FUNCTIONS, FUNCTION_BY_KEY, RESTART_SERVICE_MAP, searchFunctions, slugify } from '../src/nav.js';
import { PAGE_REGISTRY } from '../src/pages/registry.js';

describe('nav.js is the single source of truth', () => {
  it('lists 31 categories and 216 functions with unique keys and paths', () => {
    expect(CATEGORIES).toHaveLength(31);
    expect(FUNCTIONS).toHaveLength(216);
    expect(new Set(FUNCTIONS.map((f) => f.key)).size).toBe(216);
    expect(new Set(FUNCTIONS.map((f) => f.path)).size).toBe(216);
    for (const f of FUNCTIONS) expect(f.path).toBe(`/${f.key}`);
  });

  it('slugifies labels the way page file names expect', () => {
    expect(slugify("Manage root's SSH Keys")).toBe('manage-roots-ssh-keys');
    expect(slugify('Upgrade/Downgrade an Account')).toBe('upgrade-downgrade-an-account');
    expect(slugify('Modify cPanel & WHM News')).toBe('modify-cpanel-and-whm-news');
    expect(slugify('HTTP Server (Apache)')).toBe('http-server-apache');
  });

  it('every registered page (legacy map and pages/fn/**) targets a real function key', () => {
    const keys = Object.keys(PAGE_REGISTRY);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(FUNCTION_BY_KEY[key], `page registered for unknown function "${key}"`).toBeTruthy();
  });

  it('keeps renamed labels on their original slugs through the explicit slug element', () => {
    expect(FUNCTION_BY_KEY['cpanel/modify-cpanel-and-whm-news'].label).toBe('Modify HST Panel & WHM News');
    expect(FUNCTION_BY_KEY['server-configuration/configure-cpanel-cron-jobs'].path).toBe('/server-configuration/configure-cpanel-cron-jobs');
    for (const f of FUNCTIONS) if (slugify(f.label) !== f.slug) expect(f.slug, f.label).toContain('cpanel');
  });

  it('maps every Restart Services entry to a service registry name', () => {
    const restart = CATEGORIES.find((c) => c.slug === 'restart-services');
    for (const fn of restart.functions) expect(RESTART_SERVICE_MAP[fn.slug], fn.label).toBeTruthy();
  });

  it('searches across label, category and description', () => {
    expect(searchFunctions('restart apache').map((f) => f.key)).toContain('restart-services/http-server-apache');
    expect(searchFunctions('zone').some((f) => f.categorySlug === 'dns-functions')).toBe(true);
    expect(searchFunctions('')).toHaveLength(216);
    expect(searchFunctions('no-such-function-xyz')).toHaveLength(0);
  });
});
