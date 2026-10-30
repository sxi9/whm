import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/plugin-sdk.js';
import net from 'node:net';
import dns from 'node:dns/promises';
import nodeCrypto from 'node:crypto';
import { json, paginate } from '../db/index.js';
import { notFound, conflict, badRequest, unprocessable, CapabilityError } from '../lib/errors.js';

// Security Center. Attached as ctx.security; other categories may call:
//   security.policy()                         -> current login/session policy settings
//   security.passwordStrength(pw, context)    -> { score, minimum, ok }
//   security.cphulk.shouldBlock(ip)           -> CIDR-aware: active blocks + denylist, minus allowlist
//   security.cphulk.isAllowlisted(ip)         -> exact or CIDR match on the allowlist
//   security.cphulk.block(ip, opts) / unblock(id)
//   security.firewall.block(ip, req, { comment }) / unblock(ip) / list()
//        blocks are recorded in firewall_entries and restored at boot / hourly;
//        the hourly sync never removes an address it did not add itself
//   security.firewall.reconcile(job)          -> re-apply recorded blocks + SMTP restriction
//   security.reloadApache(req)                -> uses ctx.web.reload when that category exists
//   security.modsec.detect() / security.ssh.config() / security.externalAuth.*
//   security.phpAdvisories.forVersion({ id, version }) -> [{ id, severity, grade, title, url, fixedIn }]
//        (setting security.advisories; Software badges MultiPHP versions with it)
//   security.externalAuth.exchangeCode(name, { code, redirectUri, nonce })
//        -> verified id_token claims (signature via jwks_uri or client secret,
//           iss/aud/azp/exp/iat/nonce checked) merged with userinfo
// The auth layer (services/auth.js, middleware/auth.js, routes/auth.js) consumes
// security.policy(), security.cphulk.shouldBlock()/isAllowlisted() and externalAuth.*.
// Follow-up still owned there: the security.questions.* settings, which are stored,
// not enforced, until it reads them.

const KNOWN_SERVICES = ['ALL', 'sshd', 'vsftpd', 'proftpd', 'pure-ftpd', 'exim', 'dovecot', 'imap', 'pop3', 'named', 'mysqld', 'whm-panel', 'ftpd', 'telnetd'];
const PASSWORD_CONTEXTS = ['account', 'email', 'ftp', 'mysql', 'panel', 'ssh'];
const stripSlash = (u) => String(u || '').replace(/\/+$/, '');

// JWS algorithms accepted for id_tokens: [digest, key kind].
const JWS_ALGS = {
  RS256: ['sha256', 'rsa'], RS384: ['sha384', 'rsa'], RS512: ['sha512', 'rsa'],
  PS256: ['sha256', 'pss'], PS384: ['sha384', 'pss'], PS512: ['sha512', 'pss'],
  ES256: ['sha256', 'ec'], ES384: ['sha384', 'ec'], ES512: ['sha512', 'ec'],
  HS256: ['sha256', 'hmac'], HS384: ['sha384', 'hmac'], HS512: ['sha512', 'hmac'],
};

function decodeJwtPart(part) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

