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
const DATE = new Date().toISOString().slice(0, 10);
let SHA = process.env.GIT_SHA || '';
if (!SHA) { try { SHA = require('child_process').execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { SHA = 'working-tree'; } }
const LABELS = {
  '02a-setup-wizard': 'First-run setup wizard (new servers)',
  '01-login': 'Login', '02-dashboard': 'Home dashboard', '03-create-account-form': 'Create a New Account — form', '04-create-account-result': 'Create a New Account — result',
  '05-list-accounts': 'List Accounts', '06-service-status': 'Service Status', '07-server-information': 'Server Information', '08-feature-manager': 'Feature Manager',
  '09-tweak-settings': 'Tweak Settings', '10-wp-toolkit-plugin': 'WP Toolkit (bundled plugin page)', '11-sidebar-search': 'Sidebar search',
  '12-top-search': 'Global search', '13-restart-service': 'Restart HTTP Server (Apache)', '14-process-manager': 'Process Manager',
  '15-license-tab': 'Basic WebHost Manager Setup — License tab', '16-manage-plugins-marketplace': 'Manage Plugins — Marketplace tab', '17-whm-marketplace': 'WHM Marketplace',
  '18-application-manager': 'Application Manager', '19-runtime-versions': 'Runtime Versions', '20-application-templates': 'Application Templates',
  '21-modify-account-domains': 'Modify an Account — Domains panel', '22-manage-ssl-hosts': 'Manage SSL Hosts — Server hostname card',
  '23-multiphp-manager': 'MultiPHP Manager — Install a PHP version', '24-install-distro-packages': 'Install Distro Packages — Catalog tab',
  '24b-install-distro-packages-search': 'Install Distro Packages — Search repositories tab', '25-contact-manager': 'Contact Manager — Security notifications',
  '26-security-advisor': 'Security Advisor — Hardening card', '27-backup-configuration': 'Backup Configuration — Cloud storage',
};
// Stamps a label bar at the top of the page so the screenshot explains itself.
async function stamp(page, text) {
  await page.evaluate((t) => {
    document.getElementById('whm-shot-label')?.remove();
    const el = document.createElement('div');
    el.id = 'whm-shot-label';
    el.textContent = t;
    el.style.cssText = 'position:relative;z-index:1000;background:#0b1117;color:#e6edf3;font:600 13px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:7px 14px;border-bottom:3px solid #1b8fc9;letter-spacing:.01em';
    const host = document.querySelector('.app') || document.body;
    host.insertBefore(el, host.firstChild);
  }, text);
}
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The SPA probes /api/auth/me before login; that 401 is expected, not an error.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`http ${r.status()} ${r.url()}`); });
  // fullPage for the pages whose card of interest sits below the first screen.
  const shot = async (name, { fullPage = false } = {}) => { await stamp(page, `WHM › ${LABELS[name] || name} · ${DATE} · ${SHA}`); await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage }); };

  await page.goto(`${BASE}/login`);
  await page.waitForSelector('#username');
  await shot('01-login');

  await page.fill('#username', 'root');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  // A fresh database sends root to the first-run setup wizard; capture it, then skip it.
  await page.waitForSelector('.setup-steps, .home', { timeout: 30000 });
  if (await page.$('.setup-steps')) {
    await page.waitForTimeout(400);
    await shot('02a-setup-wizard');
    await page.click('button:has-text("Skip for now")');
    await page.waitForSelector('.home', { timeout: 15000 });
  }
  await page.waitForSelector('.kv', { timeout: 15000 });
  await shot('02-dashboard');
  await stamp(page, `WHM › Home dashboard (full page) · ${DATE} · ${SHA}`);
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

  // Every function is live; the Plugins category pages render bundled SDK plugins through the host.
  await page.goto(`${BASE}/plugins/wp-toolkit`);
  await page.waitForSelector('.page-header h1');
  await page.waitForTimeout(500);
  await shot('10-wp-toolkit-plugin');

  // Sidebar search + top search.
  await page.fill('#sidebar-search', 'ssl');
  await page.waitForTimeout(200);
  await shot('11-sidebar-search');
  await page.fill('#sidebar-search', '');
  await page.fill('.topbar-search input', 'restart apache');
  await page.waitForSelector('.search-results li');
  await shot('12-top-search');
  await page.keyboard.press('Enter');
  // The page shows an Install prompt instead of the Restart action while Apache is absent (dev container).
  await page.waitForSelector('.page-header h1:has-text("HTTP Server (Apache)")');
  await shot('13-restart-service');

  await page.goto(`${BASE}/system-health/process-manager`);
  await page.waitForSelector('tbody tr');
  await shot('14-process-manager');

  // Phase 5: license tab, marketplace tab and the WHM Marketplace catalog page.
  await page.goto(`${BASE}/server-configuration/basic-webhost-manager-setup#license`);
  await page.waitForSelector('.page-header h1');
  await page.waitForTimeout(600);
  await shot('15-license-tab');
  await page.goto(`${BASE}/cpanel/manage-plugins#marketplace`);
  await page.waitForSelector('.page-header h1');
  await page.waitForTimeout(600);
  await shot('16-manage-plugins-marketplace');
  await page.goto(`${BASE}/server-configuration/whm-marketplace`);
  await page.waitForSelector('.page-header h1');
  await page.waitForTimeout(600);
  await shot('17-whm-marketplace');

  // Application Manager (category 31): the three pages degrade to install prompts here.
  for (const [n, slug] of [['18', 'application-manager'], ['19', 'runtime-versions'], ['20', 'application-templates']]) {
    await page.goto(`${BASE}/application-manager/${slug}`);
    await page.waitForSelector('.page-header h1');
    await page.waitForTimeout(600);
    await shot(`${n}-${slug}`);
  }

  // Issue-2 round pages. Every wait names an element that exists on a host without the
  // daemons (the card, or the install prompt the page shows instead of an action).
  await page.goto(`${BASE}/account-functions/modify-an-account?username=demo${suffix}`);
  await page.waitForSelector('.domains-panel h3:has-text("Domains")', { timeout: 20000 });
  await page.waitForSelector('.domains-panel tbody tr, .domains-panel .banner', { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('21-modify-account-domains', { fullPage: true });

  await page.goto(`${BASE}/ssl-tls/manage-ssl-hosts`);
  await page.waitForSelector('h2:has-text("Server hostname"), .capability-notice', { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('22-manage-ssl-hosts');

  await page.goto(`${BASE}/software/multiphp-manager`);
  await page.waitForSelector('h2:has-text("Install a PHP version")', { timeout: 30000 });
  await page.waitForSelector('h2:has-text("Install a PHP version") ~ * table, h2:has-text("Install a PHP version") ~ * .capability-notice, .card:has(h2:has-text("Install a PHP version")) table, .card:has(h2:has-text("Install a PHP version")) .capability-notice', { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot('23-multiphp-manager');

  // The Catalog tab is the default; typing into the repository search needs its own tab first.
  await page.goto(`${BASE}/software/install-distro-packages`);
  await page.waitForSelector('[role=tab][aria-selected="true"]:has-text("Catalog")', { timeout: 20000 });
  await page.waitForSelector('.catalog-group, .capability-notice', { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot('24-install-distro-packages');
  await page.click('[role=tab]:has-text("Search repositories")');
  await page.waitForSelector('input[placeholder^="Package name"]', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('24b-install-distro-packages-search');

  await page.goto(`${BASE}/server-contacts/contact-manager`);
  await page.waitForSelector('h2:has-text("Security notifications")', { timeout: 20000 });
  await page.waitForSelector('.card:has(h2:has-text("Security notifications")) .toggle, .card:has(h2:has-text("Security notifications")) .banner', { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('25-contact-manager', { fullPage: true });

  // Hardening: every item reads "not applied" / "not applicable" on this container, never a 501.
  await page.goto(`${BASE}/security-center/security-advisor`);
  await page.waitForSelector('h2:has-text("Hardening")', { timeout: 20000 });
  await page.waitForSelector('.card:has(h2:has-text("Hardening")) tbody tr', { timeout: 30000 });
  await page.waitForTimeout(400);
  await shot('26-security-advisor');

  await page.goto(`${BASE}/backup/backup-configuration`);
  await page.waitForSelector('h2:has-text("Cloud storage")', { timeout: 20000 });
  await page.waitForSelector('.card:has(h2:has-text("Cloud storage")) .capability-notice, .card:has(h2:has-text("Cloud storage")) .provider-cards, .card:has(h2:has-text("Cloud storage")) .card-body > *', { timeout: 20000 });
  await page.waitForTimeout(400);
  await shot('27-backup-configuration', { fullPage: true });

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
