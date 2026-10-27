// Screenshots every page of the panel (all functions from nav.js + core pages) into
// OUT/pages/<category-slug>/<function-slug>.jpg, each stamped with a label bar
// (category › function · live/placeholder · date · commit), and writes gallery
// READMEs that show every screenshot inline.
//
//   BASE=http://127.0.0.1:2086 PASSWORD='<root password>' OUT=docs/screenshots node e2e/screenshot-all.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const BASE = process.env.BASE || 'http://127.0.0.1:2086';
const OUT = path.resolve(process.env.OUT || path.join(__dirname, 'shots'));
const PASSWORD = process.env.PASSWORD;
const QUALITY = Number(process.env.QUALITY || 85);
if (!PASSWORD) { console.error('PASSWORD is required'); process.exit(2); }

const DATE = new Date().toISOString().slice(0, 10);
let SHA = process.env.GIT_SHA || '';
if (!SHA) { try { SHA = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch { SHA = 'working-tree'; } }

const FLOW_SHOTS = [
  ['01-login.png', 'Login'],
  ['02-dashboard.png', 'Home dashboard'],
  ['02-dashboard-full.png', 'Home dashboard (full page)'],
  ['03-create-account-form.png', 'Create a New Account — form'],
  ['04-create-account-result.png', 'Create a New Account — result'],
  ['05-list-accounts.png', 'List Accounts'],
  ['06-service-status.png', 'Service Status'],
  ['07-server-information.png', 'Server Information'],
  ['08-feature-manager.png', 'Feature Manager'],
  ['09-tweak-settings.png', 'Tweak Settings'],
  ['10-wp-toolkit-plugin.png', 'WP Toolkit (bundled plugin page)'],
  ['11-sidebar-search.png', 'Sidebar search'],
  ['12-top-search.png', 'Global search'],
  ['13-restart-service.png', 'Restart HTTP Server (Apache)'],
  ['14-process-manager.png', 'Process Manager'],
  ['15-license-tab.png', 'Basic WebHost Manager Setup — License tab'],
  ['16-manage-plugins-marketplace.png', 'Manage Plugins — Marketplace tab'],
  ['17-whm-marketplace.png', 'WHM Marketplace'],
];

// Stamps a label bar at the top of the rendered page so the screenshot explains itself.
async function stamp(page, text) {
  await page.evaluate((t) => {
    document.getElementById('whm-shot-label')?.remove();
    const el = document.createElement('div');
    el.id = 'whm-shot-label';
    el.textContent = t;
    el.style.cssText = 'position:relative;z-index:1000;background:#0b1117;color:#e6edf3;font:600 13px/1.4 -apple-system,"Segoe UI",Roboto,sans-serif;padding:7px 14px;border-bottom:3px solid #1b8fc9;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const host = document.querySelector('.app') || document.body;
    host.insertBefore(el, host.firstChild);
  }, text);
}

async function pageStatus(page) {
  const placeholder = await page.$('.empty-state');
  if (!placeholder) return 'live';
  const text = await placeholder.textContent();
  const m = text.match(/scheduled for build phase (\d)/);
  return m ? `placeholder · phase ${m[1]}` : 'live';
}

function cell(src, label, status) {
  const badge = status && status.startsWith('placeholder') ? ` <sub>⏳ ${status.replace('placeholder · ', '')}</sub>` : status === 'live' ? ' <sub>✅ live</sub>' : '';
  return `<td align="center" valign="top" width="33%"><a href="${src}"><img src="${src}" width="400" alt="${label}"></a><br><sub><b>${label}</b></sub>${badge}</td>`;
}

function grid(items, perRow = 3) {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(`<tr>${items.slice(i, i + perRow).map(([src, label, status]) => cell(src, label, status)).join('')}</tr>`);
  return `<table>${rows.join('\n')}</table>`;
}

(async () => {
  const { CATEGORIES } = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'nav.js')).href);
  const pagesDir = path.join(OUT, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const failures = [];
  const shot = async (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); await page.screenshot({ path: file, type: 'jpeg', quality: QUALITY }); };
  const settle = async (selector) => {
    try { await page.waitForSelector(selector, { timeout: 8000 }); } catch { /* fall through, still capture */ }
    await page.waitForTimeout(250);
  };
  const tag = (where, status) => `WHM › ${where} · ${status} · ${DATE} · ${SHA}`;

  await page.goto(`${BASE}/login`);
  await settle('#username');
  await stamp(page, tag('Login', 'live'));
  await shot(path.join(pagesDir, '_core', 'login.jpg'));
  await page.fill('#username', 'root');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await settle('.home .kv');
  await stamp(page, tag('Home', 'live'));
  await shot(path.join(pagesDir, '_core', 'home.jpg'));
  for (const [route, sel, name, label] of [['/audit-log', 'tbody tr', 'audit-log', 'Audit log'], ['/change-password', '.password-input', 'change-password', 'Change password']]) {
    await page.goto(`${BASE}${route}`); await settle(sel); await stamp(page, tag(label, 'live')); await shot(path.join(pagesDir, '_core', `${name}.jpg`));
  }

  const statuses = {};
  let count = 0;
  let live = 0;
  for (const cat of CATEGORIES) {
    for (const fn of cat.functions) {
      try {
        await page.goto(`${BASE}${fn.path}`, { waitUntil: 'domcontentloaded' });
        await settle('.page-header');
        const status = await pageStatus(page);
        statuses[fn.key] = status;
        if (status === 'live') live++;
        await stamp(page, tag(`${cat.label} › ${fn.label}`, status));
        await shot(path.join(pagesDir, cat.slug, `${fn.slug}.jpg`));
        count++;
      } catch (err) {
        failures.push(`${fn.key}: ${err.message.split('\n')[0]}`);
      }
    }
    process.stdout.write(`${cat.label}: ${cat.functions.length}\n`);
  }
  await browser.close();

  // Gallery of every page, grouped by category, images inline.
  const pagesReadme = ['# Every page', '', `Captured ${DATE} at commit \`${SHA}\` with \`e2e/screenshot-all.cjs\` (1280×800). **${live} of ${count} function pages are live**; the rest show the placeholder for their build phase. Each image carries its label bar. Click any thumbnail for full size.`, '', '## Core pages', '',
    grid([['_core/login.jpg', 'Login', 'live'], ['_core/home.jpg', 'Home', 'live'], ['_core/audit-log.jpg', 'Audit log', 'live'], ['_core/change-password.jpg', 'Change password', 'live']]), ''];
  for (const cat of CATEGORIES) {
    const liveCount = cat.functions.filter((f) => statuses[f.key] === 'live').length;
    pagesReadme.push(`## ${cat.index}. ${cat.label} — ${liveCount}/${cat.functions.length} live`, '', grid(cat.functions.map((f) => [`${cat.slug}/${f.slug}.jpg`, f.label, statuses[f.key] || 'live'])), '');
  }
  fs.writeFileSync(path.join(pagesDir, 'README.md'), pagesReadme.join('\n'));

  // Top-level gallery: the flow screenshots inline + link to every page.
  const flow = FLOW_SHOTS.filter(([file]) => fs.existsSync(path.join(OUT, file))).map(([file, label]) => [file, label, null]);
  const topReadme = ['# Screenshots', '', `Updated ${DATE} at commit \`${SHA}\`. All images are captured automatically (Playwright) against the built interface served by the API, and each carries a label bar naming the screen, whether it is live or a placeholder, the date and the commit. They are regenerated at every milestone (\`e2e/screenshots.sh\`).`, '',
    `- **[Every page →](pages/README.md)** — all 212 function pages grouped by category (${live}/${count} live) plus core pages.`, '', '## Flow', '', 'Login → dashboard → creating an account through the form → lists, status pages, configuration and search.', '', grid(flow, 2), '',
    '## Regenerate', '', '```bash', "BASE=http://127.0.0.1:2086 PASSWORD='<root password>' bash e2e/screenshots.sh   # flow shots + every page + galleries", '```', ''];
  fs.writeFileSync(path.join(OUT, 'README.md'), topReadme.join('\n'));

  console.log(`captured ${count} function pages (${live} live) into ${pagesDir}`);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' -', f)); process.exitCode = 1; }
})().catch((e) => { console.error('screenshot-all failed:', e); process.exit(1); });
