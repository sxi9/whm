import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const auth = { user: { id: 1, username: 'root', role: 'root', profile: {} }, ready: true };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

// Static rendering never runs effects, so useApi answers from a canned table.
const apiData = {};
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path) => ({ data: apiData[path] ?? null, meta: null, error: null, loading: !apiData[path], refetch: () => {}, setData: () => {} }),
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset: () => {} }),
}));

const { default: TweakSettings, UPDATE_TIER_OPTIONS } = await import('../src/pages/server-configuration/TweakSettings.jsx');
const { ConfigField } = await import('../src/components/ConfigPage.jsx');
const { UPDATE_TIERS } = await import('../../server/src/services/server-configuration.js');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);
const fn = Object.values(FUNCTION_BY_KEY).find((f) => f.slug === 'tweak-settings');

describe('Tweak Settings › Update tier', () => {
  it('offers every tier the server accepts and Update Preferences stores (including "current")', () => {
    expect(UPDATE_TIER_OPTIONS.map((o) => o.value)).toEqual(UPDATE_TIERS);
    apiData['/system/settings?prefix='] = { 'updates.tier': 'current', 'updates.auto': true };
    const html = render(<TweakSettings fn={fn} />);
    for (const tier of UPDATE_TIERS) expect(html).toContain(`<option value="${tier}"`);
    expect(html).toContain('>Current</option>');
  });

  it('renders a stored "current" tier as the selected option instead of a blank select', () => {
    const field = { key: 'updates.tier', label: 'Update tier', type: 'select', options: UPDATE_TIER_OPTIONS };
    const html = renderToStaticMarkup(<ConfigField field={field} value="current" onChange={() => {}} />);
    expect(html).toMatch(/<option value="current" selected="">Current<\/option>/);
    expect(html).not.toMatch(/<option value="stable" selected=""/);
  });
});