// OpenID Connect Core 3.1.3.7: the id_token must be signature-checked and its
// iss/aud/azp/exp/iat/nonce claims validated before anything trusts `sub`.
export function verifyIdToken(idToken, { issuer, clientId, nonce = null, jwks = [], clientSecret = null, now = Date.now(), skewSeconds = 60 }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('id_token is not a compact JWS');
  const [h, p, s] = parts;
  const header = decodeJwtPart(h);
  const claims = decodeJwtPart(p);
  if (!header || !claims || typeof claims !== 'object') throw new Error('id_token header or payload is not valid JSON');
  const alg = JWS_ALGS[header.alg];
  if (!alg) throw new Error(`id_token uses unsupported alg "${header.alg}"`);
  const signed = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  let ok = false;
  if (alg[1] === 'hmac') {
    if (!clientSecret) throw new Error('id_token is HMAC-signed but the provider has no client secret');
    const expected = nodeCrypto.createHmac(alg[0], clientSecret).update(signed).digest();
    ok = expected.length === sig.length && nodeCrypto.timingSafeEqual(expected, sig);
  } else {
    const kty = alg[1] === 'ec' ? 'EC' : 'RSA';
    const candidates = jwks.filter((k) => k && k.kty === kty && (!header.kid || !k.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
    for (const jwk of candidates) {
      let key;
      try { key = nodeCrypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { continue; }
      const keyObject = alg[1] === 'pss' ? { key, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST } : alg[1] === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key;
      try { if (nodeCrypto.verify(alg[0], signed, keyObject, sig)) { ok = true; break; } } catch { /* key/alg mismatch */ }
    }
  }
  if (!ok) throw new Error('id_token signature could not be verified with the provider keys');
  if (stripSlash(claims.iss) !== stripSlash(issuer)) throw new Error(`id_token issuer "${claims.iss}" does not match the provider issuer ${issuer}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('id_token audience does not include this client');
  if (aud.length > 1 && claims.azp !== clientId) throw new Error('id_token lists several audiences and azp is not this client');
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + skewSeconds < nowSec) throw new Error('id_token has expired');
  if (typeof claims.iat !== 'number' || claims.iat - skewSeconds > nowSec) throw new Error('id_token was issued in the future');
  if ((nonce != null || claims.nonce != null) && claims.nonce !== nonce) throw new Error('id_token nonce does not match this login attempt');
  if (!claims.sub || typeof claims.sub !== 'string') throw new Error('id_token has no subject');
  return claims;
}

// Discovery metadata must be served over TLS and, unless the operator opts in,
// stay on the issuer's host: the token endpoint receives the client secret.
// `allowedForeignHosts` are hosts a vendor preset documents; they need no
// per-discovery approval but are still reported in foreignEndpoints.
export function checkDiscoveryDocument(doc, issuerUrl, { allowForeignEndpoints = false, allowedForeignHosts = [] } = {}) {
  if (!doc || typeof doc !== 'object') throw badRequest('The discovery document is not a JSON object');
  if (doc.issuer && stripSlash(doc.issuer) !== stripSlash(issuerUrl)) throw badRequest(`The discovery document declares issuer "${doc.issuer}", which does not match the configured issuer ${issuerUrl}`);
  const issuerHost = new URL(issuerUrl).host;
  const endpoints = { authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, userinfoEndpoint: doc.userinfo_endpoint, jwksUri: doc.jwks_uri };
  if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) throw badRequest('The discovery document lacks authorization_endpoint or token_endpoint');
  const foreign = [];
  const unexpected = [];
  for (const [name, value] of Object.entries(endpoints)) {
    if (value == null) continue;
    let u;
    try { u = new URL(String(value)); } catch { throw badRequest(`${name} in the discovery document is not a valid URL`); }
    if (u.protocol !== 'https:') throw badRequest(`${name} must use https:// (the provider published ${value})`);
    if (u.host === issuerHost) continue;
    foreign.push(`${name} on ${u.host}`);
    if (!allowedForeignHosts.includes(u.host)) unexpected.push(`${name} on ${u.host}`);
  }
  if (unexpected.length && !allowForeignEndpoints) throw badRequest(`The discovery document points at hosts other than ${issuerHost}: ${unexpected.join(', ')}. Re-run discovery allowing endpoints on other hosts if that is expected for this provider.`, { allowForeignEndpoints: ['Endpoints on other hosts need explicit approval'] });
  const authMethods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported.filter((m) => typeof m === 'string').slice(0, 10) : [];
  return { ...endpoints, issuer: doc.issuer || issuerUrl, scopesSupported: doc.scopes_supported || [], tokenEndpointAuthMethods: authMethods, foreignEndpoints: foreign, fetchedAt: new Date().toISOString() };
}

// Vendor presets for Manage External Authentications. The issuer is
// `issuerTemplate` with the preset's `fields` (and {clientId}) substituted;
// `foreignHosts` are the endpoint hosts the vendor documents outside the issuer
// host; `endpoints` pin what a vendor's discovery document omits;
// `issuerFromDiscovery` adopts the issuer the vendor declares when it matches
// that pattern (Microsoft answers a tenant domain with the tenant-GUID issuer).
// Discovery still runs through checkDiscoveryDocument and every id_token
// through verifyIdToken; a preset only fills in what the vendor documents.
const PRESET_VALUE_RULES = {
  label: { re: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, message: 'Letters, digits and "-" only' },
  host: { re: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/i, message: 'A hostname such as gitlab.example.com' },
  segment: { re: /^[a-z0-9][a-z0-9._-]{0,127}$/i, message: 'Letters, digits, ".", "_" or "-" only' },
};
const REDIRECT_PATH = '/api/auth/external/{name}/callback';
const SECRET_OPTIONAL = { required: false, label: 'Client secret', help: 'Leave empty only for a public client; confidential clients (recommended) have one.' };
const ISSUER_FIELD = (help, placeholder) => ({ key: 'issuer', label: 'Issuer URL', kind: 'url', help, placeholder });

export const EXTERNAL_AUTH_PRESETS = [
  {
    id: 'google', label: 'Google', vendor: 'Google', issuerTemplate: 'https://accounts.google.com', fields: [], scopes: 'openid email profile',
    secret: { required: true, label: 'Client secret', help: 'From the OAuth client in Google Cloud Console.' },
    foreignHosts: ['oauth2.googleapis.com', 'openidconnect.googleapis.com', 'www.googleapis.com'],
    docsUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
    instructions: [
      'In Google Cloud Console open APIs & Services › Credentials and create an OAuth client ID of type "Web application" (set up the OAuth consent screen first if asked).',
      'Add the redirect URI shown below under "Authorised redirect URIs".',
      'Paste the client ID and client secret here.',
    ],
    limitations: null,
  },
  {
    id: 'microsoft', label: 'Microsoft Entra ID', vendor: 'Microsoft', issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0', scopes: 'openid email profile',
    fields: [{
      key: 'tenant', label: 'Directory (tenant) ID', kind: 'segment', placeholder: '00000000-0000-0000-0000-000000000000',
      help: 'The tenant GUID from the Entra admin center Overview; a verified tenant domain such as contoso.onmicrosoft.com also works. The multi-tenant aliases common, organizations and consumers are not supported.',
      reject: { values: ['common', 'organizations', 'consumers'], message: 'Microsoft publishes the issuer of the common, organizations and consumers endpoints as https://login.microsoftonline.com/{tenantid}/v2.0 and signs each tenant\'s tokens under its own issuer, so the panel cannot pin one. Enter the Directory (tenant) ID instead.' },
    }],
    secret: { required: true, label: 'Client secret', help: 'The secret value (not the secret ID) from Certificates & secrets.' },
    issuerFromDiscovery: '^https://login\\.microsoftonline\\.com/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/v2\\.0$',
    foreignHosts: ['graph.microsoft.com'],
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc',
    instructions: [
      'In the Microsoft Entra admin center open Identity › Applications › App registrations › New registration and choose the single-tenant account type.',
      'Under Authentication add a Web platform with the redirect URI shown below.',
      'Under Certificates & secrets create a client secret; paste its value here with the Application (client) ID and the Directory (tenant) ID from Overview.',
    ],
    limitations: 'One tenant per provider: members and guests of that tenant can sign in, users of other tenants cannot. The common, organizations and consumers endpoints cannot be pinned to one issuer and are refused.',
  },
  {
    id: 'apple', label: 'Apple', vendor: 'Apple', issuerTemplate: 'https://appleid.apple.com', fields: [], scopes: '',
    secret: { required: true, label: 'Client secret (JWT)', help: 'Apple issues no static secret: paste a client-secret JWT generated with your Sign in with Apple key (ES256; iss = Team ID, sub = Services ID, aud = https://appleid.apple.com; valid at most 6 months). Renew it here before it expires.' },
    foreignHosts: [],
    docsUrl: 'https://developer.apple.com/documentation/signinwithapplerestapi',
    instructions: [
      'In Apple Developer › Certificates, Identifiers & Profiles register an App ID with the Sign in with Apple capability, then a Services ID (its identifier is the client ID) with Sign in with Apple enabled.',
      'Configure the Services ID with the panel hostname as a domain and the redirect URI shown below as a return URL. If Apple rejects the port, serve the panel on the standard HTTPS port behind a reverse proxy.',
      'Create a Sign in with Apple key under Keys, generate the client-secret JWT with it and paste the JWT as the client secret.',
    ],
    limitations: 'Apple answers with a POSTed form (response_mode=form_post) whenever scopes are requested, which the panel\'s callback does not accept, so this preset requests no scopes: Apple provides a stable subject only, no email. Users link their Apple ID while signed in to the panel; automatic linking by email is not possible.',
  },
  {
    id: 'facebook', label: 'Meta (Facebook Login)', vendor: 'Meta', issuerTemplate: 'https://www.facebook.com', fields: [], scopes: 'openid email',
    secret: { required: true, label: 'App secret', help: 'Settings › Basic › App secret in Meta for Developers.' },
    endpoints: { authorization_endpoint: 'https://www.facebook.com/dialog/oauth', token_endpoint: 'https://graph.facebook.com/oauth/access_token', jwks_uri: 'https://www.facebook.com/.well-known/oauth/openid/jwks/', token_endpoint_auth_methods_supported: ['client_secret_post'] },
    foreignHosts: ['graph.facebook.com'],
    docsUrl: 'https://developers.facebook.com/docs/facebook-login/guides/advanced/oidc-token',
    instructions: [
      'In Meta for Developers create an app, add the Facebook Login product and put the redirect URI shown below into Facebook Login › Settings › Valid OAuth Redirect URIs.',
      'Paste the App ID as the client ID and the App secret (Settings › Basic) as the secret.',
      'While the app is in development mode only its roles (admins, developers, testers) can sign in; the email permission needs App Review for everyone else.',
    ],
    limitations: 'Meta\'s discovery document publishes no token endpoint, so the panel uses the documented Graph API endpoint https://graph.facebook.com/oauth/access_token (secret sent in the request body) and verifies the id_token with Meta\'s published keys.',
  },
  {
    id: 'cloudflare-access', label: 'Cloudflare Access', vendor: 'Cloudflare', issuerTemplate: 'https://{team}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/{clientId}', scopes: 'openid email profile',
    fields: [{ key: 'team', label: 'Team name', kind: 'label', placeholder: 'mycompany', help: 'The <team> in https://<team>.cloudflareaccess.com (Zero Trust › Settings › Custom Pages › Team domain).' }],
    secret: { required: true, label: 'Client secret', help: 'Shown once when the SaaS application is saved.' },
    foreignHosts: [],
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/generic-oidc-saas/',
    instructions: [
      'In Zero Trust open Access › Applications › Add an application › SaaS, choose OIDC as the authentication protocol and add the redirect URI shown below as a redirect URL.',
      'Save the application: Cloudflare shows the client ID and client secret. Paste them here with your team name.',
      'Assign an Access policy to the application; only identities it allows can sign in.',
    ],
    limitations: 'Cloudflare publishes the issuer as https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id>, so the client ID is part of the issuer.',
  },
  {
    id: 'gitlab', label: 'GitLab', vendor: 'GitLab', issuerTemplate: 'https://{host}', scopes: 'openid email profile',
    fields: [{ key: 'host', label: 'GitLab host', kind: 'host', default: 'gitlab.com', placeholder: 'gitlab.com', help: 'gitlab.com or your self-managed instance.' }],
    secret: { required: true, label: 'Secret', help: 'The application secret GitLab shows after saving.' },
    foreignHosts: [],
    docsUrl: 'https://docs.gitlab.com/integration/openid_connect_provider/',
    instructions: [
      'In GitLab open User Settings › Applications (or a group\'s or the Admin Area\'s Applications) and add a confidential application with the scopes openid, profile and email.',
      'Set the redirect URI shown below.',
      'Paste the Application ID as the client ID and the Secret as the client secret.',
    ],
    limitations: null,
  },
  {
    id: 'auth0', label: 'Auth0', vendor: 'Okta', issuerTemplate: '{issuer}', scopes: 'openid email profile',
    fields: [ISSUER_FIELD('The application\'s Domain with https:// in front, e.g. https://your-tenant.us.auth0.com', 'https://your-tenant.us.auth0.com')],
    secret: SECRET_OPTIONAL, foreignHosts: [],
    docsUrl: 'https://auth0.com/docs/get-started/applications/application-settings',
    instructions: [
      'In the Auth0 Dashboard open Applications › Create Application and choose Regular Web Application.',
      'Add the redirect URI shown below to Allowed Callback URLs and save.',
      'Copy Domain, Client ID and Client Secret from the application settings.',
    ],
    limitations: null,
  },
  {
    id: 'okta', label: 'Okta', vendor: 'Okta', issuerTemplate: '{issuer}', scopes: 'openid email profile',
    fields: [ISSUER_FIELD('Your Okta org URL, e.g. https://dev-123456.okta.com, or an authorization server such as https://dev-123456.okta.com/oauth2/default', 'https://dev-123456.okta.com')],
    secret: SECRET_OPTIONAL, foreignHosts: [],
    docsUrl: 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/',
    instructions: [
      'In the Admin Console open Applications › Create App Integration › OIDC - OpenID Connect › Web Application.',
      'Set the redirect URI shown below as a Sign-in redirect URI and assign the users or groups allowed to sign in.',
      'Copy the Client ID and Client secret.',
    ],
    limitations: null,
  },
  {
    id: 'keycloak', label: 'Keycloak', vendor: 'Keycloak', issuerTemplate: '{issuer}', scopes: 'openid email profile',
    fields: [ISSUER_FIELD('https://<keycloak-host>/realms/<realm>', 'https://sso.example.com/realms/master')],
    secret: SECRET_OPTIONAL, foreignHosts: [],
    docsUrl: 'https://www.keycloak.org/docs/latest/server_admin/#_oidc_clients',
    instructions: [
      'In the admin console open the realm › Clients › Create client (OpenID Connect) with Client authentication on.',
      'Add the redirect URI shown below under Valid redirect URIs.',
      'Copy the client ID and, from the Credentials tab, the client secret.',
    ],
    limitations: null,
  },
  {
    id: 'generic', label: 'Other OpenID Connect provider', vendor: null, generic: true, issuerTemplate: '{issuer}', scopes: 'openid email profile',
    fields: [ISSUER_FIELD('Discovery reads <issuer>/.well-known/openid-configuration', 'https://login.example.com')],
    secret: SECRET_OPTIONAL, foreignHosts: [], docsUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
    instructions: ['Register the panel as a confidential web client at the provider with the redirect URI shown below.', 'Paste the issuer URL, client ID and client secret here.'],
    limitations: null,
  },
  {
    id: 'github', label: 'GitHub', vendor: 'GitHub', supported: false,
    reason: 'GitHub is OAuth 2.0 only: it publishes no OpenID Connect discovery document and issues no id_token, so the panel cannot verify who signed in. Support needs a separate OAuth 2.0 + user API flow.',
    docsUrl: 'https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps',
  },
];

export function presetById(id) {
  return EXTERNAL_AUTH_PRESETS.find((p) => p.id === id) || null;
}

function checkPresetValue(field, value) {
  if (!value) return `${field.label} is required`;
  if (field.reject?.values?.includes(value.toLowerCase())) return field.reject.message;
  if (field.kind === 'url') {
    let u;
    try { u = new URL(value); } catch { return 'Must be an https:// URL'; }
    if (u.protocol !== 'https:') return 'Must use https://';
    if (u.search || u.hash || u.username || u.password) return 'A plain https:// URL without query, fragment or credentials';
    return null;
  }
  const rule = PRESET_VALUE_RULES[field.kind] || PRESET_VALUE_RULES.segment;
  return rule.re.test(value) ? null : rule.message;
}

// Substitutes the preset fields into the issuer template; every value is
// checked against its field kind so nothing can escape its host label or
// path segment, and the result must still parse as an https URL.
export function resolvePresetIssuer(preset, { fields = {}, clientId = '' } = {}) {
  const errors = {};
  const values = {};
  for (const field of preset.fields || []) {
    const value = String(fields?.[field.key] ?? field.default ?? '').trim();
    const problem = checkPresetValue(field, value);
    if (problem) errors[`fields.${field.key}`] = [problem];
    values[field.key] = field.kind === 'url' ? stripSlash(value) : value;
  }
  if (preset.issuerTemplate.includes('{clientId}')) {
    const id = String(clientId || '').trim();
    if (!PRESET_VALUE_RULES.segment.re.test(id)) errors.clientId = ['The client ID is part of the issuer URL for this provider: letters, digits, ".", "_" or "-" only'];
    values.clientId = id;
  }
  if (Object.keys(errors).length) throw unprocessable('Check the provider fields', errors);
  const issuerUrl = stripSlash(preset.issuerTemplate.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? ''));
  let u;
  try { u = new URL(issuerUrl); } catch { throw unprocessable('The resolved issuer is not a valid URL', { issuerUrl: [issuerUrl] }); }
  if (u.protocol !== 'https:') throw unprocessable('The issuer must use https://', { issuerUrl: [issuerUrl] });
  return { issuerUrl, values };
}

function publicPreset(p) {
  if (p.supported === false) return { id: p.id, label: p.label, vendor: p.vendor, supported: false, reason: p.reason, docsUrl: p.docsUrl || null };
  return {
    id: p.id, label: p.label, vendor: p.vendor, supported: true, generic: Boolean(p.generic), issuerTemplate: p.issuerTemplate,
    fields: (p.fields || []).map(({ key, label, kind, help, placeholder, default: def }) => ({ key, label, kind, help: help || null, placeholder: placeholder || null, default: def ?? '' })),
    scopes: p.scopes, secret: p.secret, foreignHosts: p.foreignHosts || [],
    pinnedEndpoints: p.endpoints ? Object.entries(p.endpoints).filter(([k]) => k.endsWith('_endpoint') || k === 'jwks_uri').map(([k, v]) => ({ name: k, url: v })) : [],
    docsUrl: p.docsUrl, instructions: p.instructions || [], limitations: p.limitations || null,
  };
}

export function passwordStrength(pw) {
  if (!pw) return 0;
  let score = Math.min(40, pw.length * 4);
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 15;
  if (/\d/.test(pw)) score += 15;
  if (/[^A-Za-z0-9]/.test(pw)) score += 20;
  if (/(.)\1{2,}/.test(pw)) score -= 15;
  if (/^(password|123456|qwerty|letmein)/i.test(pw)) score = 5;
  return Math.max(0, Math.min(100, score));
}

export function ipInCidr(ip, cidr) {
  const [network, prefixStr] = cidr.split('/');
  if (prefixStr === undefined) return ip === network;
  const family = net.isIP(ip);
  if (!family || family !== net.isIP(network)) return false;
  const prefix = Number(prefixStr);
  const toBits = (addr) => {
    if (family === 4) return addr.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
    const [head, tail = ''] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return groups.map((g) => parseInt(g || '0', 16).toString(2).padStart(16, '0')).join('');
  };
  return toBits(ip).slice(0, prefix) === toBits(network).slice(0, prefix);
}

function addressToBigInt(ip, family) {
  if (family === 4) return ip.split('.').reduce((n, o) => (n << 8n) + BigInt(o), 0n);
  const expand = (part) => (part ? part.split(':').flatMap((g) => {
    if (!g.includes('.')) return [g];
    const v = Number(addressToBigInt(g, 4));
    return [(v >>> 16).toString(16), (v & 0xffff).toString(16)];
  }) : []);
  const [head, tail] = ip.split('::');
  const h = expand(head);
  const t = tail === undefined ? [] : expand(tail);
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function bigIntToAddress(n, family) {
  if (family === 4) return [24, 16, 8, 0].map((s) => Number((n >> BigInt(s)) & 255n)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt((7 - i) * 16)) & 0xffffn));
  let best = { start: -1, len: 0 };
  let cur = { start: -1, len: 0 };
  groups.forEach((g, i) => {
    if (g !== 0) { cur = { start: -1, len: 0 }; return; }
    if (cur.start < 0) cur = { start: i, len: 0 };
    cur.len++;
    if (cur.len > best.len) best = { ...cur };
  });
  const hex = groups.map((g) => g.toString(16));
  if (best.len < 2) return hex.join(':');
  return `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.len).join(':')}`;
}

// Canonical form shared by what the operator types, what is recorded and what
// iptables/nft print back: host-length prefixes dropped, IPv6 compressed and
// lower-cased, network host bits cleared. Returns null for anything that is not
// an address or network.
export function normalizeIpOrCidr(value) {
  const parts = String(value ?? '').trim().split('/');
  if (parts.length > 2) return null;
  const [addr, prefixStr] = parts;
  const family = net.isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  if (prefixStr !== undefined && (!/^\d{1,3}$/.test(prefixStr) || Number(prefixStr) > max)) return null;
  const n = addressToBigInt(addr, family);
  if (prefixStr === undefined || Number(prefixStr) === max) return bigIntToAddress(n, family);
  const prefix = Number(prefixStr);
  const mask = prefix === 0 ? 0n : ((1n << BigInt(max)) - 1n) ^ ((1n << BigInt(max - prefix)) - 1n);
  return `${bigIntToAddress(n & mask, family)}/${prefix}`;
}

const NON_PUBLIC_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];

