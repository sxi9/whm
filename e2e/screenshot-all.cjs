// Screenshots every page of the panel (all functions from nav.js + core pages) into
// OUT/pages/<category-slug>/<function-slug>.jpg and writes an index README.
//
//   BASE=http://127.0.0.1:2086 PASSWORD='<root password>' OUT=docs/screenshots node e2e/screenshot-all.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const BASE = process.env.BASE || 'http://127.0.0.1:2086';
const OUT = path.resolve(process.env.OUT || path.join(__dirname, 'shots'));
const PASSWORD = process.env.PASSWORD;
const QUALITY = Number(process.env.QUALITY || 85);
if (!PASSWORD) { console.error('PASSWORD is required'); process.exit(2); }

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

  await page.goto(`${BASE}/login`);
  await settle('#username');
  await shot(path.join(pagesDir, '_core', 'login.jpg'));
  await page.fill('#username', 'root');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await settle('.home .kv');
  await shot(path.join(pagesDir, '_core', 'home.jpg'));
  for (const [route, sel, name] of [['/audit-log', 'tbody tr', 'audit-log'], ['/change-password', '.password-input', 'change-password']]) {
    await page.goto(`${BASE}${route}`); await settle(sel); await shot(path.join(pagesDir, '_core', `${name}.jpg`));
  }

  let count = 0;
  for (const cat of CATEGORIES) {
    for (const fn of cat.functions) {
      try {
        await page.goto(`${BASE}${fn.path}`, { waitUntil: 'domcontentloaded' });
        await settle('.page-header');
        await shot(path.join(pagesDir, cat.slug, `${fn.slug}.jpg`));
        count++;
      } catch (err) {
        failures.push(`${fn.key}: ${err.message.split('\n')[0]}`);
      }
    }
    process.stdout.write(`${cat.label}: ${cat.functions.length}\n`);
  }
  await browser.close();

  const lines = ['# All pages', '', `Captured ${new Date().toISOString().slice(0, 10)} with \`e2e/screenshot-all.cjs\` at 1280×800: ${count} function pages across ${CATEGORIES.length} categories, plus core pages. Functions without a dedicated screen yet show the phase placeholder.`, '', '## Core', '', '- [Login](_core/login.jpg) · [Home](_core/home.jpg) · [Audit log](_core/audit-log.jpg) · [Change password](_core/change-password.jpg)', ''];
  for (const cat of CATEGORIES) {
    lines.push(`## ${cat.index}. ${cat.label}`, '');
    for (const fn of cat.functions) lines.push(`- [${fn.label}](${cat.slug}/${fn.slug}.jpg)`);
    lines.push('');
  }
  fs.writeFileSync(path.join(pagesDir, 'README.md'), lines.join('\n'));
  console.log(`captured ${count} function pages into ${pagesDir}`);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log(' -', f)); process.exitCode = 1; }
})().catch((e) => { console.error('screenshot-all failed:', e); process.exit(1); });
