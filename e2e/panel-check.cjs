// Drives the account panel (/panel) end to end against a served build (design §7.4):
// root creates a hosting account and its panel login, the account user signs in and
// visits every panel function, the file and cron APIs are exercised through the
// §4 contract, then root opens the account through "Log in as". Console errors,
// page errors and 5xx responses fail the run.
//
// Usage: BASE=http://127.0.0.1:2086 PASSWORD='<root password>' node e2e/panel-check.cjs
// (needs the built client served by the API with the /panel routes wired, and playwright installed)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:2086';
const OUT = process.env.OUT || path.join(__dirname, 'shots', 'panel');
const PASSWORD = process.env.PASSWORD || 'Sm0ke-Test-Passw0rd!';
const USER_PASSWORD = process.env.PANEL_USER_PASSWORD || 'Demo-Panel-Passw0rd!7';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const note = (...args) => console.log(...args);

async function csrfOf(page) {
  const res = await page.request.get(`${BASE}/api/auth/csrf`);
  return (await res.json()).data.csrfToken;
}

// JSON call through the browser's session cookies, with the CSRF token every mutation needs.
async function call(page, method, url, body) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = await csrfOf(page);
  const opts = { headers };
  if (body !== undefined) { opts.data = body; headers['Content-Type'] = 'application/json'; }
  const res = await page.request.fetch(`${BASE}${url}`, { method, ...opts });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status(), body: json };
}

async function login(page, username, password) {
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('#username');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
}

async function logout(page) {
  await call(page, 'POST', '/api/auth/logout', {});
  await page.context().clearCookies();
}

