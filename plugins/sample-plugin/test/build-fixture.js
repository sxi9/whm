'use strict';

// Regenerates the signed fixture package U2 (hub upload tests) and U5 (panel
// install tests) consume:
//   test/fixtures/dev.pem / dev.pub              fixture developer key (created once, then committed)
//   test/fixtures/sample-notes-signed.whmplugin  this plugin, packed with DEV-SIGNATURE.json from that key
// Packing is deterministic and Ed25519 is deterministic, so re-running on an
// unchanged tree yields identical bytes; fixture.test.js asserts that.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { pack } = require('../../sdk');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const PRIVATE_KEY = path.join(FIXTURES, 'dev.pem');
const PUBLIC_KEY = path.join(FIXTURES, 'dev.pub');
const PACKAGE = path.join(FIXTURES, 'sample-notes-signed.whmplugin');

function ensureKey() {
  if (fs.existsSync(PRIVATE_KEY) && fs.existsSync(PUBLIC_KEY)) return { privateKeyPem: fs.readFileSync(PRIVATE_KEY, 'utf8'), publicKeyPem: fs.readFileSync(PUBLIC_KEY, 'utf8') };
  const kp = pack.generateKeyPair();
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY, kp.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY, kp.publicKeyPem, { mode: 0o644 });
  return kp;
}

async function buildFixture({ out = PACKAGE } = {}) {
  const key = ensureKey();
  const { buildPlugin } = await import(pathToFileURL(path.resolve(PLUGIN_DIR, '..', '..', 'scripts', 'build-plugin.js')).href);
  const result = buildPlugin({ dir: PLUGIN_DIR, out, sign: PRIVATE_KEY, dev: true, kid: null, exclude: ['dist/'], includeTests: false });
  return { ...result, publicKeyPem: key.publicKeyPem, kid: pack.kidOf(key.publicKeyPem) };
}

module.exports = { buildFixture, ensureKey, PLUGIN_DIR, FIXTURES, PRIVATE_KEY, PUBLIC_KEY, PACKAGE };

// `node --test` runs every file under test/ as a main module; NODE_TEST_CONTEXT
// marks that case so the fixture is only rebuilt when invoked directly.
if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  buildFixture().then((r) => {
    console.log(`${r.out}\n  sha256 ${r.sha256}\n  digest ${r.digest}\n  kid    ${r.kid}\n  entries ${r.entries.length}`);
  }).catch((err) => { console.error(err); process.exit(1); });
}