export function isPublicAddress(addr) {
  const family = net.isIP(addr);
  if (family === 4) return !NON_PUBLIC_V4.some((cidr) => ipInCidr(addr, cidr));
  if (family !== 6) return false;
  const a = addr.toLowerCase();
  if (a.startsWith('::ffff:') && net.isIP(a.slice(7)) === 4) return isPublicAddress(a.slice(7));
  if (a === '::' || a === '::1') return false;
  return !/^(fe[89ab]|f[cd])/.test(a);
}

// Server-side fetch of operator-supplied provider URLs: https only, redirects
// are not followed (a redirect could steer the panel at internal services),
// hosts that resolve to non-public addresses are refused and the body is capped.
export async function fetchJson(url, { method = 'GET', body, headers = {}, maxBytes = 1024 * 1024, timeoutMs = 10_000, lookup = (host) => dns.lookup(host, { all: true }) } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https:// URLs are fetched');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addresses = net.isIP(host) ? [host] : [];
  if (!addresses.length) { try { addresses = (await lookup(host)).map((a) => a.address); } catch { addresses = []; } }
  const internal = addresses.find((a) => !isPublicAddress(a));
  if (internal) throw new Error(`${host} resolves to a non-public address (${internal}); the panel only contacts public identity providers`);
  const res = await fetch(url, { method, body, redirect: 'manual', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status} redirect to ${res.headers?.get?.('location') || 'another location'} was not followed`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text;
  if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`the response exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('the response is not valid JSON'); }
}

const HOME_ROOT_SHAPE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

// PHP advisory matching (setting security.advisories). Pure so the rules can be
// unit-tested; versions compare numerically per segment ("8.3.6" < "8.3.36").
const SEVERITY_GRADE = { critical: 'critical', high: 'critical', medium: 'warning', low: 'info', info: 'info' };
const VERSION_RE = /^\d+(\.\d+){0,3}$/;

export function comparePhpVersions(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Range grammar: "*" | comparator list joined by spaces (all must hold) | alternatives joined by "||".
const COMPARATOR_RE = /^(<=|>=|<|>|=)?v?(\d+(?:\.\d+){0,3})$/;
export function isValidPhpRange(range) {
  const text = String(range ?? '').trim();
  if (!text) return false;
  return text.split('||').every((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((part) => part === '*' || COMPARATOR_RE.test(part));
  });
}

// null when the range cannot be read: a mistyped operator must surface as
// "unknown", never as "not affected".
export function phpVersionSatisfies(version, range) {
  if (!VERSION_RE.test(String(version || ''))) return false;
  if (!isValidPhpRange(range)) return null;
  return String(range).trim().split('||').some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    return parts.every((part) => {
      if (part === '*') return true;
      const m = part.match(COMPARATOR_RE);
      const c = comparePhpVersions(version, m[2]);
      switch (m[1] || '=') {
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
        default: return c === 0;
      }
    });
  });
}

// "8.3" from the ids the PHP layouts report: Debian "8.3", EasyApache "ea-php83",
// Remi "php83" / "remi-php83".
export function phpMinorFromId(id) {
  if (typeof id !== 'string') return null;
  if (/^\d+\.\d+$/.test(id)) return id;
  const m = id.match(/^(?:ea-|remi-)?php(\d)(\d)$/i);
  return m ? `${m[1]}.${m[2]}` : null;
}

// Drops entries the operator stored in a shape the matcher cannot read, so one
// bad edit never hides the rest of the list; `invalid` counts what was dropped.
export function normalizeAdvisories(list) {
  const out = []; let invalid = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) { invalid++; continue; }
    const affected = {};
    if (raw.affected && typeof raw.affected === 'object' && !Array.isArray(raw.affected)) {
      // A range the matcher cannot read is kept so its branch shows as
      // "unknown" instead of silently passing; it still counts as invalid.
      for (const [minor, range] of Object.entries(raw.affected)) {
        if (!/^\d+\.\d+$/.test(minor) || typeof range !== 'string') continue;
        affected[minor] = range;
        if (!isValidPhpRange(range)) invalid++;
      }
    }
    const fixedIn = raw.fixedIn && typeof raw.fixedIn === 'object' ? Object.fromEntries(Object.entries(raw.fixedIn).filter(([, v]) => typeof v === 'string')) : typeof raw.fixedIn === 'string' ? { '*': raw.fixedIn } : null;
    const severity = String(raw.severity || 'medium').toLowerCase();
    out.push({
      id: raw.id.trim(), title: typeof raw.title === 'string' && raw.title ? raw.title : raw.id.trim(), severity: SEVERITY_GRADE[severity] ? severity : 'medium',
      published: typeof raw.published === 'string' ? raw.published : null, url: typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url : null,
      affected, fixedIn, note: typeof raw.note === 'string' ? raw.note : null,
    });
  }
  return { advisories: out, invalid };
}

export const advisoryGrade = (severity) => SEVERITY_GRADE[severity] || 'warning';

// versions: [{ id: '8.3', version: '8.3.6', ... }] as reported by pkg.php.versions.
// Returns one entry per advisory with the installed versions it covers; `unversioned`
// lists advisories that carry no ranges yet (nothing to match, still worth showing).
export function matchPhpAdvisories(advisories, versions) {
  const matches = []; const unversioned = [];
  for (const adv of advisories) {
    if (!Object.keys(adv.affected).length) { unversioned.push(adv); continue; }
    const hits = [];
    for (const v of versions || []) {
      const full = typeof v?.version === 'string' && VERSION_RE.test(v.version) ? v.version : null;
      const minor = full ? full.split('.').slice(0, 2).join('.') : phpMinorFromId(v?.id);
      if (!minor || !(minor in adv.affected)) continue;
      // Without a patch level the branch alone decides ("*" ranges); a bounded
      // range cannot be evaluated and is reported as unknown rather than ignored.
      const range = adv.affected[minor];
      const affected = full ? phpVersionSatisfies(full, range) : range.trim() === '*' ? true : null;
      if (affected === false) continue;
      hits.push({ id: v.id ?? minor, version: full, minor, unknown: affected === null, fixedIn: adv.fixedIn?.[minor] ?? adv.fixedIn?.['*'] ?? null, isDefault: Boolean(v.isDefault) });
    }
    if (hits.length) matches.push({ advisory: adv, versions: hits });
  }
  return { matches, unversioned };
}

