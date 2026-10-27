import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

// No DOM library is available in this checkout (@testing-library/jsdom are
// not installed), so pages are rendered with react-dom/server against mocked
// data hooks, the same way the panel's client tests work.
React.useLayoutEffect = React.useEffect;

export function render(element, { url = '/', route = null } = {}) {
  const tree = route ? <Routes><Route path={route} element={element} /></Routes> : element;
  return renderToStaticMarkup(
    <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={[url]}>{tree}</MemoryRouter></ConfirmProvider></ToastProvider>,
  );
}

// Minimal mock api: records calls and answers from a scripted map.
export function mockApi(answers = {}) {
  const calls = [];
  const answer = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const hit = answers[key] ?? answers[path];
    if (typeof hit === 'function') return hit({ method, path, body });
    if (hit instanceof Error) throw hit;
    return hit ?? { data: {} };
  };
  return {
    calls,
    get: (p) => Promise.resolve().then(() => answer('GET', p)),
    post: (p, b = {}) => Promise.resolve().then(() => answer('POST', p, b)),
    put: (p, b = {}) => Promise.resolve().then(() => answer('PUT', p, b)),
    patch: (p, b = {}) => Promise.resolve().then(() => answer('PATCH', p, b)),
    delete: (p) => Promise.resolve().then(() => answer('DELETE', p)),
    postRaw: (p, b, ct, h) => Promise.resolve().then(() => answer('POST', p, { raw: true, contentType: ct, headers: h, bytes: b?.byteLength ?? b?.length })),
  };
}

export const SESSIONS = {
  vendor: { kind: 'portal', user: { id: 'usr_vendor', email: 'root@vendor.test', role: 'vendor_admin', reseller_id: null, totp_enabled: true }, totpEnabled: true, totpVerifiedAt: Date.now() },
  support: { kind: 'portal', user: { id: 'usr_sup', email: 'sup@vendor.test', role: 'vendor_support', reseller_id: null, totp_enabled: false }, totpEnabled: false, totpVerifiedAt: null },
  reseller: { kind: 'portal', user: { id: 'usr_rs', email: 'rs@acme.test', role: 'reseller_admin', reseller_id: 'rs_acme01', totp_enabled: true }, totpEnabled: true, totpVerifiedAt: null },
  developer: { kind: 'developer', developer: { id: 'dev_01ABC', email: 'dev@acme.test', status: 'verified', totp_enabled: true, display_name: 'Acme' }, scopes: ['*'], totpEnabled: true, totpVerifiedAt: null },
};
