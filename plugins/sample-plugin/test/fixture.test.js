'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pack, validateManifest } = require('../../sdk');
const { buildFixture, PACKAGE, PUBLIC_KEY, PRIVATE_KEY } = require('./build-fixture');

test('the committed signed fixture is what build-fixture produces from the current tree (byte-identical)', async () => {
  assert.ok(fs.existsSync(PACKAGE), 'run `npm run fixtures`');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sample-fixture-')), 'rebuilt.whmplugin');
  const r = await buildFixture({ out });
  assert.ok(fs.readFileSync(out).equals(fs.readFileSync(PACKAGE)), 'fixture is stale: run `npm run fixtures` in plugins/sample-plugin');
  assert.equal(r.signature.file, 'DEV-SIGNATURE.json');
  assert.equal(r.kid, pack.kidOf(fs.readFileSync(PUBLIC_KEY, 'utf8')));
  assert.equal(pack.kidOf(fs.readFileSync(PRIVATE_KEY, 'utf8')), r.kid);
});

test('the fixture unpacks to a valid, developer-signed package without SIGNATURE.json or tests', () => {
  const buf = fs.readFileSync(PACKAGE);
  const names = pack.listPackage(buf).map((e) => e.name);
  assert.ok(names.includes('plugin.json') && names.includes('main.js') && names.includes('DEV-SIGNATURE.json'));
  assert.ok(!names.includes('SIGNATURE.json'));
  assert.ok(!names.some((n) => n.startsWith('test/') || n.startsWith('dist/') || n.startsWith('node_modules/')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-sample-unpack-'));
  pack.unpack(buf, dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.id, 'net.whm.sample-notes');
  const pub = fs.readFileSync(PUBLIC_KEY, 'utf8');
  assert.deepEqual(pack.verifySignatureFile(dir, 'DEV-SIGNATURE.json', pub), { ok: true, kid: pack.kidOf(pub) });
  const sig = pack.readSignature(dir, 'DEV-SIGNATURE.json');
  assert.match(sig.sig, /^[A-Za-z0-9+/]{86}==$/, 'standard base64 with padding');
  // the developer signature excludes both signature files, so a hub SIGNATURE.json leaves it valid
  pack.writeSignature(dir, 'SIGNATURE.json', { kid: 'deadbeef', sig: 'A'.repeat(86) + '==' });
  assert.deepEqual(pack.verifySignatureFile(dir, 'DEV-SIGNATURE.json', pub), { ok: true, kid: pack.kidOf(pub) });
});
