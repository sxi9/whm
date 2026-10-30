import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Static rendering never runs effects: useApi answers from a path-keyed table.
const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => { const data = apiData[path]; return { data: data ?? null, meta: null, error: null, loading: data === undefined, refetch: () => {}, setData: () => {} }; },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { PackageForm, EMPTY_PACKAGE, packageToForm, formToBody, themeOptions } = await import('../src/pages/packages/PackageForm.jsx');

// Rows as GET /themes returns them (migration 026 seeds these three; `retro` is a disabled copy).
const THEMES = [
  { slug: 'jupiter', name: 'Jupiter', enabled: true },
  { slug: 'jupiter-dark', name: 'Jupiter Dark', enabled: true },
  { slug: 'high-contrast', name: 'High Contrast', enabled: true },
  { slug: 'retro', name: 'Retro', enabled: false },
];
const options = (html) => [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
const themeSelect = (html) => html.split('theme</label>')[1].split('</select>')[0];

describe('PackageForm theme choices', () => {
  it('lists the enabled themes from the Themes API instead of a hard-coded pair', () => {
    apiData['/themes'] = THEMES;
    apiData['/packages/feature-lists'] = [{ name: 'default' }];
    const html = renderToStaticMarkup(<PackageForm form={EMPTY_PACKAGE} setForm={() => {}} error={null} />);
    expect(options(themeSelect(html))).toEqual([['jupiter', 'Jupiter'], ['jupiter-dark', 'Jupiter Dark'], ['high-contrast', 'High Contrast']]);
    expect(html).not.toContain('paper_lantern');
    expect(html).not.toContain('value="retro"');
  });

  it('keeps a package\'s theme selectable once it is no longer enabled', () => {
    apiData['/themes'] = THEMES;
    const form = packageToForm({ name: 'gold', theme: 'retro' });
    const html = renderToStaticMarkup(<PackageForm form={form} setForm={() => {}} error={null} />);
    expect(options(themeSelect(html))).toContainEqual(['retro', 'retro (not enabled)']);
    expect(themeSelect(html)).toContain('<option value="retro" selected=""');
  });

  it('shows the stored theme while the list is still loading', () => {
    delete apiData['/themes'];
    expect(themeOptions(null, 'jupiter-dark')).toEqual([{ value: 'jupiter-dark', label: 'jupiter-dark' }]);
    expect(themeOptions(THEMES, 'jupiter-dark').map((o) => o.value)).toEqual(['jupiter', 'jupiter-dark', 'high-contrast']);
  });
});

describe('formToBody and the theme field', () => {
  it('sends the theme when adding a package', () => {
    expect(formToBody({ ...EMPTY_PACKAGE, name: 'gold', theme: 'high-contrast' }).theme).toBe('high-contrast');
  });

  it('leaves an unchanged theme out of an edit so a disabled theme does not block other changes', () => {
    const current = { name: 'gold', theme: 'retro', disk_mb: 100 };
    const form = { ...packageToForm(current), disk_mb: 200 };
    const body = formToBody(form, { rename: true, original: 'gold', current });
    expect(body).not.toHaveProperty('theme');
    expect(body).not.toHaveProperty('name');
    expect(body.disk_mb).toBe(200);
  });

  it('still sends a theme the operator changed on edit', () => {
    const current = { name: 'gold', theme: 'retro' };
    const body = formToBody({ ...packageToForm(current), theme: 'jupiter-dark' }, { rename: true, original: 'gold', current });
    expect(body.theme).toBe('jupiter-dark');
  });
});
