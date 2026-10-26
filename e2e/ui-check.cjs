// Drives the built SPA (served by the API) through the main flows and saves screenshots.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:2086';
const OUT = process.env.OUT || path.join(__dirname, 'shots');
// Usage: BASE=http://127.0.0.1:2086 PASSWORD='<root password>' node e2e/ui-check.cjs  (needs the built client served by the API and playwright installed)
const PASSWORD = process.env.PASSWORD || 'Sm0ke-Test-Passw0rd!';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`http ${r.status()} ${r.url()}`); });
  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

  await page.goto(`${BASE}/login`);
  await page.waitForSelector('#username');
  await shot('01-login');

  await page.fill('#username', 'root');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.home', { timeout: 15000 });
  await page.waitForSelector('.kv', { timeout: 15000 });
  await shot('02-dashboard');
  await page.screenshot({ path: path.join(OUT, '02-dashboard-full.png'), fullPage: true });

  // Create an account through the real form (unique domain per run; removed at the end).
  const suffix = Date.now().toString(36).slice(-5);
  const domain = `demo${suffix}.example.com`;
  await page.goto(`${BASE}/account-functions/create-a-new-account`);
  await page.waitForSelector('input[placeholder="example.com"]');
  await page.fill('input[placeholder="example.com"]', domain);
  await page.fill('input[placeholder="owner@example.com"]', `owner@${domain}`);
  const pw = page.locator('.password-input input');
  await pw.fill('Demo-Site-Passw0rd!9');
  await shot('03-create-account-form');
  await page.click('button[type=submit]:has-text("Create")');
  await page.waitForSelector('text=Account created', { timeout: 20000 });
  await shot('04-create-account-result');

  await page.goto(`${BASE}/account-information/list-accounts`);
  await page.waitForSelector('tbody tr');
  await shot('05-list-accounts');

  await page.goto(`${BASE}/server-status/service-status`);
  await page.waitForSelector('tbody tr');
  await shot('06-service-status');

  await page.goto(`${BASE}/server-status/server-information`);
  await page.waitForSelector('.stat-grid');
  await shot('07-server-information');

  await page.goto(`${BASE}/packages/feature-manager`);
  await page.waitForSelector('.toggle');
  await shot('08-feature-manager');

  await page.goto(`${BASE}/server-configuration/tweak-settings`);
  await page.waitForSelector('.toggle');
  await shot('09-tweak-settings');

  // A function whose screen is still scheduled for a later phase renders the placeholder.
  await page.goto(`${BASE}/plugins/wp-toolkit`);
  await page.waitForSelector('.empty-state');
  await shot('10-generic-function-page');

  // Sidebar search + top search.
  await page.fill('#sidebar-search', 'ssl');
  await page.waitForTimeout(200);
  await shot('11-sidebar-search');
  await page.fill('#sidebar-search', '');
  await page.fill('.topbar-search input', 'restart apache');
  await page.waitForSelector('.search-results li');
  await shot('12-top-search');
  await page.keyboard.press('Enter');
  await page.waitForSelector('text=Restart HTTP Server (Apache)');
  await shot('13-restart-service');

  await page.goto(`${BASE}/system-health/process-manager`);
  await page.waitForSelector('tbody tr');
  await shot('14-process-manager');

  // Count sidebar entries after expanding all.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.sidebar-tools');
  await page.click('.sidebar-tools button:has-text("Expand all")');
  const count = await page.locator('.nav-category li a').count();
  console.log('sidebar function links:', count);

  // Clean up the account created above via the API (same session cookies).
  const csrf = (await (await page.request.get(`${BASE}/api/auth/csrf`)).json()).data.csrfToken;
  const del = await page.request.delete(`${BASE}/api/accounts/demo${suffix}`, { headers: { 'X-CSRF-Token': csrf } });
  console.log('cleanup account demo' + suffix + ':', del.status());

  await browser.close();
  console.log('screenshots in', OUT);
  if (errors.length) { console.log('ERRORS:'); for (const e of errors) console.log(' -', e); process.exitCode = 1; } else console.log('no page/console/5xx errors');
})().catch((e) => { console.error('UI check failed:', e); process.exit(1); });
