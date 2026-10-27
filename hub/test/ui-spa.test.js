import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHub } from './support.js';
import { uiDistDir, isSpaPath } from '../src/app.js';

// hub/ui/dist is served at "/" with an SPA fallback when serve_ui is set
// (build plan U3). The test uses its own dist directory through
// WHM_HUB_UI_DIST so it never depends on a prior `vite build`.
function fakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-ui-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>WHM Hub</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("hub ui")');
  return dir;
}

test('serve_ui: index.html for portal routes, static assets, API and health untouched', async () => {
  const dist = fakeDist();
  process.env.WHM_HUB_UI_DIST = dist;
  const hub = await bootHub({ config: { serve_ui: true } });
  try {
    assert.equal(uiDistDir(hub.ctx.config), dist);
    // Reverse-DNS route params (plugin / catalog ids such as net.acme.js) are
    // not files: a direct open or refresh must still get the SPA.
    for (const route of ['/', '/login', '/admin', '/admin/licenses/lic_01ABC', '/reseller/statement', '/dev/plugins/net.acme.x/versions/1.0.0', '/dev/verify-email', '/dev/plugins/net.acme.js', '/dev/plugins/com.foo.txt/versions', '/admin/market/catalog/org.bar.json', '/admin/market/developers/dev_01.html']) {
      const res = await hub.http.get(route);
      assert.equal(res.status, 200, route);
      assert.match(res.headers['content-type'], /text\/html/, route);
      assert.match(res.text, /id="root"/, route);
      assert.equal(res.headers['cache-control'], 'no-store', route);
    }
    const asset = await hub.http.get('/assets/index-abc123.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /javascript/);
    assert.match(asset.headers['cache-control'], /max-age=3600/);
    // Files that do not exist are not answered with index.html (no broken asset masquerading as a page).
    const missingFile = await hub.http.get('/assets/nope.js');
    assert.equal(missingFile.status, 404);
    assert.doesNotMatch(missingFile.text, /id="root"/);
    for (const file of ['/favicon.ico', '/robots.txt', '/manifest.webmanifest', '/admin.js', '/loginx.html']) {
      const res = await hub.http.get(file);
      assert.equal(res.status, 404, file);
      assert.doesNotMatch(res.text || '', /id="root"/, file);
    }
    // The API keeps its JSON envelopes under the SPA.
    const api404 = await hub.http.get('/v1/nope');
    assert.equal(api404.status, 404);
    assert.equal(api404.body.error.code, 'not_found');
    const health = await hub.http.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.ok, true);
    const me = await hub.http.get('/v1/portal/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, 'unauthorized');
    // A POST to a portal route is not an SPA fallback.
    const post = await hub.http.post('/admin/licenses').send({});
    assert.notEqual(post.status, 200);
    assert.doesNotMatch(post.text || '', /id="root"/);
  } finally {
    delete process.env.WHM_HUB_UI_DIST;
    await hub.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('isSpaPath: SPA prefixes win over a file-like last segment; elsewhere extensions mean files', () => {
  for (const p of ['/', '/login', '/admin', '/admin/', '/reseller/licenses/lic_1', '/dev/plugins/net.acme.js', '/dev/plugins/com.foo.txt/versions/1.0.0', '/admin/market/catalog/org.bar.json', '/dev/verify-email', '/pricing']) assert.equal(isSpaPath(p), true, p);
  for (const p of ['/assets/index-abc.js', '/assets/nope.css', '/favicon.ico', '/robots.txt', '/admin.js', '/adminx/net.acme.js', '/loginx.html', '/devs/a.json']) assert.equal(isSpaPath(p), false, p);
});

test('serve_ui off: portal routes are not served and the API is unchanged', async () => {
  const dist = fakeDist();
  process.env.WHM_HUB_UI_DIST = dist;
  const hub = await bootHub({ config: { serve_ui: false } });
  try {
    const res = await hub.http.get('/admin');
    assert.equal(res.status, 404);
    assert.doesNotMatch(res.text, /id="root"/);
    const api404 = await hub.http.get('/v1/nope');
    assert.equal(api404.body.error.code, 'not_found');
  } finally {
    delete process.env.WHM_HUB_UI_DIST;
    await hub.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('serve_ui with a missing dist only warns and keeps the API up', async () => {
  process.env.WHM_HUB_UI_DIST = path.join(os.tmpdir(), `whm-hub-ui-missing-${process.pid}`);
  const hub = await bootHub({ config: { serve_ui: true } });
  try {
    const res = await hub.http.get('/admin');
    assert.equal(res.status, 404);
    const health = await hub.http.get('/healthz');
    assert.equal(health.status, 200);
  } finally {
    delete process.env.WHM_HUB_UI_DIST;
    await hub.close();
  }
});

test('the real hub/ui/dist, when built, carries the SPA entry the fallback serves', () => {
  const real = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/dist/index.html');
  if (!fs.existsSync(real)) { assert.ok(true, 'hub/ui/dist not built in this checkout'); return; }
  assert.match(fs.readFileSync(real, 'utf8'), /id="root"/);
});