export function createSecurityCenterService(ctx) {
  const { db, agent, capabilities, settings, crypto, config, logger } = ctx;

  const stmts = {
    hostRules: db.prepare('SELECT * FROM host_access_rules ORDER BY position, id'),
    clearHostRules: db.prepare('DELETE FROM host_access_rules'),
    insertHostRule: db.prepare('INSERT INTO host_access_rules (service, source, action, comment, position) VALUES (?, ?, ?, ?, ?)'),
    activeBlocks: db.prepare(`SELECT * FROM cphulk_blocks WHERE expires_at IS NULL OR expires_at > datetime('now') ORDER BY created_at DESC`),
    activeBlockByIp: db.prepare(`SELECT * FROM cphulk_blocks WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`),
    blockById: db.prepare('SELECT * FROM cphulk_blocks WHERE id = ?'),
    insertBlock: db.prepare('INSERT INTO cphulk_blocks (ip, reason, expires_at) VALUES (?, ?, ?)'),
    expireBlock: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE id = ?`),
    expireBlocksByIp: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`),
    expireAllBlocks: db.prepare(`UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE expires_at IS NULL OR expires_at > datetime('now')`),
    purgeBlocks: db.prepare(`DELETE FROM cphulk_blocks WHERE expires_at IS NOT NULL AND expires_at < datetime('now', ?)`),
    purgeAttempts: db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', ?)`),
    lists: db.prepare('SELECT * FROM cphulk_lists ORDER BY kind, ip'),
    listByKind: db.prepare('SELECT * FROM cphulk_lists WHERE kind = ? ORDER BY ip'),
    listById: db.prepare('SELECT * FROM cphulk_lists WHERE id = ?'),
    insertList: db.prepare('INSERT INTO cphulk_lists (kind, ip, comment) VALUES (?, ?, ?)'),
    deleteList: db.prepare('DELETE FROM cphulk_lists WHERE id = ?'),
    fwEntries: db.prepare('SELECT * FROM firewall_entries ORDER BY ip, source'),
    fwByIp: db.prepare('SELECT * FROM firewall_entries WHERE ip = ?'),
    fwInsert: db.prepare('INSERT OR IGNORE INTO firewall_entries (ip, source, comment) VALUES (?, ?, ?)'),
    fwDeleteIp: db.prepare('DELETE FROM firewall_entries WHERE ip = ?'),
    fwDeleteSource: db.prepare('DELETE FROM firewall_entries WHERE ip = ? AND source = ?'),
    attemptStats: db.prepare(`SELECT COUNT(*) AS attempts, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures FROM login_attempts WHERE created_at > datetime('now', '-1 day')`),
    topOffenders: db.prepare(`SELECT ip, COUNT(*) AS failures, MAX(created_at) AS last_seen FROM login_attempts WHERE ok = 0 AND created_at > datetime('now', '-1 day') GROUP BY ip ORDER BY failures DESC LIMIT 10`),
    disabledRules: db.prepare('SELECT * FROM modsec_disabled_rules ORDER BY rule_id'),
    disableRule: db.prepare('INSERT OR REPLACE INTO modsec_disabled_rules (rule_id, reason) VALUES (?, ?)'),
    enableRule: db.prepare('DELETE FROM modsec_disabled_rules WHERE rule_id = ?'),
    vendors: db.prepare('SELECT * FROM modsec_vendors ORDER BY name'),
    vendorByName: db.prepare('SELECT * FROM modsec_vendors WHERE name = ?'),
    insertVendor: db.prepare('INSERT INTO modsec_vendors (name, url, enabled) VALUES (?, ?, ?)'),
    updateVendor: db.prepare("UPDATE modsec_vendors SET url = @url, enabled = @enabled, installed_at = datetime('now') WHERE id = @id"),
    setVendorEnabled: db.prepare('UPDATE modsec_vendors SET enabled = ? WHERE id = ?'),
    deleteVendor: db.prepare('DELETE FROM modsec_vendors WHERE id = ?'),
    providers: db.prepare('SELECT * FROM external_auth_providers ORDER BY name'),
    providerByName: db.prepare('SELECT * FROM external_auth_providers WHERE name = ?'),
    insertProvider: db.prepare('INSERT INTO external_auth_providers (name, display_name, issuer_url, client_id, client_secret_enc, scopes, enabled) VALUES (@name, @display_name, @issuer_url, @client_id, @client_secret_enc, @scopes, @enabled)'),
    insertProviderDiscovered: db.prepare('INSERT INTO external_auth_providers (name, display_name, issuer_url, client_id, client_secret_enc, scopes, enabled, discovery_json) VALUES (@name, @display_name, @issuer_url, @client_id, @client_secret_enc, @scopes, @enabled, @discovery_json)'),
    setDiscovery: db.prepare("UPDATE external_auth_providers SET discovery_json = @discovery_json, issuer_url = @issuer_url, updated_at = datetime('now') WHERE id = @id"),
    updateProvider: db.prepare(`UPDATE external_auth_providers SET display_name = @display_name, issuer_url = @issuer_url, client_id = @client_id, client_secret_enc = @client_secret_enc, scopes = @scopes, enabled = @enabled, discovery_json = @discovery_json, updated_at = datetime('now') WHERE id = @id`),
    deleteProvider: db.prepare('DELETE FROM external_auth_providers WHERE id = ?'),
    providerLinks: db.prepare('SELECT COUNT(*) AS n FROM external_auth_links WHERE provider_id = ?'),
    linkFind: db.prepare('SELECT l.*, u.username, u.role FROM external_auth_links l JOIN users u ON u.id = l.user_id WHERE l.provider_id = ? AND l.subject = ?'),
    linkInsert: db.prepare('INSERT OR REPLACE INTO external_auth_links (provider_id, user_id, subject, email) VALUES (?, ?, ?, ?)'),
    lastRun: db.prepare('SELECT * FROM security_advisor_runs ORDER BY id DESC LIMIT 1'),
    insertRun: db.prepare(`INSERT INTO security_advisor_runs (trigger, finished_at, summary_json, findings_json) VALUES (?, datetime('now'), ?, ?)`),
    pruneRuns: db.prepare('DELETE FROM security_advisor_runs WHERE id NOT IN (SELECT id FROM security_advisor_runs ORDER BY id DESC LIMIT 20)'),
    rootUser: db.prepare("SELECT username, totp_enabled FROM users WHERE role = 'root' ORDER BY id LIMIT 1"),
    shellAccounts: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE shell NOT IN ('/usr/sbin/nologin', '/usr/local/bin/jailshell')"),
    accountUsers: db.prepare('SELECT username FROM accounts ORDER BY username'),
  };

  const op = (name, args, req) => agent.op(name, args, { req });

  // Apache reloads are owned by the Service Configuration / web category when it
  // exists; until then (or on a host where it is absent) go through systemd.
  async function reloadApache(req) {
    if (typeof ctx.web?.reload === 'function') return ctx.web.reload(req);
    await capabilities.ensureFresh();
    const unit = capabilities.unitFor('httpd');
    if (!unit) throw new CapabilityError('apache', 'Apache is not installed on this server');
    return op('svc.reload', { unit }, req);
  }

  function requireFirewallBackend(detect) {
    capabilities.require('firewall', 'No firewall tooling (iptables or nftables) is installed on this server');
    if (!detect.backend) throw new CapabilityError('firewall', 'Only iptables and nftables backends are supported; install iptables or nft');
    return detect.backend;
  }

  let modsecCache = { at: 0, layout: null };
  async function detectModsec(force = false) {
    if (!force && modsecCache.layout && Date.now() - modsecCache.at < 60_000) return modsecCache.layout;
    const layout = await op('sec.modsec.detect');
    modsecCache = { at: Date.now(), layout };
    return layout;
  }
  async function requireModsec() {
    capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
    const layout = await detectModsec();
    if (!layout.installed) throw new CapabilityError('modsecurity', 'ModSecurity is not installed (no /etc/modsecurity or mod_security.conf found). Install libapache2-mod-security2 / mod_security.');
    return layout;
  }

  const hostAccess = {
    list() {
      return stmts.hostRules.all().map((r) => ({ id: r.id, service: r.service, source: r.source, action: r.action, comment: r.comment, position: r.position }));
    },
    async files() { return op('sec.hosts_allow.read'); },
    // The host file is written first; the stored rule set only changes once the
    // agent accepted the new file.
    async replace(rules, req) {
      const result = await op('sec.hosts_allow.write', { rules: rules.map((r) => ({ service: r.service, source: r.source, action: r.action, ...(r.comment ? { comment: r.comment } : {}) })) }, req);
      db.transaction(() => {
        stmts.clearHostRules.run();
        rules.forEach((r, i) => stmts.insertHostRule.run(r.service, r.source, r.action, r.comment || null, i));
      })();
      req?.audit?.({ action: 'security.host_access.update', args: { rules: rules.length } });
      return { rules: hostAccess.list(), written: result };
    },
    services: () => KNOWN_SERVICES,
  };

  const ssh = {
    async config() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      const cfg = await op('sec.sshd.get');
      const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
      return { ...cfg, authorizedKeyCount: keys.authorized?.length ?? 0 };
    },
    // Turning passwords off with no authorized root key locks root out of SSH,
    // so that combination needs an explicit force flag from any API client.
    async setConfig(settingsIn, req, { force = false } = {}) {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      if (settingsIn.PasswordAuthentication === 'no' && !force) {
        const keys = await op('sec.ssh_keys.list').catch(() => ({ authorized: [] }));
        if (!(keys.authorized?.length > 0)) throw unprocessable('Disabling SSH password authentication while no root key is authorized would lock root out of SSH. Authorize a key first (Manage root\'s SSH Keys) or resend with force: true to proceed anyway.', { force: ['Required to disable passwords without an authorized root key'] });
      }
      const result = await op('sec.sshd.set', { settings: settingsIn }, req);
      req?.audit?.({ action: 'security.sshd.update', args: { ...settingsIn, ...(force ? { force } : {}) } });
      return result;
    },
    async keys() {
      capabilities.require('sshd', 'OpenSSH server (sshd) is not installed on this server');
      return op('sec.ssh_keys.list');
    },
    async importKey(publicKey, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.add', { publicKey }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: result.fingerprint });
      return result;
    },
    async generate(input, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.generate', input, req);
      req?.audit?.({ action: 'security.ssh_keys.generate', target: input.name, args: { type: input.type, bits: input.bits, authorize: input.authorize } });
      return result;
    },
    async authorize(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.authorize', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.authorize', target: name });
      return result;
    },
    async deauthorize(fingerprint, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.remove', { fingerprint }, req);
      req?.audit?.({ action: 'security.ssh_keys.deauthorize', target: fingerprint });
      return result;
    },
    async deletePair(name, deauthorize, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.delete_pair', { name, deauthorize }, req);
      req?.audit?.({ action: 'security.ssh_keys.delete', target: name, args: { deauthorize } });
      return result;
    },
    async exportPrivate(name, req) {
      capabilities.require('sshd');
      const result = await op('sec.ssh_keys.export', { name }, req);
      req?.audit?.({ action: 'security.ssh_keys.export_private', target: name });
      return result;
    },
  };

  const cphulk = {
    settings() {
      return {
        enabled: Boolean(settings.get('security.cphulk.enabled')),
        maxFailuresPerIp: settings.get('security.cphulk.max_failures_per_ip'),
        lockoutMinutes: settings.get('security.cphulk.lockout_minutes'),
        firewallSync: Boolean(settings.get('security.cphulk.firewall_sync')),
        historyRetentionDays: settings.get('security.cphulk.history_retention_days'),
        blockDenylistPermanently: Boolean(settings.get('security.cphulk.block_denylist_permanently')),
      };
    },
    updateSettings(input, req) {
      const map = { enabled: 'security.cphulk.enabled', maxFailuresPerIp: 'security.cphulk.max_failures_per_ip', lockoutMinutes: 'security.cphulk.lockout_minutes', firewallSync: 'security.cphulk.firewall_sync', historyRetentionDays: 'security.cphulk.history_retention_days', blockDenylistPermanently: 'security.cphulk.block_denylist_permanently' };
      const values = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined && map[k]) values[map[k]] = v;
      settings.setMany(values);
      req?.audit?.({ action: 'security.cphulk.settings', args: values });
      return cphulk.settings();
    },
    overview() {
      const stats = stmts.attemptStats.get();
      return { settings: cphulk.settings(), blocks: cphulk.blocks(), stats: { attempts24h: stats.attempts || 0, failures24h: stats.failures || 0, activeBlocks: stmts.activeBlocks.all().length, topOffenders: stmts.topOffenders.all() } };
    },
    blocks: () => stmts.activeBlocks.all().map((b) => ({ ...b, permanent: b.expires_at == null })),
    isAllowlisted: (ip) => stmts.listByKind.all('allow').some((e) => ipInCidr(ip, e.ip)),
    shouldBlock(ip) {
      if (cphulk.isAllowlisted(ip)) return false;
      return stmts.activeBlocks.all().some((b) => ipInCidr(ip, b.ip)) || stmts.listByKind.all('deny').some((e) => ipInCidr(ip, e.ip));
    },
    isBlocked: (ip) => cphulk.shouldBlock(ip),
    history(query) {
      const where = [];
      const params = {};
      if (query.q) { where.push('(ip LIKE @q OR username LIKE @q)'); params.q = `%${query.q}%`; }
      if (query.failed) where.push('ok = 0');
      return paginate(db, { select: '*', from: 'login_attempts', where, params, sortable: { created_at: 'created_at', ip: 'ip', username: 'username' }, defaultSort: 'created_at', query: { ...query, dir: query.dir || 'desc' } });
    },
    async block(ip, { minutes = null, reason = 'manual block', firewall = false } = {}, req) {
      const viaFirewall = firewall || Boolean(settings.get('security.cphulk.firewall_sync'));
      // The panel login path matches exact addresses only; a network block is
      // only meaningful when the firewall drops it.
      if (ip.includes('/') && !viaFirewall) throw unprocessable('A CIDR network can only be blocked in the firewall: enable "Also drop blocked addresses in the firewall" or send firewall: true. Panel logins are matched per address.', { ip: ['Networks require a firewall block'] });
      if (cphulk.isAllowlisted(ip)) throw conflict(`${ip} is on the allowlist`);
      if (stmts.activeBlockByIp.get(ip)) throw conflict(`${ip} is already blocked`);
      const { lastInsertRowid } = stmts.insertBlock.run(ip, reason, minutes ? new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19) : null);
      let firewalled = false;
      if (viaFirewall) {
        try { await firewallApi.block(ip, req, { source: 'cphulk', comment: reason }); firewalled = true; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall block failed'); }
      }
      req?.audit?.({ action: 'security.cphulk.block', target: ip, args: { minutes, reason, firewalled } });
      return { ...stmts.blockById.get(lastInsertRowid), firewalled };
    },
    // Drops the firewall rule cPHulk added for an address; a manual block of the
    // same address (firewall_entries source 'manual') is left alone.
    async releaseFirewall(ip, req) {
      if (!stmts.fwByIp.all(ip).some((e) => e.source === 'cphulk')) return false;
      if (!capabilities.has('firewall')) return false;
      try { return (await firewallApi.release(ip, 'cphulk', req)).removed; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall unblock failed'); return false; }
    },
    async unblock(id, req) {
      const row = stmts.blockById.get(id);
      if (!row) throw notFound('Block');
      stmts.expireBlocksByIp.run(row.ip);
      const firewalled = stmts.listByKind.all('deny').some((e) => e.ip === row.ip) ? false : await cphulk.releaseFirewall(row.ip, req);
      req?.audit?.({ action: 'security.cphulk.unblock', target: row.ip });
      return { ip: row.ip, unblocked: true, firewalled };
    },
    async flush(req) {
      const ips = stmts.activeBlocks.all().map((b) => b.ip);
      const n = stmts.expireAllBlocks.run().changes;
      const deny = new Set(stmts.listByKind.all('deny').map((e) => e.ip));
      let firewalled = 0;
      for (const ip of new Set(ips)) if (!deny.has(ip) && await cphulk.releaseFirewall(ip, req)) firewalled++;
      req?.audit?.({ action: 'security.cphulk.flush', args: { blocks: n, firewalled } });
      return { cleared: n, firewalled };
    },
    lists: () => stmts.lists.all(),
    async addToList(kind, ip, comment, req) {
      if (stmts.lists.all().some((e) => e.kind === kind && e.ip === ip)) throw conflict(`${ip} is already on the ${kind} list`);
      const { lastInsertRowid } = stmts.insertList.run(kind, ip, comment || null);
      if (kind === 'allow') {
        for (const b of stmts.activeBlocks.all()) if (b.ip === ip || ipInCidr(b.ip, ip)) { stmts.expireBlock.run(b.id); await cphulk.releaseFirewall(b.ip, req); }
      }
      let firewalled = false;
      if (kind === 'deny') {
        if (settings.get('security.cphulk.block_denylist_permanently') && !ip.includes('/') && !stmts.activeBlockByIp.get(ip)) stmts.insertBlock.run(ip, 'denylist', null);
        if (settings.get('security.cphulk.firewall_sync') && capabilities.has('firewall')) {
          try { await firewallApi.block(ip, req, { source: 'cphulk', comment: 'denylist' }); firewalled = true; } catch (err) { logger.warn({ err, ip }, 'cPHulk: firewall block failed'); }
        }
      }
      req?.audit?.({ action: `security.cphulk.${kind}list.add`, target: ip, args: { comment, firewalled } });
      return { ...stmts.listById.get(lastInsertRowid), firewalled };
    },
    async removeFromList(id, req) {
      const row = stmts.listById.get(id);
      if (!row) throw notFound('List entry');
      stmts.deleteList.run(id);
      let firewalled = false;
      if (row.kind === 'deny') {
        db.prepare("UPDATE cphulk_blocks SET expires_at = datetime('now', '-1 second') WHERE ip = ? AND reason = 'denylist' AND expires_at IS NULL").run(row.ip);
        if (!stmts.activeBlockByIp.get(row.ip)) firewalled = await cphulk.releaseFirewall(row.ip, req);
      }
      req?.audit?.({ action: `security.cphulk.${row.kind}list.remove`, target: row.ip });
      return { removed: true, firewalled };
    },
    // Hourly job: purge history, expire blocks that match the allowlist, then
    // reconcile the firewall (recorded blocks, cPHulk entries, SMTP restriction).
    async maintenance(job) {
      const days = Number(settings.get('security.cphulk.history_retention_days')) || 30;
      const purgedAttempts = stmts.purgeAttempts.run(`-${days} days`).changes;
      const purgedBlocks = stmts.purgeBlocks.run(`-${days} days`).changes;
      let lifted = 0;
      for (const b of stmts.activeBlocks.all()) if (cphulk.isAllowlisted(b.ip)) { stmts.expireBlock.run(b.id); lifted++; }
      const sync = await firewallApi.reconcile(job);
      const result = { purgedAttempts, purgedBlocks, liftedAllowlisted: lifted, firewall: sync.firewall, smtp: sync.smtp };
      job?.log?.(`cPHulk maintenance: ${JSON.stringify(result)}`);
      return result;
    },
  };

  // Addresses are stored and compared in canonical form (see normalizeIpOrCidr);
  // the live listing is normalised the same way before any comparison.
  const canon = (ip) => normalizeIpOrCidr(ip) ?? String(ip);
  const liveEntries = (entries) => entries.map((e) => ({ ...e, ip: canon(e.ip) }));

  const firewallApi = {
    recorded: () => stmts.fwEntries.all(),
    annotate(entriesIn) {
      const entries = liveEntries(entriesIn);
      const rows = stmts.fwEntries.all();
      const byIp = new Map();
      for (const r of rows) (byIp.get(r.ip) || byIp.set(r.ip, []).get(r.ip)).push(r);
      const active = new Set(entries.map((e) => e.ip));
      const shaped = entries.map((e) => {
        const mine = byIp.get(e.ip) || [];
        return { ...e, sources: mine.map((r) => r.source), comment: mine.find((r) => r.comment)?.comment || null, active: true, persistent: mine.length > 0 };
      });
      for (const [ip, mine] of byIp) if (!active.has(ip)) shaped.push({ ip, sources: mine.map((r) => r.source), comment: mine.find((r) => r.comment)?.comment || null, active: false, persistent: true });
      return shaped;
    },
    async status() {
      const detect = await op('sec.firewall.detect');
      if (!capabilities.has('firewall') || !detect.backend) return { ...detect, installed: false, entries: firewallApi.annotate([]) };
      const list = await op('sec.firewall.list');
      return { ...detect, installed: true, entries: firewallApi.annotate(list.entries) };
    },
    async block(ipIn, req, { source = 'manual', comment = null } = {}) {
      const ip = canon(ipIn);
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.block', { ip }, req);
      stmts.fwInsert.run(ip, source, comment);
      req?.audit?.({ action: 'security.firewall.block', target: ip, args: { source } });
      return { ...result, ip, source, persistent: true };
    },
    // An explicit unblock drops every record for the address, including cPHulk's.
    async unblock(ipIn, req) {
      const ip = canon(ipIn);
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.firewall.unblock', { ip }, req);
      stmts.fwDeleteIp.run(ip);
      req?.audit?.({ action: 'security.firewall.unblock', target: ip });
      return { ...result, ip };
    },
    async release(ipIn, source, req) {
      const ip = canon(ipIn);
      stmts.fwDeleteSource.run(ip, source);
      if (stmts.fwByIp.all(ip).length) return { ip, removed: false, kept: true };
      const result = await op('sec.firewall.unblock', { ip }, req);
      return { ip, removed: Boolean(result.removed), kept: false };
    },
    async list() { requireFirewallBackend(await op('sec.firewall.detect')); return firewallApi.annotate((await op('sec.firewall.list')).entries); },
    // Makes the live WHM_BLOCK chain contain every recorded manual block plus
    // (when sync is on) every active cPHulk block and denylist entry, removing
    // only cPHulk entries the panel added earlier. Addresses that reached the
    // chain by other means are counted as "untracked" and never touched. Also
    // re-applies the SMTP restriction when it is switched on. Runs at boot and
    // from the hourly cPHulk maintenance job.
    async reconcile(job) {
      const out = { firewall: null, smtp: null };
      if (!capabilities.has('firewall')) return out;
      try {
        const detect = await op('sec.firewall.detect');
        if (!detect.backend) return out;
        const sync = Boolean(settings.get('security.cphulk.firewall_sync'));
        const rows = stmts.fwEntries.all();
        const manual = new Set(rows.filter((r) => r.source === 'manual').map((r) => r.ip));
        const tracked = new Set(rows.filter((r) => r.source === 'cphulk').map((r) => r.ip));
        const activeIps = new Set([...stmts.activeBlocks.all().map((b) => b.ip), ...stmts.listByKind.all('deny').map((e) => e.ip)].map(canon));
        const wantCphulk = sync ? activeIps : new Set([...tracked].filter((ip) => activeIps.has(ip)));
        const current = new Set(liveEntries((await op('sec.firewall.list')).entries).map((e) => e.ip));
        let added = 0; let removed = 0;
        const ensure = async (ip) => { if (current.has(ip)) return; await op('sec.firewall.block', { ip }); current.add(ip); added++; };
        for (const ip of manual) await ensure(ip);
        for (const ip of wantCphulk) { await ensure(ip); stmts.fwInsert.run(ip, 'cphulk', null); }
        for (const ip of tracked) {
          if (wantCphulk.has(ip)) continue;
          stmts.fwDeleteSource.run(ip, 'cphulk');
          if (!manual.has(ip) && current.has(ip)) { await op('sec.firewall.unblock', { ip }); current.delete(ip); removed++; }
        }
        const untracked = [...current].filter((ip) => !manual.has(ip) && !wantCphulk.has(ip)).length;
        out.firewall = { backend: detect.backend, added, removed, manual: manual.size, cphulk: wantCphulk.size, untracked };
      } catch (err) {
        job?.log?.(`firewall sync skipped: ${err.message}`, 'warn');
        out.firewall = { error: err.message };
      }
      try { out.smtp = await smtp.reconcile(job); } catch (err) {
        job?.log?.(`SMTP restriction re-apply failed: ${err.message}`, 'warn');
        out.smtp = { desired: true, reapplied: false, error: err.message };
      }
      return out;
    },
  };

  const smtp = {
    desired: () => Boolean(settings.get('security.smtp_restrictions.enabled')),
    async status() {
      const state = await op('sec.smtp_restrict.get');
      return { ...state, installed: capabilities.has('firewall') && Boolean(state.backend), desired: smtp.desired() };
    },
    // The live rules vanish on reboot or a firewall restart; the setting is the
    // source of truth and reconcile() puts them back.
    async set(enabled, req) {
      requireFirewallBackend(await op('sec.firewall.detect'));
      const result = await op('sec.smtp_restrict.set', { enabled }, req);
      settings.set('security.smtp_restrictions.enabled', enabled);
      req?.audit?.({ action: 'security.smtp_restrictions.set', args: { enabled } });
      return { ...result, desired: enabled };
    },
    async reconcile(job) {
      if (!smtp.desired()) return { desired: false, reapplied: false };
      if (!capabilities.has('firewall')) return { desired: true, reapplied: false, error: 'no firewall tooling is installed' };
      const state = await op('sec.smtp_restrict.get');
      if (!state.backend) return { desired: true, reapplied: false, error: 'no supported firewall backend' };
      if (state.enabled) return { desired: true, reapplied: false, families: state.families };
      const result = await op('sec.smtp_restrict.set', { enabled: true });
      job?.log?.(`SMTP restriction re-applied (${result.backend}: ${JSON.stringify(result.families)})`);
      return { desired: true, reapplied: true, families: result.families };
    },
  };

  const compilers = {
    status: () => op('sec.compiler_access.get'),
    async set(allow, req) {
      const result = await op('sec.compiler_access.set', { allow }, req);
      req?.audit?.({ action: 'security.compiler_access.set', args: { allow } });
      return result;
    },
  };

  const traceroute = {
    status: () => op('sec.traceroute.get'),
    async set(enabled, req) {
      const result = await op('sec.traceroute.set', { enabled }, req);
      req?.audit?.({ action: 'security.traceroute.set', args: { enabled } });
      return result;
    },
  };

  const forkBomb = {
    status: () => op('sec.fork_bomb.get'),
    async set(input, req) {
      const result = await op('sec.fork_bomb.set', input, req);
      req?.audit?.({ action: 'security.fork_bomb.set', args: input });
      return result;
    },
  };

  const wheel = {
    async group() {
      for (const g of ['wheel', 'sudo']) {
        const info = await op('user.groups.members', { group: g });
        if (info.exists) return info;
      }
      return { group: 'wheel', exists: false, members: [] };
    },
    async list() {
      const group = await wheel.group();
      const linux = await op('user.list_managed').catch(() => []);
      const candidates = [...new Set([...linux.map((u) => u.username), ...stmts.accountUsers.all().map((a) => a.username)])].filter((u) => !group.members.includes(u)).sort();
      return { ...group, candidates };
    },
    async add(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (group.members.includes(username)) throw conflict(`${username} is already in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: true }, req);
      req?.audit?.({ action: 'security.wheel.add', target: username, args: { group: group.group } });
      return wheel.list();
    },
    async remove(username, req) {
      const group = await wheel.group();
      if (!group.exists) throw badRequest('Neither a "wheel" nor a "sudo" group exists on this server');
      if (!group.members.includes(username)) throw notFound(`${username} in ${group.group}`);
      await op('user.groups.set_membership', { username, group: group.group, member: false }, req);
      req?.audit?.({ action: 'security.wheel.remove', target: username, args: { group: group.group } });
      return wheel.list();
    },
  };

  const userdir = {
    async status() {
      const state = await op('sec.userdir.get');
      return { ...state, installed: Boolean(state.installed) && capabilities.has('apache'), accounts: stmts.accountUsers.all().map((a) => a.username) };
    },
    // The Basic Setup home root is accepted with a trailing slash there but lands
    // inside an Apache <Directory "..."> block here, so it is normalised first.
    homeRoot() {
      const raw = String(settings.get('basic.home_root') || '/home').trim();
      const normalized = raw.replace(/\/+$/, '').replace(/\/{2,}/g, '/') || '/';
      if (!HOME_ROOT_SHAPE.test(normalized) || normalized.split('/').includes('..')) throw unprocessable(`The home directory root "${raw}" from Basic Setup cannot be used in the Apache mod_userdir include; set it to a plain absolute path such as /home on the Basic Setup page.`, { homeRoot: ['Must be a plain absolute path without ".." or special characters'] });
      return normalized;
    },
    async set({ enabled, excludeUsers }, req) {
      capabilities.require('apache', 'Apache is not installed on this server');
      const result = await op('sec.userdir.set', { enabled, excludeUsers, homeRoot: userdir.homeRoot() }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.userdir.set', args: { enabled, excludeUsers } });
      return { ...result, reload };
    },
  };

  const modsec = {
    detect: detectModsec,
    async status() {
      capabilities.require('apache', 'Apache is not installed; ModSecurity runs as an Apache module');
      const layout = await detectModsec(true);
      if (!layout.installed) return { installed: false, layout };
      const config = await op('sec.modsec.get_config');
      return { installed: true, layout, ...config, disabledRules: stmts.disabledRules.all(), vendors: stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })) };
    },
    async setConfig(directives, req) {
      await requireModsec();
      const result = await op('sec.modsec.set_config', { directives }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: 'security.modsec.config', args: directives });
      return { ...result, reload };
    },
    async rules(query) {
      await requireModsec();
      const { files, rules, truncated } = await op('sec.modsec.list_rules', { limit: 20000 });
      const disabled = new Set(stmts.disabledRules.all().map((r) => r.rule_id));
      let list = rules.map((r) => ({ ...r, disabled: disabled.has(r.id) }));
      if (query.q) { const q = query.q.toLowerCase(); list = list.filter((r) => String(r.id).includes(q) || (r.msg || '').toLowerCase().includes(q) || (r.file || '').toLowerCase().includes(q) || (r.tag || '').toLowerCase().includes(q)); }
      if (query.vendor) list = list.filter((r) => (r.vendor || 'base') === query.vendor);
      if (query.disabled) list = list.filter((r) => r.disabled);
      const page = query.page || 1; const pageSize = query.pageSize || 50;
      return { data: list.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, total: list.length, files: files.length, truncated } };
    },
    disabledRules: () => stmts.disabledRules.all(),
    // The include is written (and validated by Apache) before the rule's state is
    // recorded, so a rejected include never leaves a rule marked disabled.
    async setRuleDisabled(ruleId, disabled, reason, req) {
      await requireModsec();
      const ids = [...new Set([...stmts.disabledRules.all().map((r) => r.rule_id).filter((id) => id !== ruleId), ...(disabled ? [ruleId] : [])])].sort((a, b) => a - b);
      const result = await op('sec.modsec.set_disabled', { ids }, req);
      if (disabled) stmts.disableRule.run(ruleId, reason || null); else stmts.enableRule.run(ruleId);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      req?.audit?.({ action: disabled ? 'security.modsec.rule.disable' : 'security.modsec.rule.enable', target: String(ruleId), args: { reason } });
      return { ruleId, disabled, ids, path: result.path, reload };
    },
    async hits(limit) {
      await requireModsec();
      return op('sec.modsec.hits', { limit });
    },
    vendors: () => stmts.vendors.all().map((v) => ({ ...v, enabled: Boolean(v.enabled) })),
    async addVendor({ name, url, enabled = true }, user, req) {
      await requireModsec();
      if (stmts.vendorByName.get(name)) throw conflict(`Vendor "${name}" already exists`);
      stmts.insertVendor.run(name, url, enabled ? 1 : 0);
      req?.audit?.({ action: 'security.modsec.vendor.add', target: name, args: { url } });
      return { vendor: stmts.vendorByName.get(name), job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    async updateVendor(name, user, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      req?.audit?.({ action: 'security.modsec.vendor.update', target: name });
      return { vendor, job: ctx.jobs.enqueue('security.modsec.vendor.install', { name }, { userId: user?.id ?? null }) };
    },
    // Vendor state changes are applied to Apache first and recorded only once the
    // include validated, so the stored flags never claim more than the host does.
    async setVendorEnabled(name, enabled, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      const desired = stmts.vendors.all().map((v) => ({ name: v.name, enabled: v.name === name ? enabled : Boolean(v.enabled) }));
      const applied = await modsec.applyVendors(req, desired);
      stmts.setVendorEnabled.run(enabled ? 1 : 0, vendor.id);
      req?.audit?.({ action: 'security.modsec.vendor.toggle', target: name, args: { enabled } });
      return { ...stmts.vendorByName.get(name), enabled, applied };
    },
    async removeVendor(name, req) {
      await requireModsec();
      const vendor = stmts.vendorByName.get(name);
      if (!vendor) throw notFound('Vendor');
      const remaining = stmts.vendors.all().filter((v) => v.name !== name).map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }));
      const applied = await modsec.applyVendors(req, remaining);
      await op('sec.modsec.vendor.remove', { name }, req);
      stmts.deleteVendor.run(vendor.id);
      req?.audit?.({ action: 'security.modsec.vendor.remove', target: name });
      return { removed: true, applied };
    },
    async applyVendors(req, vendors = stmts.vendors.all().map((v) => ({ name: v.name, enabled: Boolean(v.enabled) }))) {
      const result = await op('sec.modsec.vendors.apply', { vendors }, req);
      const reload = await reloadApache(req).catch((err) => ({ error: err.message }));
      return { ...result, reload };
    },
    async installVendorJob(job) {
      const vendor = stmts.vendorByName.get(job.params.name);
      if (!vendor) throw new Error(`vendor "${job.params.name}" no longer exists`);
      job.log(`Downloading ${vendor.url}`);
      job.progress(10, 'downloading');
      const result = await agent.op('sec.modsec.vendor.install', { name: vendor.name, url: vendor.url });
      job.log(`Installed ${result.ruleFiles} rule files (${result.rules} rules) into ${result.dir}`);
      job.progress(70, 'applying includes');
      stmts.updateVendor.run({ id: vendor.id, url: vendor.url, enabled: vendor.enabled });
      const applied = await modsec.applyVendors(null);
      job.log(applied.reload?.error ? `Apache reload failed: ${applied.reload.error}` : 'Apache reloaded');
      job.progress(100, 'done');
      return { ...result, applied };
    },
  };

  function policy() {
    return {
      verifiedIpLogin: Boolean(settings.get('security.policy.verified_ip_login')),
      passwordMaxAgeDays: Number(settings.get('security.policy.password_max_age_days')) || 0,
      require2faForRoot: Boolean(settings.get('security.2fa.required_for_root')),
      require2faForResellers: Boolean(settings.get('security.policy.require_2fa_for_resellers')),
      sessionTimeoutMinutes: Number(settings.get('security.policy.session_timeout_minutes')) || 0,
      disallowConcurrentSessions: Boolean(settings.get('security.policy.disallow_concurrent_sessions')),
      apiTokensRequire2fa: Boolean(settings.get('security.policy.api_tokens_require_2fa')),
    };
  }

  function passwordPolicy(password, context = 'account') {
    const fallback = Number(settings.get('security.min_password_strength')) || 0;
    const specific = PASSWORD_CONTEXTS.includes(context) ? settings.get(`security.password.strength.${context}`) : null;
    const minimum = specific == null ? fallback : Number(specific);
    const score = passwordStrength(password);
    return { score, minimum, ok: score >= minimum, context };
  }

  const jwksCache = new Map();
  const externalAuth = {
    shape(row) {
      if (!row) return null;
      // After an issuer edit the row only remembers its preset: discovery is not run.
      const stored = json.parse(row.discovery_json, null);
      const discovery = stored?.authorizationEndpoint ? stored : null;
      return { id: row.id, name: row.name, displayName: row.display_name, issuerUrl: row.issuer_url, clientId: row.client_id, hasClientSecret: Boolean(row.client_secret_enc), scopes: row.scopes, enabled: Boolean(row.enabled), discovery, preset: stored?.preset || null, links: stmts.providerLinks.get(row.id).n, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    list: () => stmts.providers.all().map(externalAuth.shape),
    // The redirect URI auth.js sends is built from the origin the browser used,
    // so both that one and the canonical panel address are reported.
    presets({ redirectBase = '' } = {}) {
      const hostname = settings.get('basic.hostname', '') || 'localhost';
      return {
        presets: EXTERNAL_AUTH_PRESETS.map(publicPreset),
        redirectUriTemplate: `https://${hostname}:${config.tlsPort || 2087}${REDIRECT_PATH}`,
        currentRedirectUriTemplate: redirectBase ? `${redirectBase}${REDIRECT_PATH}` : null,
      };
    },
    // Discovery for a preset: the vendor's document, with pinned endpoints
    // filling what a fetched document omits (never standing in for one that
    // could not be fetched), validated against the resolved issuer (or the one
    // the vendor declares when the preset says that form is authoritative).
    async presetDiscovery(preset, issuerUrl, { allowForeignEndpoints = false } = {}) {
      const url = `${issuerUrl}/.well-known/openid-configuration`;
      let doc;
      try { doc = await fetchJson(url, { timeoutMs: 10_000 }); } catch (err) { throw badRequest(`OpenID discovery failed for ${url}: ${err.message}`); }
      if (preset.endpoints && doc && typeof doc === 'object' && !Array.isArray(doc)) doc = { ...doc, ...preset.endpoints };
      let issuer = issuerUrl;
      if (preset.issuerFromDiscovery && typeof doc.issuer === 'string' && new RegExp(preset.issuerFromDiscovery).test(stripSlash(doc.issuer))) issuer = stripSlash(doc.issuer);
      const discovery = checkDiscoveryDocument(doc, issuer, { allowForeignEndpoints, allowedForeignHosts: preset.foreignHosts || [] });
      return { issuerUrl: issuer, discovery: { ...discovery, preset: preset.id } };
    },
    async createFromPreset(input, req) {
      const preset = presetById(input.preset);
      if (!preset) throw unprocessable(`Unknown provider preset "${input.preset}"`, { preset: ['Unknown preset'] });
      if (preset.supported === false) throw unprocessable(`${preset.label} is not supported yet: ${preset.reason}`, { preset: [preset.reason] });
      if (stmts.providerByName.get(input.name)) throw conflict(`Provider "${input.name}" already exists`);
      const { issuerUrl: templated, values } = resolvePresetIssuer(preset, { fields: input.fields, clientId: input.clientId });
      if (preset.secret?.required && !input.clientSecret) throw unprocessable(`${preset.label} needs a client secret`, { clientSecret: [preset.secret.help || 'Required'] });
      const { issuerUrl, discovery } = await externalAuth.presetDiscovery(preset, templated, { allowForeignEndpoints: input.allowForeignEndpoints === true });
      if (stmts.providerByName.get(input.name)) throw conflict(`Provider "${input.name}" already exists`);
      stmts.insertProviderDiscovered.run({
        name: input.name, display_name: input.displayName || preset.label, issuer_url: issuerUrl, client_id: input.clientId,
        client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : null, scopes: typeof input.scopes === 'string' ? input.scopes : preset.scopes,
        enabled: input.enabled === false ? 0 : 1, discovery_json: JSON.stringify(discovery),
      });
      req?.audit?.({ action: 'security.external_auth.create', target: input.name, args: { preset: preset.id, issuerUrl, clientId: input.clientId, fields: values, foreignEndpoints: discovery.foreignEndpoints } });
      return externalAuth.get(input.name);
    },
    get(name) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      return externalAuth.shape(row);
    },
    create(input, req) {
      if (stmts.providerByName.get(input.name)) throw conflict(`Provider "${input.name}" already exists`);
      stmts.insertProvider.run({ name: input.name, display_name: input.displayName, issuer_url: input.issuerUrl.replace(/\/+$/, ''), client_id: input.clientId, client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : null, scopes: input.scopes || 'openid email profile', enabled: input.enabled === false ? 0 : 1 });
      req?.audit?.({ action: 'security.external_auth.create', target: input.name, args: { issuerUrl: input.issuerUrl, clientId: input.clientId } });
      return externalAuth.get(input.name);
    },
    update(name, input, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const issuer = input.issuerUrl ? input.issuerUrl.replace(/\/+$/, '') : row.issuer_url;
      const preset = json.parse(row.discovery_json, null)?.preset || null;
      stmts.updateProvider.run({
        id: row.id, display_name: input.displayName ?? row.display_name, issuer_url: issuer, client_id: input.clientId ?? row.client_id,
        client_secret_enc: input.clientSecret ? crypto.encrypt(input.clientSecret) : row.client_secret_enc, scopes: input.scopes ?? row.scopes,
        enabled: input.enabled == null ? row.enabled : input.enabled ? 1 : 0,
        discovery_json: issuer === row.issuer_url ? row.discovery_json : preset ? JSON.stringify({ preset }) : null,
      });
      req?.audit?.({ action: 'security.external_auth.update', target: name, args: input });
      return externalAuth.get(name);
    },
    remove(name, req) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.deleteProvider.run(row.id);
      req?.audit?.({ action: 'security.external_auth.delete', target: name });
      return { deleted: true };
    },
    async discover(name, req, { allowForeignEndpoints = false } = {}) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      const preset = presetById(json.parse(row.discovery_json, null)?.preset);
      let discovery;
      let issuerUrl = row.issuer_url;
      if (preset && preset.supported !== false) {
        ({ discovery, issuerUrl } = await externalAuth.presetDiscovery(preset, row.issuer_url, { allowForeignEndpoints }));
      } else {
        const url = `${row.issuer_url}/.well-known/openid-configuration`;
        let doc;
        try {
          doc = await fetchJson(url, { timeoutMs: 10_000 });
        } catch (err) {
          throw badRequest(`OpenID discovery failed for ${url}: ${err.message}`);
        }
        discovery = checkDiscoveryDocument(doc, row.issuer_url, { allowForeignEndpoints });
      }
      stmts.setDiscovery.run({ id: row.id, discovery_json: JSON.stringify(discovery), issuer_url: issuerUrl });
      jwksCache.delete(row.id);
      req?.audit?.({ action: 'security.external_auth.discover', target: name, args: { preset: preset?.id || null, allowForeignEndpoints, foreignEndpoints: discovery.foreignEndpoints } });
      return externalAuth.get(name);
    },
    async jwks(row, discovery) {
      if (!discovery?.jwksUri) return [];
      const cached = jwksCache.get(row.id);
      if (cached && Date.now() - cached.at < 3_600_000) return cached.keys;
      if (!discovery.jwksUri.startsWith('https://')) throw badRequest('jwks_uri must use https://');
      let keys;
      try { keys = (await fetchJson(discovery.jwksUri, { timeoutMs: 15_000 })).keys || []; } catch (err) { throw badRequest(`Fetching the provider keys failed: ${err.message}`); }
      jwksCache.set(row.id, { at: Date.now(), keys });
      return keys;
    },
    // Helpers for the auth category to wire a login/link flow:
    authorizationUrl(name, { state, nonce, redirectUri }) {
      const p = externalAuth.get(name);
      if (!p.enabled) throw badRequest(`Provider "${name}" is disabled`);
      if (!p.discovery?.authorizationEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      const u = new URL(p.discovery.authorizationEndpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri, scope: p.scopes, state, nonce })) if (v) u.searchParams.set(k, v);
      return u.toString();
    },
    // `nonce` must be the value sent in authorizationUrl() for this login; the
    // returned claims are trustworthy only because the id_token was verified.
    async exchangeCode(name, { code, redirectUri, nonce = null }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      if (!row.enabled) throw badRequest(`Provider "${name}" is disabled`);
      const discovery = json.parse(row.discovery_json, null);
      if (!discovery?.tokenEndpoint) throw badRequest(`Run discovery for "${name}" first`);
      if (!discovery.tokenEndpoint.startsWith('https://')) throw badRequest('The token endpoint must use https://; run discovery again');
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: row.client_id });
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
      const clientSecret = row.client_secret_enc ? crypto.decrypt(row.client_secret_enc) : null;
      // RFC 6749 §2.3.1: HTTP Basic unless the provider only takes the secret in the body (Apple, Meta).
      const authMethods = Array.isArray(discovery.tokenEndpointAuthMethods) ? discovery.tokenEndpointAuthMethods : [];
      if (clientSecret && authMethods.includes('client_secret_post') && !authMethods.includes('client_secret_basic')) body.set('client_secret', clientSecret);
      else if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(row.client_id)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      let tokens;
      try { tokens = await fetchJson(discovery.tokenEndpoint, { method: 'POST', headers, body, timeoutMs: 15_000 }); } catch (err) { throw badRequest(`Token exchange failed: ${err.message}`); }
      if (!tokens.id_token) throw badRequest('The token response has no id_token: the provider is not OpenID Connect or "openid" is missing from the scopes');
      const header = decodeJwtPart(String(tokens.id_token).split('.')[0]) || {};
      const jwks = /^HS/.test(header.alg || '') ? [] : await externalAuth.jwks(row, discovery);
      let claims;
      try {
        claims = verifyIdToken(tokens.id_token, { issuer: discovery.issuer || row.issuer_url, clientId: row.client_id, nonce, jwks, clientSecret });
      } catch (err) {
        throw badRequest(`The provider's id_token was rejected: ${err.message}`);
      }
      if (discovery.userinfoEndpoint && tokens.access_token) {
        const extra = await fetchJson(discovery.userinfoEndpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, timeoutMs: 15_000 }).catch(() => null);
        if (extra && typeof extra === 'object') {
          if (extra.sub && extra.sub !== claims.sub) throw badRequest('The userinfo subject does not match the id_token');
          claims = { ...extra, ...claims };
        }
      }
      return { claims, subject: claims.sub, email: claims.email_verified === false ? null : claims.email || null, tokens: { tokenType: tokens.token_type, expiresIn: tokens.expires_in } };
    },
    findLinkedUser(name, subject) {
      const row = stmts.providerByName.get(name);
      return row ? stmts.linkFind.get(row.id, subject) || null : null;
    },
    link(name, { userId, subject, email }) {
      const row = stmts.providerByName.get(name);
      if (!row) throw notFound('Provider');
      stmts.linkInsert.run(row.id, userId, subject, email || null);
      return stmts.linkFind.get(row.id, subject);
    },
  };

  // PHP advisories: the stored list (setting security.advisories) matched against
  // installed PHP versions. Software's MultiPHP data calls forVersions() so the
  // badge in MultiPHP Manager and the advisor finding come from one rule set.
  const phpAdvisories = {
    list() { return normalizeAdvisories(settings.get('security.advisories', [])); },
    forVersions(versions) { return matchPhpAdvisories(phpAdvisories.list().advisories, versions); },
    // [{ id, severity, title, url, fixedIn }] for one installed version entry.
    forVersion(v) {
      return phpAdvisories.forVersions([v]).matches.map(({ advisory, versions: hits }) => ({ id: advisory.id, severity: advisory.severity, grade: advisoryGrade(advisory.severity), title: advisory.title, url: advisory.url, fixedIn: hits[0].fixedIn, unknown: hits[0].unknown }));
    },
  };

  // Read-only scanner. Every probe is isolated so one failing check never hides
  // the rest; "fix" links point at the panel's own pages.
  const advisor = {
    last() {
      const row = stmts.lastRun.get();
      return row ? { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, trigger: row.trigger, summary: json.parse(row.summary_json, {}), findings: json.parse(row.findings_json, []) } : null;
    },
    async scan(trigger = 'manual', req) {
      const findings = [];
      const add = (f) => findings.push({ grade: 'info', ...f });
      const probe = async (id, title, fn) => {
        try { await fn(); } catch (err) { add({ id, grade: 'info', title: `Could not check: ${title}`, detail: err.message }); }
      };
      await capabilities.ensureFresh();

      await probe('ssh', 'SSH configuration', async () => {
        if (!capabilities.has('sshd')) { add({ id: 'ssh.installed', grade: 'info', title: 'OpenSSH server is not installed', detail: 'No sshd binary was found, so SSH hardening checks were skipped.' }); return; }
        const cfg = await op('sec.sshd.get');
        const e = cfg.effective;
        const pw = (e.passwordauthentication || 'yes').toLowerCase();
        add(pw === 'yes'
          ? { id: 'ssh.password', grade: 'warning', title: 'SSH password authentication is enabled', detail: 'Attackers can brute-force passwords over SSH. Prefer key-based authentication and disable passwords once a key is authorized.', fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.password', grade: 'ok', title: 'SSH password authentication is disabled' });
        const root = (e.permitrootlogin || 'yes').toLowerCase();
        add(root === 'yes'
          ? { id: 'ssh.root', grade: 'warning', title: 'Root may log in over SSH with a password', detail: `PermitRootLogin is "${root}". Set it to prohibit-password or no.`, fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } }
          : { id: 'ssh.root', grade: 'ok', title: `Root SSH login is restricted (PermitRootLogin ${root})` });
        if (e.port && e.port !== '22') add({ id: 'ssh.port', grade: 'ok', title: `SSH listens on a non-default port (${e.port})` });
        for (const s of cfg.shadowed || []) add({ id: `ssh.shadowed.${s.key}`, grade: 'warning', title: `${s.key} ${s.managed} from the panel is overridden (sshd uses ${s.effective})`, detail: s.by ? `${s.by} sets it first and sshd keeps the first value it reads.` : 'Another sshd configuration file read before the panel drop-in sets it.', fix: { label: 'SSH Password Authorization Tweak', path: '/security-center/ssh-password-authorization-tweak' } });
      });

      await probe('2fa', 'two-factor authentication', async () => {
        const root = stmts.rootUser.get();
        const required = Boolean(settings.get('security.2fa.required_for_root'));
        if (root && !root.totp_enabled) add({ id: '2fa.root', grade: 'critical', title: 'The root panel user has no two-factor authentication', detail: 'A leaked root password gives full control of the server. Enroll an authenticator app.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
        else add({ id: '2fa.root', grade: 'ok', title: 'Root has two-factor authentication enabled' });
        if (!required) add({ id: '2fa.policy', grade: 'warning', title: 'Two-factor authentication is not required for root', detail: 'Enable the policy so it cannot be silently disabled.', fix: { label: 'Two-Factor Authentication', path: '/security-center/two-factor-authentication' } });
      });

      await probe('integrity', 'panel integrity', async () => {
        // Release builds ship /opt/whm/MANIFEST.sha256 (sha256 + path per line) beside the panel;
        // a development checkout has none, which is reported but not graded.
        const manifest = [path.join(REPO_ROOT, 'MANIFEST.sha256'), '/opt/whm/MANIFEST.sha256'].find((f) => fs.existsSync(f));
        if (!manifest) { add({ id: 'integrity.manifest', grade: 'info', title: 'No release manifest found', detail: 'MANIFEST.sha256 is written by release packaging; development checkouts and manual installs have none, so panel files cannot be verified against a known-good list.' }); return; }
        const root = path.dirname(manifest);
        const entries = fs.readFileSync(manifest, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.match(/^([0-9a-f]{64})\s+\*?(.+)$/)).filter(Boolean);
        const changed = []; const missing = [];
        for (const [, digest, rel] of entries) {
          const file = path.resolve(root, rel);
          if (!file.startsWith(root + path.sep)) continue;
          if (!fs.existsSync(file)) { missing.push(rel); continue; }
          if (nodeCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) changed.push(rel);
        }
        if (!entries.length) add({ id: 'integrity.manifest', grade: 'warning', title: 'The release manifest is empty or unreadable', detail: `${manifest} holds no "<sha256>  <path>" lines.` });
        else if (changed.length || missing.length) add({ id: 'integrity.files', grade: 'critical', title: `${changed.length + missing.length} panel file(s) differ from the release manifest`, detail: [...changed.map((f) => `${f}: modified`), ...missing.map((f) => `${f}: missing`)].slice(0, 20).join('\n'), fix: { label: 'Upgrade to Latest Version', path: '/cpanel/upgrade-to-latest-version' } });
        else add({ id: 'integrity.files', grade: 'ok', title: `All ${entries.length} manifest files match the release manifest` });
      });

      await probe('firewall', 'firewall', async () => {
        const detect = await op('sec.firewall.detect');
        if (!capabilities.has('firewall') || !detect.backend) add({ id: 'firewall.present', grade: 'critical', title: 'No supported firewall is installed', detail: 'Install iptables or nftables so the panel can block abusive addresses and restrict SMTP.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
        else {
          add({ id: 'firewall.present', grade: 'ok', title: `Firewall available (${detect.backend})` });
          const smtpState = await op('sec.smtp_restrict.get');
          const open = smtpState.unprotected || [];
          add(!smtpState.enabled
            ? smtp.desired()
              ? { id: 'smtp.restricted', grade: 'warning', title: 'SMTP restrictions are enabled but not active in the firewall', detail: 'The rules were lost (reboot or firewall restart). They are re-applied by the hourly maintenance job; re-enable the restriction to apply them now.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
              : { id: 'smtp.restricted', grade: 'warning', title: 'SMTP restrictions are disabled', detail: 'Compromised scripts can send spam directly on port 25. Restrict outbound SMTP to root and the mail groups.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
            : open.length
              ? { id: 'smtp.restricted', grade: 'warning', title: `Outbound SMTP is restricted for IPv4 only (${open.join(', ')} open)`, detail: 'ip6tables is not installed, so unprivileged processes can still reach port 25 over IPv6. Install ip6tables or switch to nftables.', fix: { label: 'SMTP Restrictions', path: '/security-center/smtp-restrictions' } }
              : { id: 'smtp.restricted', grade: 'ok', title: 'Outbound SMTP is restricted to mail services (IPv4 and IPv6)' });
        }
      });

      await probe('cphulk', 'cPHulk', async () => {
        add(settings.get('security.cphulk.enabled')
          ? { id: 'cphulk.enabled', grade: 'ok', title: `cPHulk brute force protection is on (${settings.get('security.cphulk.max_failures_per_ip')} failures → ${settings.get('security.cphulk.lockout_minutes')} min block)` }
          : { id: 'cphulk.enabled', grade: 'warning', title: 'cPHulk brute force protection is disabled', detail: 'Repeated failed panel logins are not being blocked.', fix: { label: 'cPHulk Brute Force Protection', path: '/security-center/cphulk-brute-force-protection' } });
      });

      // The pending-update check lives in the Software category
      // (ctx.software.update.status(), backed by the pkg.upgradable op).
      await probe('packages', 'outdated packages', async () => {
        const software = ctx.software;
        const pkg = ctx.pkg || software?.pkg;
        if (!software && !pkg) { add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'The Software category is not loaded on this panel.' }); return; }
        if (!capabilities.has('pkg')) {
          add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'No supported package manager (apt-get, dnf or yum) was found on this server.' });
          return;
        }
        let count = 0; let security = 0;
        if (typeof software?.update?.status === 'function') {
          const status = await software.update.status();
          count = Number(status?.count ?? (Array.isArray(status?.packages) ? status.packages.length : 0)) || 0;
          security = Number(status?.security ?? 0) || 0;
        } else {
          const fn = pkg && (pkg.outdated || pkg.listUpdates || pkg.updates);
          if (typeof fn !== 'function') { add({ id: 'pkg.updates', grade: 'info', title: 'Package update check unavailable', detail: 'The loaded Software category exposes no update check.' }); return; }
          const result = await fn.call(pkg);
          count = Array.isArray(result) ? result.length : Number(result?.count ?? result?.total ?? 0) || 0;
          security = Number(result?.security ?? 0) || 0;
        }
        add(count > 0
          ? { id: 'pkg.updates', grade: security > 0 ? 'critical' : 'warning', title: `${count} package update${count === 1 ? '' : 's'} available${security > 0 ? ` (${security} security)` : ''}`, detail: 'Outdated packages may carry known vulnerabilities.', fix: { label: 'System Update', path: '/software/system-update' } }
          : { id: 'pkg.updates', grade: 'ok', title: 'All distribution packages are up to date' });
      });

      await probe('php', 'PHP advisories', async () => {
        const { advisories, invalid } = phpAdvisories.list();
        const listFix = { label: 'Edit advisory list', path: '/security-center/security-advisor#advisories' };
        if (invalid) add({ id: 'php.advisories.invalid', grade: 'warning', title: `${invalid} entr${invalid === 1 ? 'y' : 'ies'} in the PHP advisory list could not be read`, detail: 'Each entry of the security.advisories setting needs at least an "id"; unreadable entries are skipped, so their versions are not checked.', fix: listFix });
        if (!advisories.length) { add({ id: 'php.advisories', grade: 'info', title: 'The PHP advisory list is empty', detail: 'No PHP vulnerability is known to this panel. Update the security.advisories setting with the current php.net advisories.', fix: listFix }); return; }
        if (!capabilities.has('php') || typeof ctx.software?.php?.versions !== 'function') { add({ id: 'php.advisories', grade: 'info', title: 'No PHP installation found', detail: `${advisories.length} PHP advisor${advisories.length === 1 ? 'y' : 'ies'} on file, but no php binary is installed on this server, so there is nothing to check.` }); return; }
        const { versions } = await ctx.software.php.versions();
        if (!versions.length) { add({ id: 'php.advisories', grade: 'info', title: 'No PHP installation found', detail: 'MultiPHP Manager detected no PHP version; the advisory list was not applied.' }); return; }
        const { matches, unversioned } = matchPhpAdvisories(advisories, versions);
        const fix = { label: 'MultiPHP Manager', path: '/software/multiphp-manager' };
        for (const { advisory, versions: hits } of matches) {
          const names = hits.map((h) => `${h.version || `${h.minor}.x`}${h.isDefault ? ' (default)' : ''}`);
          const lines = hits.map((h) => `PHP ${h.version || `${h.minor} (patch level unknown)`}: ${h.fixedIn ? `update to ${h.fixedIn}` : 'no packaged fix for this branch; move its sites to a supported version'}`);
          add({ id: `php.advisory.${advisory.id}`, grade: advisoryGrade(advisory.severity), title: `PHP ${names.join(', ')} ${hits.length === 1 ? 'is' : 'are'} affected by ${advisory.id}`, detail: [advisory.title, ...lines, advisory.note].filter(Boolean).join('\n'), url: advisory.url, advisory: advisory.id, versions: hits, fix });
        }
        for (const advisory of unversioned) add({ id: `php.advisory.${advisory.id}`, grade: 'info', title: `${advisory.id} has no fixed release yet`, detail: [advisory.title, advisory.note].filter(Boolean).join('\n'), url: advisory.url, advisory: advisory.id, versions: [] });
        if (!matches.length) add({ id: 'php.advisories', grade: 'ok', title: `Installed PHP ${versions.map((v) => v.version || v.id).join(', ')} not affected by ${advisories.length - unversioned.length} listed advisor${advisories.length - unversioned.length === 1 ? 'y' : 'ies'}` });
      });

      await probe('filesystem', 'filesystem permissions', async () => {
        const fsScan = await op('sec.scan.filesystem', { root: settings.get('basic.home_root') || '/home', limit: 25 });
        for (const f of fsScan.sensitive) if (!f.ok) add({ id: `fs.${f.path}`, grade: 'critical', title: `${f.path} is too permissive (${f.mode})`, detail: `Expected at most ${f.maxMode}.` });
        if (fsScan.worldWritable.length) add({ id: 'fs.world_writable', grade: 'warning', title: `${fsScan.worldWritable.length} world-writable director${fsScan.worldWritable.length === 1 ? 'y' : 'ies'} under ${fsScan.root}`, detail: fsScan.worldWritable.slice(0, 10).join(', ') });
        else if (fsScan.scanned) add({ id: 'fs.world_writable', grade: 'ok', title: `No world-writable directories found under ${fsScan.root} (depth 3)` });
      });

      await probe('settings', 'panel settings', async () => {
        const min = Number(settings.get('security.min_password_strength')) || 0;
        add(min < 50
          ? { id: 'password.strength', grade: 'warning', title: `Minimum password strength is low (${min})`, detail: 'Raise it to at least 65 to reject weak account and panel passwords.', fix: { label: 'Password Strength Configuration', path: '/security-center/password-strength-configuration' } }
          : { id: 'password.strength', grade: 'ok', title: `Minimum password strength is ${min}` });
        if (!config.tls) add({ id: 'panel.tls', grade: 'warning', title: 'The panel is served over plain HTTP', detail: 'Credentials and session cookies travel unencrypted. Configure WHM_TLS_CERT/WHM_TLS_KEY to serve on port 2087.' });
        else add({ id: 'panel.tls', grade: 'ok', title: 'The panel is served over HTTPS' });
        const fb = await op('sec.fork_bomb.get');
        add(fb.enabled ? { id: 'forkbomb', grade: 'ok', title: 'Shell fork bomb protection is enabled' } : { id: 'forkbomb', grade: 'info', title: 'Shell fork bomb protection is disabled', detail: 'Users with shell access can exhaust process and memory limits.', fix: { label: 'Shell Fork Bomb Protection', path: '/security-center/shell-fork-bomb-protection' } });
        const cc = await op('sec.compiler_access.get');
        if (cc.installed) add(cc.allowed ? { id: 'compilers', grade: 'info', title: 'Compilers are available to all users', detail: 'Exploit kits often need a compiler. Deny access unless accounts need it.', fix: { label: 'Compiler Access', path: '/security-center/compiler-access' } } : { id: 'compilers', grade: 'ok', title: 'Compilers are restricted to privileged users' });
        const shells = stmts.shellAccounts.get().n;
        if (shells > 0) add({ id: 'accounts.shell', grade: 'info', title: `${shells} hosting account${shells === 1 ? ' has' : 's have'} shell access` });
        const p = policy();
        const active = [p.verifiedIpLogin && 'verified-IP login', p.require2faForRoot && '2FA for root', p.require2faForResellers && '2FA for resellers', p.apiTokensRequire2fa && '2FA for API tokens', p.sessionTimeoutMinutes > 0 && 'session timeout', p.disallowConcurrentSessions && 'single session', p.passwordMaxAgeDays > 0 && 'password age'].filter(Boolean);
        if (active.length) add({ id: 'policy.enforced', grade: 'ok', title: `${active.length} login polic${active.length === 1 ? 'y is' : 'ies are'} active (${active.join(', ')})` });
        if (settings.get('security.questions.enabled')) add({ id: 'policy.unenforced', grade: 'warning', title: 'Security questions are enabled but not enforced yet', detail: 'The authentication layer does not read the security.questions settings yet, so they provide no protection today.', fix: { label: 'Security Questions', path: '/security-center/security-questions' } });
      });

      await probe('apache', 'web server hardening', async () => {
        if (!capabilities.has('apache')) return;
        const layout = await detectModsec(true);
        if (!layout.installed) add({ id: 'modsec.installed', grade: 'warning', title: 'ModSecurity is not installed', detail: 'A web application firewall blocks common injection and scanner traffic.', fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
        else {
          const cfg = await op('sec.modsec.get_config');
          add(cfg.effective.SecRuleEngine === 'On' ? { id: 'modsec.engine', grade: 'ok', title: 'ModSecurity rule engine is on' } : { id: 'modsec.engine', grade: 'warning', title: `ModSecurity rule engine is ${cfg.effective.SecRuleEngine || 'Off'}`, fix: { label: 'ModSecurity Configuration', path: '/security-center/modsecurity-configuration' } });
          if (!stmts.vendors.all().some((v) => v.enabled)) add({ id: 'modsec.vendors', grade: 'info', title: 'No ModSecurity vendor rule set is enabled', fix: { label: 'ModSecurity Vendors', path: '/security-center/modsecurity-vendors' } });
        }
        const ud = await op('sec.userdir.get');
        if (ud.enabled) add({ id: 'userdir', grade: 'info', title: 'Apache mod_userdir (~user URLs) is enabled', detail: 'Sites served from ~user URLs share the main IP and bypass per-domain SSL.', fix: { label: 'Apache mod_userdir Tweak', path: '/security-center/apache-mod-userdir-tweak' } });
      });

      // Account vhosts allow .htaccess only Options=Indexes,MultiViews,SymLinksIfOwnerMatch,
      // IncludesNOEXEC (agent web.js DOCROOT_ALLOW_OVERRIDE): a site whose .htaccess still
      // says `Options +FollowSymLinks` or `Options All -Indexes` answers 500 on every URL
      // with only the domain error log saying why.
      await probe('htaccess', '.htaccess Options', async () => {
        if (!capabilities.has('apache')) return;
        const homeRoot = settings.get('basic.home_root') || '/home';
        const roots = new Set();
        for (const a of db.prepare('SELECT a.username, a.home_dir, d.docroot FROM accounts a LEFT JOIN account_domains d ON d.account_id = a.id').all()) {
          const docroot = `${a.home_dir || `${homeRoot}/${a.username}`}/public_html`;
          roots.add(docroot);
          if (a.docroot && a.docroot !== docroot && !a.docroot.startsWith(`${docroot}/`)) roots.add(a.docroot);
        }
        if (!roots.size) return;
        const r = await op('web.htaccess.audit', { roots: [...roots], maxFiles: 2000 });
        const bad = Array.isArray(r.unsupported) ? r.unsupported : [];
        if (!bad.length) { add({ id: 'htaccess.options', grade: 'ok', title: `No .htaccess under ${roots.size} document root(s) sets Options Apache refuses (${r.scanned ?? 0} file(s) checked${r.truncated ? ', scan truncated' : ''})` }); return; }
        const files = [...new Set(bad.map((b) => b.file))];
        add({ id: 'htaccess.options', grade: 'warning', title: `${files.length} .htaccess file(s) set Options Apache refuses for account sites`, detail: [...bad.slice(0, 20).map((b) => `${b.file} line ${b.line}: Options ${b.tokens.join(' ')}`), 'An account .htaccess may set only Indexes, MultiViews, SymLinksIfOwnerMatch and IncludesNOEXEC (the vhost AllowOverride); every directory below such a line answers 500 Internal Server Error. Replace FollowSymLinks with SymLinksIfOwnerMatch and drop All, ExecCGI and Includes.'].join('\n'), files });
      });

      await probe('hostaccess', 'host access control', async () => {
        if (!stmts.hostRules.all().length) add({ id: 'hostaccess', grade: 'info', title: 'No host access rules are defined', detail: 'TCP wrappers can limit SSH and FTP to trusted networks.', fix: { label: 'Host Access Control', path: '/security-center/host-access-control' } });
      });

      const order = { critical: 0, warning: 1, info: 2, ok: 3 };
      findings.sort((a, b) => order[a.grade] - order[b.grade]);
      const summary = { critical: 0, warning: 0, info: 0, ok: 0 };
      for (const f of findings) summary[f.grade]++;
      const { lastInsertRowid } = stmts.insertRun.run(trigger, JSON.stringify(summary), JSON.stringify(findings));
      stmts.pruneRuns.run();
      req?.audit?.({ action: 'security.advisor.scan', args: summary });
      return { id: Number(lastInsertRowid), trigger, finishedAt: new Date().toISOString(), summary, findings };
    },
  };

  return {
    reloadApache,
    policy,
    passwordStrength: passwordPolicy,
    passwordContexts: PASSWORD_CONTEXTS,
    hostAccess, ssh, cphulk, firewall: firewallApi, smtp, compilers, traceroute, forkBomb, wheel, userdir, modsec, externalAuth, advisor, phpAdvisories,
  };
}
