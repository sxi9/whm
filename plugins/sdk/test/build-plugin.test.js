'use strict';

// scripts/build-plugin.js (ESM) against the SDK packer: argument parsing, the
// signature-file rules, developer/operator signing and the private-key refusal.
// Also pins the shape of the SDK entry point the panel hands to plugins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const pack = require('../pack');
const sdk = require('../index');
const { minimalManifest } = require('./fixtures');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-plugin.js');
const SERVER_SDK_LIB = path.join(REPO_ROOT, 'server', 'src', 'lib', 'plugin-sdk.js');

const tmp = (prefix = 'whm-build-plugin-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
function plugin(dir, extra = {}, manifest = minimalManifest({ id: 'net.example.built' })) {
  return writeTree(dir, {
    'plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'main.js': "'use strict';\nmodule.exports = { async activate(ctx) { ctx.log.info('hi'); } };\n",
    'README.md': '# built\n',
    'test/main.test.js': 'test\n',
    ...extra,
  });
}
const load = () => import(pathToFileURL(SCRIPT).href);

test('the SDK entry point exposes pack to tooling but not to the enumerable exports the panel freezes for plugins', async () => {
  assert.equal(sdk.pack, pack, 'require("plugins/sdk").pack is the packer');
  const { pack: destructured } = require('../index');
  assert.equal(destructured, pack);
  assert.ok(!Object.keys(sdk).includes('pack'));
  assert.equal(({ ...sdk }).pack, undefined, 'the spread copy the host builds (`{ ...sdk.index }`) carries no pack');
  assert.equal(Object.getOwnPropertyDescriptor(sdk, 'pack').enumerable, false);
  for (const key of ['validateManifest', 'createMockHost', 'PluginError', 'semver', 'cron', 'SDK_VERSION']) assert.ok(key in { ...sdk }, key);
  if (fs.existsSync(SERVER_SDK_LIB)) {
    const { loadPluginSdk } = await import(pathToFileURL(SERVER_SDK_LIB).href);
    const hostSdk = loadPluginSdk(REPO_ROOT);
    assert.ok(hostSdk && hostSdk.index, 'the host loads plugins/sdk/index.js');
    assert.equal(({ ...hostSdk.index }).pack, undefined, 'what the host hands plugins (services/plugins.js createPluginHost) has no pack');
    assert.equal(typeof ({ ...hostSdk.index }).validateManifest, 'function');
  }
});

test('parseArgs: every option, --dev needs --sign, --kid is validated, unknown options are refused', async () => {
  const { parseArgs } = await load();
  const o = parseArgs(['dir', '--out', 'o.whmplugin', '--sign', 'k.pem', '--dev', '--kid', 'abcd1234', '--exclude', 'dist/', '--exclude', '*.log', '--include-tests', '--allow-secrets', '--json']);
  assert.deepEqual(o, { dir: 'dir', out: 'o.whmplugin', sign: 'k.pem', dev: true, kid: 'abcd1234', exclude: ['dist/', '*.log'], includeTests: true, allowSecrets: true, json: true });
  assert.deepEqual(parseArgs(['d']), { dir: 'd', out: null, sign: null, dev: false, kid: null, exclude: [], includeTests: false, allowSecrets: false, json: false });
  assert.throws(() => parseArgs(['d', '--dev']), /--dev requires --sign/);
  assert.throws(() => parseArgs(['d', '--kid', 'bad kid']), /--kid must match/);
  assert.throws(() => parseArgs(['d', '--nope']), /unknown option/);
  assert.throws(() => parseArgs(['d', 'e']), /unexpected argument/);
  assert.throws(() => parseArgs(['d', '--out']), /--out needs a value/);
  assert.equal(parseArgs(['--help']).help, true);
});

test('buildPlugin: unsigned package excludes tests by default, is deterministic and lists its entries; invalid manifests and foreign SIGNATURE.json are refused', async () => {
  const { buildPlugin } = await load();
  const dir = plugin(tmp());
  const out1 = path.join(tmp(), 'a.whmplugin');
  const r = buildPlugin({ dir, out: out1, sign: null, dev: false, kid: null, exclude: [], includeTests: false });
  assert.deepEqual(r.entries, ['README.md', 'main.js', 'plugin.json']);
  assert.equal(r.signature, null);
  assert.equal(r.sha256, pack.sha256(fs.readFileSync(out1)));
  assert.equal(r.manifest.id, 'net.example.built');
  const out2 = path.join(tmp(), 'b.whmplugin');
  buildPlugin({ dir, out: out2, sign: null, dev: false, kid: null, exclude: [], includeTests: false });
  assert.ok(fs.readFileSync(out1).equals(fs.readFileSync(out2)), 'two builds are byte-identical');
  const withTests = buildPlugin({ dir, out: path.join(tmp(), 'c.whmplugin'), sign: null, dev: false, kid: null, exclude: [], includeTests: true });
  assert.ok(withTests.entries.includes('test/main.test.js'));
  const bad = plugin(tmp(), {}, { ...minimalManifest(), permissions: ['nope'] });
  assert.throws(() => buildPlugin({ dir: bad, out: null, sign: null, dev: false, kid: null, exclude: [], includeTests: false }), (err) => /plugin.json is invalid/.test(err.message) && err.details.length > 0);
  assert.throws(() => buildPlugin({ dir: path.join(dir, 'missing'), out: null, sign: null, dev: false, kid: null, exclude: [], includeTests: false }), /is not a directory/);
  const signed = plugin(tmp(), { 'SIGNATURE.json': '{"kid":"x","alg":"ed25519","sig":"y"}\n' });
  assert.throws(() => buildPlugin({ dir: signed, out: null, sign: null, dev: false, kid: null, exclude: [], includeTests: false }), /already contains SIGNATURE.json/);
});

test('signing: --dev writes DEV-SIGNATURE.json over the digest without both signature files; --sign alone writes SIGNATURE.json the host verifies', async () => {
  const { buildPlugin } = await load();
  const kp = pack.generateKeyPair();
  const keyFile = path.join(tmp(), 'dev.pem');
  fs.writeFileSync(keyFile, kp.privateKeyPem);
  const dir = plugin(tmp());
  const devOut = path.join(tmp(), 'dev.whmplugin');
  const dev = buildPlugin({ dir, out: devOut, sign: keyFile, dev: true, kid: null, exclude: [], includeTests: false });
  assert.deepEqual([dev.signature.file, dev.kid], ['DEV-SIGNATURE.json', kp.kid]);
  const unpacked = tmp();
  pack.unpack(fs.readFileSync(devOut), unpacked);
  assert.deepEqual(pack.verifySignatureFile(unpacked, 'DEV-SIGNATURE.json', kp.publicKeyPem), { ok: true, kid: kp.kid });
  assert.match(pack.readSignature(unpacked, 'DEV-SIGNATURE.json').sig, /^[A-Za-z0-9+/]{86}==$/);
  const opOut = path.join(tmp(), 'op.whmplugin');
  const op = buildPlugin({ dir, out: opOut, sign: keyFile, dev: false, kid: 'custom-1', exclude: [], includeTests: false });
  assert.deepEqual([op.signature.file, op.signature.kid], ['SIGNATURE.json', 'custom-1']);
  const opDir = tmp();
  pack.unpack(fs.readFileSync(opOut), opDir);
  assert.equal(pack.verify(pack.packageDigest(opDir), pack.readSignature(opDir).sig, kp.publicKeyPem), true);
  // operator signing may replace an existing SIGNATURE.json in the source tree
  fs.writeFileSync(path.join(dir, 'SIGNATURE.json'), '{"kid":"old","alg":"ed25519","sig":"x"}\n');
  const replaced = buildPlugin({ dir, out: path.join(tmp(), 'op2.whmplugin'), sign: keyFile, dev: false, kid: null, exclude: [], includeTests: false });
  assert.equal(replaced.signature.kid, kp.kid);
  assert.throws(() => buildPlugin({ dir, out: null, sign: keyFile, dev: true, kid: null, exclude: [], includeTests: false }), /already contains SIGNATURE.json/);
});

test('a PEM private key anywhere in the packaged tree is refused unless --allow-secrets (or it is excluded)', async () => {
  const { buildPlugin, looksLikePrivateKey } = await load();
  const kp = pack.generateKeyPair();
  const dir = plugin(tmp(), { 'test/fixtures/dev.pem': kp.privateKeyPem, 'keys/op.key': `# operator key\n${kp.privateKeyPem}`, 'keys/op.pub': kp.publicKeyPem });
  assert.equal(looksLikePrivateKey(path.join(dir, 'keys/op.key')), true);
  assert.equal(looksLikePrivateKey(path.join(dir, 'keys/op.pub')), false);
  assert.equal(looksLikePrivateKey(path.join(dir, 'main.js')), false);
  const base = { dir, out: path.join(tmp(), 'k.whmplugin'), sign: null, dev: false, kid: null, exclude: [], includeTests: false };
  assert.throws(() => buildPlugin(base), (err) => /would contain a private key/.test(err.message) && err.details.join() === 'keys/op.key');
  assert.throws(() => buildPlugin({ ...base, includeTests: true }), (err) => err.details.join() === 'keys/op.key,test/fixtures/dev.pem');
  const excluded = buildPlugin({ ...base, exclude: ['keys/op.key'] });
  assert.ok(excluded.entries.includes('keys/op.pub') && !excluded.entries.includes('keys/op.key'));
  const allowed = buildPlugin({ ...base, includeTests: true, allowSecrets: true });
  assert.ok(allowed.entries.includes('keys/op.key') && allowed.entries.includes('test/fixtures/dev.pem'));
});
