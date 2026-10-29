import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';

// Pages read through useApi; the mock answers by path prefix.
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => path.startsWith(k));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { PresetPicker, PresetForm, PresetInstructions, redirectUriFor, issuerPreview } = await import('../src/pages/security/ExternalAuthPresets.jsx');
const Page = (await import('../src/pages/fn/security-center/manage-external-authentications.jsx')).default;
const { ProviderForm } = await import('../src/pages/fn/security-center/manage-external-authentications.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el) => renderToStaticMarkup(<ToastProvider><ConfirmProvider><MemoryRouter>{el}</MemoryRouter></ConfirmProvider></ToastProvider>);

const presets = [
  { id: 'google', label: 'Google', vendor: 'Google', supported: true, generic: false, issuerTemplate: 'https://accounts.google.com', fields: [], scopes: 'openid email profile', secret: { required: true, label: 'Client secret', help: 'From the OAuth client in Google Cloud Console.' }, foreignHosts: ['oauth2.googleapis.com'], pinnedEndpoints: [], docsUrl: 'https://developers.google.com/identity/openid-connect/openid-connect', instructions: ['Create an OAuth client ID of type "Web application".', 'Add the redirect URI shown below.'], limitations: null },
  { id: 'microsoft', label: 'Microsoft Entra ID', vendor: 'Microsoft', supported: true, generic: false, issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0', fields: [{ key: 'tenant', label: 'Directory (tenant) ID', kind: 'segment', help: 'The tenant GUID from the Entra admin center Overview.', placeholder: '00000000-0000-0000-0000-000000000000', default: '' }], scopes: 'openid email profile', secret: { required: true, label: 'Client secret', help: 'The secret value from Certificates & secrets.' }, foreignHosts: ['graph.microsoft.com'], pinnedEndpoints: [], docsUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc', instructions: ['Register a single-tenant app.'], limitations: 'One tenant per provider.' },
  { id: 'apple', label: 'Apple', vendor: 'Apple', supported: true, generic: false, issuerTemplate: 'https://appleid.apple.com', fields: [], scopes: '', secret: { required: true, label: 'Client secret (JWT)', help: 'Paste a client-secret JWT generated with your Sign in with Apple key.' }, foreignHosts: [], pinnedEndpoints: [], docsUrl: 'https://developer.apple.com/documentation/signinwithapplerestapi', instructions: ['Register a Services ID.'], limitations: 'Apple provides a stable subject only, no email.' },
  { id: 'facebook', label: 'Meta (Facebook Login)', vendor: 'Meta', supported: true, generic: false, issuerTemplate: 'https://www.facebook.com', fields: [], scopes: 'openid email', secret: { required: true, label: 'App secret', help: 'Settings › Basic.' }, foreignHosts: ['graph.facebook.com'], pinnedEndpoints: [{ name: 'token_endpoint', url: 'https://graph.facebook.com/oauth/access_token' }], docsUrl: 'https://developers.facebook.com/docs/facebook-login', instructions: ['Add the Facebook Login product.'], limitations: null },
  { id: 'cloudflare-access', label: 'Cloudflare Access', vendor: 'Cloudflare', supported: true, generic: false, issuerTemplate: 'https://{team}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/{clientId}', fields: [{ key: 'team', label: 'Team name', kind: 'label', help: 'The <team> in https://<team>.cloudflareaccess.com', placeholder: 'mycompany', default: '' }], scopes: 'openid email profile', secret: { required: true, label: 'Client secret', help: null }, foreignHosts: [], pinnedEndpoints: [], docsUrl: 'https://developers.cloudflare.com/cloudflare-one/', instructions: ['Add a SaaS application with OIDC.'], limitations: null },
  { id: 'gitlab', label: 'GitLab', vendor: 'GitLab', supported: true, generic: false, issuerTemplate: 'https://{host}', fields: [{ key: 'host', label: 'GitLab host', kind: 'host', help: 'gitlab.com or your self-managed instance.', placeholder: 'gitlab.com', default: 'gitlab.com' }], scopes: 'openid email profile', secret: { required: true, label: 'Secret', help: null }, foreignHosts: [], pinnedEndpoints: [], docsUrl: 'https://docs.gitlab.com/integration/openid_connect_provider/', instructions: ['Add a confidential application.'], limitations: null },
  { id: 'generic', label: 'Other OpenID Connect provider', vendor: null, supported: true, generic: true, issuerTemplate: '{issuer}', fields: [{ key: 'issuer', label: 'Issuer URL', kind: 'url', help: null, placeholder: 'https://login.example.com', default: '' }], scopes: 'openid email profile', secret: { required: false, label: 'Client secret', help: null }, foreignHosts: [], pinnedEndpoints: [], docsUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html', instructions: [], limitations: null },
  { id: 'github', label: 'GitHub', vendor: 'GitHub', supported: false, reason: 'GitHub is OAuth 2.0 only: it publishes no OpenID Connect discovery document and issues no id_token.', docsUrl: 'https://docs.github.com/apps/oauth-apps' },
];
const presetData = { presets, redirectUriTemplate: 'https://panel.example.com:2087/api/auth/external/{name}/callback', currentRedirectUriTemplate: 'http://localhost:5173/api/auth/external/{name}/callback' };
const byId = (id) => presets.find((p) => p.id === id);
const fn = { key: 'manage-external-authentications', label: 'Manage External Authentications', description: 'External identity providers for login.', category: 'Security Center', categorySlug: 'security-center' };

describe('redirect URI and issuer preview helpers', () => {
  it('fills the provider identifier into the callback template', () => {
    expect(redirectUriFor(presetData.redirectUriTemplate, 'google')).toBe('https://panel.example.com:2087/api/auth/external/google/callback');
    expect(redirectUriFor(presetData.redirectUriTemplate, '')).toBe('https://panel.example.com:2087/api/auth/external/<identifier>/callback');
    expect(redirectUriFor(presetData.redirectUriTemplate, 'a b')).toBe('https://panel.example.com:2087/api/auth/external/a%20b/callback');
    expect(redirectUriFor(null, 'x')).toBe('');
  });
  it('previews issuer templates with readable placeholders', () => {
    expect(issuerPreview(byId('microsoft'))).toBe('https://login.microsoftonline.com/<tenant>/v2.0');
    expect(issuerPreview(byId('cloudflare-access'))).toBe('https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>');
    expect(issuerPreview(byId('generic'))).toBe('Any OpenID Connect issuer');
  });
});

describe('preset picker', () => {
  it('renders one card per preset, the generic card, and GitHub disabled with its reason', () => {
    const html = render(<PresetPicker presets={presets} onPick={() => {}} />);
    for (const label of ['Google', 'Microsoft Entra ID', 'Apple', 'Meta (Facebook Login)', 'Cloudflare Access', 'GitLab', 'Other OpenID Connect provider', 'GitHub']) expect(html).toContain(`<strong>${label}</strong>`);
    expect(html.match(/data-preset="/g)).toHaveLength(presets.length);
    expect(html).toContain('https://login.microsoftonline.com/&lt;tenant&gt;/v2.0');
    expect(html).toContain('Any OpenID Connect issuer');
    expect(html).toMatch(/data-preset="github" disabled=""/);
    expect(html).toContain('Not supported yet');
    expect(html).toContain('GitHub is OAuth 2.0 only');
    expect(html).not.toMatch(/data-preset="google" disabled/);
  });
  it('shows a loading note while the presets are still being fetched', () => {
    expect(render(<PresetPicker presets={[]} loading onPick={() => {}} />)).toContain('Loading presets');
  });
});

describe('preset form', () => {
  it('shows only the preset fields, the redirect URI, the steps and the docs link for Microsoft', () => {
    const html = render(<PresetForm preset={byId('microsoft')} redirectUriTemplate={presetData.redirectUriTemplate} currentRedirectUriTemplate={presetData.currentRedirectUriTemplate} onDone={() => {}} onBack={() => {}} />);
    expect(html).toContain('data-preset-form="microsoft"');
    expect(html).toContain('Directory (tenant) ID');
    expect(html).toContain('placeholder="00000000-0000-0000-0000-000000000000"');
    expect(html).not.toContain('Issuer URL');
    expect(html).toContain('value="https://panel.example.com:2087/api/auth/external/microsoft/callback"');
    expect(html).toContain('http://localhost:5173/api/auth/external/microsoft/callback');
    expect(html).toContain('Register a single-tenant app.');
    expect(html).toContain('href="https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('One tenant per provider.');
    expect(html).toContain('value="Microsoft Entra ID"');
    expect(html).toContain('value="microsoft"');
    expect(html).toContain('value="openid email profile"');
    expect(html).toContain('Add Microsoft Entra ID');
    expect(html).toContain('Other provider');
  });
  it('has no extra fields for Google and names the secret per vendor', () => {
    const google = render(<PresetForm preset={byId('google')} redirectUriTemplate={presetData.redirectUriTemplate} onDone={() => {}} />);
    expect(google).not.toContain('Directory (tenant) ID');
    expect(google).not.toContain('Team name');
    expect(google).toContain('From the OAuth client in Google Cloud Console.');
    expect(google).not.toContain('You are using the panel at a different address');
    const apple = render(<PresetForm preset={byId('apple')} redirectUriTemplate={presetData.redirectUriTemplate} onDone={() => {}} />);
    expect(apple).toContain('Client secret (JWT)');
    expect(apple).toContain('None for this provider');
    expect(apple).toContain('Apple provides a stable subject only, no email.');
    const gitlab = render(<PresetForm preset={byId('gitlab')} redirectUriTemplate={presetData.redirectUriTemplate} onDone={() => {}} />);
    expect(gitlab).toContain('value="gitlab.com"');
    const meta = render(<PresetInstructions preset={byId('facebook')} redirectUri="https://panel.example.com:2087/api/auth/external/meta/callback" />);
    expect(meta).toContain('Pinned by the panel');
    expect(meta).toContain('https://graph.facebook.com/oauth/access_token');
  });
  it('keeps the full form for a generic issuer, now with the redirect URI to copy', () => {
    const html = render(<ProviderForm initial={null} redirectUriTemplate={presetData.redirectUriTemplate} onDone={() => {}} />);
    expect(html).toContain('Issuer URL');
    expect(html).toContain('https://panel.example.com:2087/api/auth/external/&lt;identifier&gt;/callback');
  });
});

describe('Manage External Authentications page', () => {
  it('lists providers with their preset label and offers the Add provider action', () => {
    responses.clear();
    responses.set('/security/external-auth/presets', { data: presetData });
    responses.set('/security/external-auth', { data: [
      { id: 1, name: 'google', displayName: 'Google', issuerUrl: 'https://accounts.google.com', clientId: 'gid', hasClientSecret: true, scopes: 'openid email profile', enabled: true, preset: 'google', discovery: { issuer: 'https://accounts.google.com', fetchedAt: '2026-10-29T10:00:00Z', preset: 'google' }, links: 2 },
      { id: 2, name: 'corp', displayName: 'Corp SSO', issuerUrl: 'https://login.example.com', clientId: 'c', hasClientSecret: true, scopes: 'openid', enabled: false, preset: null, discovery: null, links: 0 },
    ] });
    responses.set('/system/settings', { data: { 'security.external_auth.enabled': true, 'security.external_auth.auto_link_by_email': false } });
    const html = render(<Page fn={fn} />);
    expect(html).toContain('Add provider');
    expect(html).toContain('<code>google</code> · Google');
    expect(html).toContain('<code>corp</code></small>');
    expect(html).toContain('not run');
    expect(html).toContain('Allow external authentication on the login page');
  });
});
