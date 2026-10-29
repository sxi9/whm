import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, FUNCTIONS, FUNCTION_BY_KEY, FUNCTION_BY_PATH } from '../src/nav.js';
import { BRAND } from '../src/brand.js';

const RENAMED_KEYS = [
  'server-configuration/configure-cpanel-analytics',
  'server-configuration/configure-cpanel-cron-jobs',
  'support/grant-cpanel-support-access',
  'service-configuration/cpanel-log-rotation-configuration',
  'service-configuration/cpanel-web-disk-configuration',
  'service-configuration/cpanel-web-services-configuration',
  'transfers/transfer-or-restore-a-cpanel-account',
  'cpanel/modify-cpanel-and-whm-news',
  'development/openapi-documentation-for-cpanel',
  'development/cpanel-development-forum',
  'development/cpanel-plugin-file-generator',
];

describe('product branding', () => {
  it('names the product, the company and the admin side', () => {
    expect(BRAND).toEqual({ product: 'HST Panel', company: 'Hostingsignal', admin: 'WHM', legacyName: 'cPanel' });
    expect(Object.isFrozen(BRAND)).toBe(true);
  });

  it('no category or function label names the legacy product', () => {
    for (const c of CATEGORIES) expect(c.label, c.slug).not.toContain(BRAND.legacyName);
    for (const f of FUNCTIONS) expect(f.label, f.key).not.toContain(BRAND.legacyName);
    expect(FUNCTIONS.filter((f) => f.label.includes(BRAND.product)).length).toBeGreaterThanOrEqual(10);
  });

  it('keeps the cpanel category slug and every renamed key, path and page unchanged', () => {
    const cat = CATEGORIES.find((c) => c.slug === 'cpanel');
    expect(cat.label).toBe(BRAND.product);
    expect(cat.functions).toHaveLength(6);
    for (const f of cat.functions) expect(f.key.startsWith('cpanel/'), f.key).toBe(true);
    for (const key of RENAMED_KEYS) {
      expect(FUNCTION_BY_KEY[key], key).toBeTruthy();
      expect(FUNCTION_BY_PATH[`/${key}`], key).toBe(FUNCTION_BY_KEY[key]);
      expect(FUNCTION_BY_KEY[key].label).toContain(BRAND.product);
    }
  });

  it('every page file under pages/fn still maps to a function key', () => {
    const root = fileURLToPath(new URL('../src/pages/fn/', import.meta.url));
    let count = 0;
    for (const category of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const file of readdirSync(`${root}${category.name}`).filter((f) => f.endsWith('.jsx'))) {
        const key = `${category.name}/${file.replace(/\.jsx$/, '')}`;
        expect(FUNCTION_BY_KEY[key], `page file for unknown function "${key}"`).toBeTruthy();
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(100);
  });
});
