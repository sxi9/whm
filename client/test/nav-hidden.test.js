import { describe, it, expect } from 'vitest';
import { CATEGORIES } from '../src/nav.js';
import { mergeCategories } from '../src/hooks/usePluginNav.js';

describe('Server Profile hidden categories', () => {
  it('drops hidden categories and keeps plugin entries on the visible ones', () => {
    const entry = { key: 'plugin:net.example.hello:/', label: 'Hello', categorySlug: 'plugins', path: '/plugins/net.example.hello' };
    const merged = mergeCategories(CATEGORIES, [entry], ['email', 'dns-functions']);
    expect(merged.map((c) => c.slug)).not.toContain('email');
    expect(merged.map((c) => c.slug)).not.toContain('dns-functions');
    expect(merged).toHaveLength(CATEGORIES.length - 2);
    expect(merged.find((c) => c.slug === 'plugins').functions.at(-1)).toBe(entry);
  });

  it('is the plain category list when nothing is hidden and no plugin is enabled', () => {
    expect(mergeCategories(CATEGORIES, [], [])).toBe(CATEGORIES);
  });
});