(async () => {
  const { PANEL_FUNCTIONS, PANEL_CATEGORIES } = await import('../client/src/panel/nav.js');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The SPA probes /api/auth/me before login (401) and the panel probes features that may answer 403/501 on a bare host; those are not errors.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|423|501)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500 && r.status() !== 501) errors.push(`http ${r.status()} ${r.url()}`); });
  const shot = async (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

  const suffix = Date.now().toString(36).slice(-5);
  const username = `demo${suffix}`;
  const domain = `${username}.example.com`;

  // 1. root creates the hosting account and its panel login (§4.15).
  await login(page, 'root', PASSWORD);
  await page.waitForSelector('.home', { timeout: 15000 });
  const created = await call(page, 'POST', '/api/accounts', { username, domain, password: USER_PASSWORD, contactEmail: `owner@${domain}` });
  if (created.status !== 201) throw new Error(`account create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const linked = await call(page, 'POST', `/api/panel/admin/accounts/${username}/user`, { password: USER_PASSWORD });
  if (![200, 201].includes(linked.status)) throw new Error(`panel user link failed: ${linked.status} ${JSON.stringify(linked.body)}`);
  const status = await call(page, 'GET', `/api/panel/admin/accounts/${username}/user`);
  note('panel user:', status.status, JSON.stringify(status.body?.data || status.body));
  // An admin without "Log in as" has no business on the panel (§3.1).
  const scopeless = await call(page, 'GET', '/api/panel/me');
  if (scopeless.status !== 403) errors.push(`expected 403 for admin /api/panel/me without acting-as, got ${scopeless.status}`);
  await logout(page);

  // 2. the account user signs in and lands on /panel.
  await login(page, username, USER_PASSWORD);
  await page.waitForSelector('.panel-home', { timeout: 20000 });
  if (!page.url().startsWith(`${BASE}/panel`)) errors.push(`account user landed on ${page.url()} instead of /panel`);
  await page.waitForSelector('.panel-meters .stat');
  await shot('01-panel-home');
  const me = await call(page, 'GET', '/api/panel/me');
  if (me.status !== 200 || me.body?.data?.account?.username !== username) errors.push(`/api/panel/me as the account user: ${me.status} ${JSON.stringify(me.body)}`);
  const forbidden = await call(page, 'GET', '/api/accounts');
  if (forbidden.status !== 403) errors.push(`role user reached /api/accounts: ${forbidden.status}`);

  // 3. every panel function path renders its page header.
  let visited = 0;
  for (const fn of PANEL_FUNCTIONS) {
    await page.goto(`${BASE}${fn.path}`);
    await page.waitForSelector('.page-header h1', { timeout: 15000 });
    const h1 = (await page.textContent('.page-header h1')).trim();
    if (!h1) errors.push(`${fn.path}: empty title`);
    visited += 1;
  }
  note('visited panel function pages:', visited, 'of', PANEL_FUNCTIONS.length);
  for (const cat of PANEL_CATEGORIES) {
    await page.goto(`${BASE}${cat.functions[0].path}`);
    await page.waitForSelector('.page-header h1');
    await shot(`10-group-${cat.slug}`);
  }
  await page.goto(`${BASE}/panel/overview/account`);
  await page.waitForSelector('.kv');
  await shot('02-account-details');

  // 4. file manager API (§4.5): create and delete a folder as the account.
  const mk = await call(page, 'POST', '/api/panel/files/mkdir', { path: `public_html/e2e-${suffix}` });
  if (mk.status === 201 || mk.status === 200) {
    const rm = await call(page, 'DELETE', '/api/panel/files', { paths: [`public_html/e2e-${suffix}`] });
    if (![200, 202].includes(rm.status)) errors.push(`files delete: ${rm.status} ${JSON.stringify(rm.body)}`);
    note('file manager: folder created and removed');
  } else if (mk.status === 501 || mk.status === 403) {
    note('file manager: not available on this host', mk.status, mk.body?.error?.code);
  } else errors.push(`files mkdir: ${mk.status} ${JSON.stringify(mk.body)}`);

  // 5. cron (§4.9): the crontab is readable or the host reports the missing binary.
  const cron = await call(page, 'GET', '/api/panel/cron');
  if (cron.status === 200) {
    const put = await call(page, 'PUT', '/api/panel/cron', { env: [], jobs: [{ schedule: '@daily', command: `/bin/true # e2e-${suffix}` }] });
    if ([200, 422].includes(put.status)) note('cron: write answered', put.status, put.body?.error?.code || 'ok');
    else errors.push(`cron write: ${put.status} ${JSON.stringify(put.body)}`);
    await call(page, 'DELETE', '/api/panel/cron');
  } else if ([501, 403].includes(cron.status)) note('cron: not available on this host', cron.status, cron.body?.error?.code);
  else errors.push(`cron read: ${cron.status} ${JSON.stringify(cron.body)}`);

  // 6. the user menu signs out; a cross-shell route is refused for role user.
  await page.goto(`${BASE}/account-information/list-accounts`);
  await page.waitForTimeout(800);
  if (!page.url().startsWith(`${BASE}/panel`) && !page.url().includes('/login')) errors.push(`role user reached the admin shell at ${page.url()}`);
  await logout(page);

  // 7. "Log in as" from root opens /panel with the acting-as banner (§2.4).
  await login(page, 'root', PASSWORD);
  await page.waitForSelector('.home', { timeout: 15000 });
  const acting = await call(page, 'POST', `/api/panel/admin/login-as/${username}`, {});
  if (acting.status !== 200) errors.push(`login-as: ${acting.status} ${JSON.stringify(acting.body)}`);
  await page.goto(`${BASE}/panel`);
  await page.waitForSelector('.panel-acting-banner', { timeout: 15000 });
  const banner = await page.textContent('.panel-acting-banner');
  if (!banner.includes(username) || !banner.includes('root')) errors.push(`acting banner text: ${banner}`);
  await shot('03-login-as-banner');
  await page.click('.panel-acting-banner button');
  await page.waitForURL((u) => !u.pathname.startsWith('/panel'), { timeout: 15000 });
  const after = await call(page, 'GET', '/api/panel/me');
  if (after.status !== 403) errors.push(`acting-as still active after Exit: ${after.status}`);

  // 8. cleanup.
  const del = await call(page, 'DELETE', `/api/accounts/${username}`);
  note(`cleanup account ${username}:`, del.status);

  await browser.close();
  note('screenshots in', OUT);
  if (errors.length) { console.log('ERRORS:'); for (const e of errors) console.log(' -', e); process.exitCode = 1; } else console.log('no page/console/5xx errors');
})().catch((e) => { console.error('panel check failed:', e); process.exit(1); });
