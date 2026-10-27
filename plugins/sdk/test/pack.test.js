'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const pack = require('../pack');
const sdk = require('../index');
const { minimalManifest } = require('./fixtures');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const haveServer = fs.existsSync(path.join(SERVER_DIR, 'src', 'services', 'plugins.js')) && fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));

const tmp = (prefix = 'whm-pack-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function samplePlugin(dir, manifest = minimalManifest({ id: 'net.example.packed' })) {
  return writeTree(dir, {
    'plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'main.js': "'use strict';\nmodule.exports = { async activate(ctx) { ctx.log.info('hi'); } };\n",
    'lib/util.js': 'module.exports = { x: 1 };\n',
    'locales/en.json': '{"hello":"Hello"}\n',
    'README.md': '# packed\n',
    'zz/deep/nested/file.txt': 'deep\n',
  });
}

// ---------------------------------------------------------------- exports

test('the SDK entry point exposes pack and SDK_VERSION stays 1.0.0', () => {
  assert.equal(sdk.pack, pack);
  assert.equal(sdk.SDK_VERSION, '1.0.0');
  for (const k of ['packDirectory', 'unpack', 'packageDigest', 'sign', 'verify', 'kidOf', 'writeSignature', 'listPackage', 'generateKeyPair', 'verifySignatureFile', 'packageRoot']) {
    assert.equal(typeof pack[k], 'function', k);
  }
  assert.equal(pack.MAX_PACKAGE_BYTES, 20 * 1024 * 1024);
  assert.equal(pack.MAX_EXTRACTED_BYTES, 50 * 1024 * 1024);
  assert.equal(pack.MAX_ENTRIES, 2000);
  assert.deepEqual(pack.SIGNATURE_FILES, ['SIGNATURE.json', 'DEV-SIGNATURE.json']);
});

// ---------------------------------------------------------------- pack / unpack

test('packDirectory → unpack round-trips every file with its content and modes', () => {
  const src = samplePlugin(tmp());
  fs.chmodSync(path.join(src, 'main.js'), 0o755);
  const buf = pack.packDirectory(src);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf[0], 0x1f, 'gzip magic');
  assert.equal(buf[1], 0x8b);
  const entries = pack.listPackage(buf);
  assert.deepEqual(entries.map((e) => e.name), ['README.md', 'lib/util.js', 'locales/en.json', 'main.js', 'plugin.json', 'zz/deep/nested/file.txt']);
  assert.ok(entries.every((e) => e.type === 'file'));
  assert.equal(entries.find((e) => e.name === 'main.js').mode, 0o755);
  assert.equal(entries.find((e) => e.name === 'README.md').mode, 0o644);
  const dest = tmp();
  const list = pack.unpack(buf, dest);
  assert.equal(list.length, 6);
  for (const e of entries) assert.equal(fs.readFileSync(path.join(dest, e.name), 'utf8'), fs.readFileSync(path.join(src, e.name), 'utf8'), e.name);
  assert.ok(fs.statSync(path.join(dest, 'main.js')).mode & 0o100, 'exec bit survives');
  assert.equal(pack.packageRoot(dest), path.resolve(dest));
});

test('packing is deterministic: two packs are byte-identical, mtime is 0 and ownership is root', () => {
  const src = samplePlugin(tmp());
  const a = pack.packDirectory(src);
  const later = new Date(Date.now() + 86400e3);
  for (const f of pack.walkFiles(src)) fs.utimesSync(f.full, later, later);
  const b = pack.packDirectory(src);
  assert.ok(a.equals(b));
  const copy = samplePlugin(tmp());
  assert.ok(pack.packDirectory(copy).equals(a), 'a copy of the tree packs identically');
  const tar = zlib.gunzipSync(a);
  // first header: mtime (136..148), uid (108..116), gid (116..124) are zero, magic ustar
  assert.equal(tar.subarray(136, 147).toString(), '00000000000');
  assert.equal(tar.subarray(108, 115).toString(), '0000000');
  assert.equal(tar.subarray(116, 123).toString(), '0000000');
  assert.equal(tar.subarray(257, 262).toString(), 'ustar');
  assert.equal(tar.subarray(0, 100).toString().replace(/\0+$/, ''), 'README.md', 'entries are sorted by path');
});

test('exclude: directory prefixes, exact paths and basename globs; defaults drop node_modules, .git, test and *.whmplugin', () => {
  const src = samplePlugin(tmp());
  writeTree(src, { 'node_modules/x/index.js': '1', '.git/HEAD': 'ref', 'test/a.test.js': '1', 'build.whmplugin': 'x', 'docs/draft.md': 'd', 'DEV-SIGNATURE.json': '{}' });
  const names = (buf) => pack.listPackage(buf).map((e) => e.name);
  const d = names(pack.packDirectory(src));
  assert.ok(!d.some((n) => n.startsWith('node_modules/') || n.startsWith('.git/') || n.startsWith('test/') || n.endsWith('.whmplugin')));
  assert.ok(d.includes('docs/draft.md') && d.includes('DEV-SIGNATURE.json'));
  const custom = names(pack.packDirectory(src, { exclude: ['docs/', 'DEV-SIGNATURE.json', '*.txt', 'node_modules/', '.git/', 'test/', '*.whmplugin'] }));
  assert.ok(!custom.includes('docs/draft.md') && !custom.includes('DEV-SIGNATURE.json') && !custom.includes('zz/deep/nested/file.txt'));
  assert.ok(custom.includes('main.js'));
  assert.throws(() => pack.packDirectory(src, { exclude: [''] }), TypeError);
});

test('long entry names use the ustar prefix or a GNU long-name record and still round-trip', () => {
  const src = samplePlugin(tmp());
  const seg = 'a'.repeat(60);
  const viaPrefix = `${seg}/${seg}/${seg}.js`; // 182 chars: prefix 121 + name 63
  const viaLong = `${'b'.repeat(120)}/${'c'.repeat(120)}/x.js`; // no split fits ustar
  writeTree(src, { [viaPrefix]: 'p', [viaLong]: 'l' });
  const buf = pack.packDirectory(src);
  const names = pack.listPackage(buf).map((e) => e.name);
  assert.ok(names.includes(viaPrefix) && names.includes(viaLong));
  const dest = tmp();
  pack.unpack(buf, dest);
  assert.equal(fs.readFileSync(path.join(dest, viaLong), 'utf8'), 'l');
  assert.equal(fs.readFileSync(path.join(dest, viaPrefix), 'utf8'), 'p');
});

test('packDirectory refuses symlinks, unsafe names, a missing plugin.json and oversize trees', () => {
  const src = samplePlugin(tmp());
  fs.symlinkSync('/etc/hostname', path.join(src, 'link'));
  assert.throws(() => pack.packDirectory(src), (e) => e instanceof pack.PackError && /symbolic link/.test(e.message));
  fs.unlinkSync(path.join(src, 'link'));
  fs.writeFileSync(path.join(src, 'bad name.js'), '1');
  assert.throws(() => pack.packDirectory(src), (e) => e.code === 'invalid_package' && /whitespace/.test(e.message));
  fs.unlinkSync(path.join(src, 'bad name.js'));
  const empty = writeTree(tmp(), { 'main.js': '1' });
  assert.throws(() => pack.packDirectory(empty), /plugin.json is missing/);
  assert.throws(() => pack.packDirectory(path.join(src, 'main.js')), /not a directory/);
  const many = samplePlugin(tmp());
  for (let i = 0; i < pack.MAX_ENTRIES; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), '');
  assert.throws(() => pack.packDirectory(many), /more than 2000 files/);
});

// a tiny hand-rolled tar for refusal cases (the SDK writer never emits these)
function rawTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.from(e.data || '', 'utf8');
    const h = Buffer.alloc(512, 0);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 8, 'ascii');
    h.write('0000000\0', 108, 8, 'ascii');
    h.write('0000000\0', 116, 8, 'ascii');
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(e.type || '0', 156, 1, 'ascii');
    if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
    data.copy(padded);
    parts.push(h, padded);
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

test('unpack refuses what the host refuses: traversal, absolute names, links, devices, PAX, duplicates, conflicts, caps, non-gzip', () => {
  const cases = [
    [[{ name: '../evil.js' }], /\.\./],
    [[{ name: '/etc/passwd' }], /absolute/],
    [[{ name: 'a\nb' }], /whitespace|control/],
    [[{ name: 'main.js', type: '2', linkname: '/etc/passwd' }], /symbolic link/],
    [[{ name: 'main.js', type: '1', linkname: 'x' }], /hard link/],
    [[{ name: 'dev', type: '3' }], /character device/],
    [[{ name: 'fifo', type: '6' }], /fifo/],
    [[{ name: 'pax', type: 'x', data: 'path=x' }], /PAX/],
    [[{ name: 'a.js', data: '1' }, { name: 'a.js', data: '2' }], /duplicate/],
    [[{ name: 'a.js', data: '1' }, { name: 'a.js/b.js', data: '2' }], /conflicts|file as a parent/],
    [[{ name: 'dir/', type: '5' }, { name: 'dir', type: '0', data: 'x' }], /conflicts|duplicate/],
  ];
  for (const [entries, re] of cases) {
    const dest = tmp();
    assert.throws(() => pack.unpack(rawTar(entries), dest), (e) => e instanceof pack.PackError && re.test(e.message), JSON.stringify(entries));
  }
  assert.throws(() => pack.unpack(Buffer.from('not gzip'), tmp()), /not a gzip/);
  assert.throws(() => pack.unpack(rawTar([{ name: 'a.js', data: 'x'.repeat(2000) }]), tmp(), { maxBytes: 1000 }), /exceeds 1000 bytes|larger than/);
  assert.throws(() => pack.unpack(rawTar([{ name: 'a.js' }, { name: 'b.js' }, { name: 'c.js' }]), tmp(), { maxEntries: 2 }), /more than 2 entries/);
  assert.throws(() => pack.unpack(Buffer.alloc(pack.MAX_PACKAGE_BYTES + 1), tmp()), /package exceeds/);
  // a symlink already present at the destination is never written through
  const dest = tmp();
  fs.mkdirSync(path.join(dest, 'elsewhere'));
  fs.symlinkSync(path.join(dest, 'elsewhere'), path.join(dest, 'lib'));
  assert.throws(() => pack.unpack(rawTar([{ name: 'lib/x.js', data: '1' }]), dest), /symbolic link/);
  assert.equal(fs.readdirSync(path.join(dest, 'elsewhere')).length, 0);
});

test('packageRoot accepts a single wrapper directory and refuses anything else', () => {
  const dest = tmp();
  samplePlugin(path.join(dest, 'wrapper'));
  assert.equal(pack.packageRoot(dest), path.join(dest, 'wrapper'));
  fs.mkdirSync(path.join(dest, 'second'));
  assert.throws(() => pack.packageRoot(dest), /no plugin.json/);
});

// ---------------------------------------------------------------- digest + signatures

test('packageDigest is stable, order-independent of write order, and excludes only the named root files', () => {
  const a = samplePlugin(tmp());
  const b = writeTree(tmp(), Object.fromEntries(Object.entries({
    'zz/deep/nested/file.txt': 'deep\n', 'README.md': '# packed\n', 'locales/en.json': '{"hello":"Hello"}\n', 'lib/util.js': 'module.exports = { x: 1 };\n',
    'main.js': "'use strict';\nmodule.exports = { async activate(ctx) { ctx.log.info('hi'); } };\n", 'plugin.json': `${JSON.stringify(minimalManifest({ id: 'net.example.packed' }), null, 2)}\n`,
  })));
  const da = pack.packageDigest(a);
  assert.equal(da.length, 32);
  assert.ok(da.equals(pack.packageDigest(b)));
  fs.writeFileSync(path.join(a, 'SIGNATURE.json'), '{"kid":"x","alg":"ed25519","sig":"AA=="}');
  assert.ok(da.equals(pack.packageDigest(a)), 'root SIGNATURE.json is excluded by default');
  fs.writeFileSync(path.join(a, 'DEV-SIGNATURE.json'), '{}');
  assert.ok(!da.equals(pack.packageDigest(a)), 'DEV-SIGNATURE.json is covered by the host digest');
  assert.ok(da.equals(pack.packageDigest(a, { exclude: ['SIGNATURE.json', 'DEV-SIGNATURE.json'] })));
  fs.unlinkSync(path.join(a, 'DEV-SIGNATURE.json'));
  writeTree(a, { 'lib/SIGNATURE.json': '{}' });
  assert.ok(!da.equals(pack.packageDigest(a)), 'a nested SIGNATURE.json is hashed, as on the host');
  // the digest is the documented formula
  const lines = ['README.md', 'lib/SIGNATURE.json', 'lib/util.js', 'locales/en.json', 'main.js', 'plugin.json', 'zz/deep/nested/file.txt']
    .map((f) => `${f} ${crypto.createHash('sha256').update(fs.readFileSync(path.join(a, f))).digest('hex')}`).sort();
  assert.ok(pack.packageDigest(a).equals(crypto.createHash('sha256').update(lines.join('\n')).digest()));
});

test('sign emits standard base64 with padding, verify accepts exactly that string and rejects tampering, kidOf follows the §16.4 rule', () => {
  const { privateKeyPem, publicKeyPem, kid } = pack.generateKeyPair();
  const src = samplePlugin(tmp());
  const digest = pack.packageDigest(src);
  const sig = pack.sign(digest, privateKeyPem);
  assert.match(sig, /^[A-Za-z0-9+/]{86}==$/, 'a 64-byte Ed25519 signature is 88 base64 chars with == padding');
  assert.equal(Buffer.from(sig, 'base64').length, 64);
  assert.equal(sig, crypto.sign(null, digest, crypto.createPrivateKey(privateKeyPem)).toString('base64'));
  assert.equal(pack.verify(digest, sig, publicKeyPem), true);
  assert.equal(pack.verify(digest, sig, crypto.createPublicKey(publicKeyPem)), true);
  assert.equal(pack.verify(digest, sig.slice(0, -4) + 'AAA=', publicKeyPem), false);
  assert.equal(pack.verify(crypto.createHash('sha256').update('other').digest(), sig, publicKeyPem), false);
  assert.equal(pack.verify(digest, sig, pack.generateKeyPair().publicKeyPem), false);
  assert.equal(pack.verify(digest, 42, publicKeyPem), false);
  assert.equal(pack.verify(digest, sig, 'not a key'), false);
  assert.throws(() => pack.sign(Buffer.alloc(31), privateKeyPem), TypeError);
  assert.throws(() => pack.sign(digest, publicKeyPem), TypeError);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => pack.sign(digest, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })), /Ed25519/);
  // kid: first 8 hex of sha256(raw 32-byte public key)
  const raw = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32);
  assert.equal(raw.length, 32);
  assert.equal(kid, crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8));
  assert.equal(pack.kidOf(publicKeyPem), kid);
  assert.equal(pack.kidOf(privateKeyPem), kid, 'kidOf accepts the private key too');
  assert.match(kid, /^[0-9a-f]{8}$/);
  assert.ok(pack.KID_RE.test(kid));
  assert.equal(pack.publicPem(privateKeyPem), publicKeyPem);
});

test('writeSignature / readSignature / verifySignatureFile for SIGNATURE.json and DEV-SIGNATURE.json', () => {
  const { privateKeyPem, publicKeyPem, kid } = pack.generateKeyPair();
  const src = samplePlugin(tmp());
  assert.equal(pack.readSignature(src), null);
  const devSig = pack.sign(pack.packageDigest(src, { exclude: pack.SIGNATURE_FILES }), privateKeyPem);
  const file = pack.writeSignature(src, 'DEV-SIGNATURE.json', { kid, sig: devSig });
  assert.equal(path.basename(file), 'DEV-SIGNATURE.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { kid, alg: 'ed25519', sig: devSig });
  assert.deepEqual(pack.verifySignatureFile(src, 'DEV-SIGNATURE.json', publicKeyPem), { ok: true, kid });
  // the marketplace signature covers DEV-SIGNATURE.json
  const mkt = pack.generateKeyPair();
  pack.writeSignature(src, 'SIGNATURE.json', { kid: mkt.kid, sig: pack.sign(pack.packageDigest(src), mkt.privateKeyPem) });
  assert.deepEqual(pack.verifySignatureFile(src, 'SIGNATURE.json', mkt.publicKeyPem), { ok: true, kid: mkt.kid });
  assert.deepEqual(pack.verifySignatureFile(src, 'DEV-SIGNATURE.json', publicKeyPem), { ok: true, kid }, 'writing SIGNATURE.json does not invalidate the developer signature');
  fs.writeFileSync(path.join(src, 'main.js'), 'module.exports = {}');
  assert.deepEqual(pack.verifySignatureFile(src, 'SIGNATURE.json', mkt.publicKeyPem), { ok: false, kid: mkt.kid, reason: 'mismatch' });
  assert.deepEqual(pack.verifySignatureFile(src, 'DEV-SIGNATURE.json', publicKeyPem), { ok: false, kid, reason: 'mismatch' });
  assert.throws(() => pack.writeSignature(src, 'OTHER.json', { kid, sig: devSig }), TypeError);
  assert.throws(() => pack.writeSignature(src, 'SIGNATURE.json', { kid: 'bad kid', sig: devSig }), TypeError);
  assert.throws(() => pack.writeSignature(src, 'SIGNATURE.json', { kid, sig: devSig.replace(/=+$/, '') }), /padding/);
  assert.throws(() => pack.writeSignature(src, 'SIGNATURE.json', { kid, sig: 'AAAA-AA=' }), /base64/);
  fs.writeFileSync(path.join(src, 'SIGNATURE.json'), '{"kid":"x"}');
  assert.throws(() => pack.readSignature(src), /must be/);
  fs.writeFileSync(path.join(src, 'SIGNATURE.json'), 'nope');
  assert.throws(() => pack.readSignature(src), /valid JSON/);
  assert.deepEqual(pack.verifySignatureFile(tmp(), 'SIGNATURE.json', publicKeyPem), { ok: false, kid: null, reason: 'missing' });
});

// ---------------------------------------------------------------- parity with the real host

test('parity: packageDigest equals the host packageDigest and the host tar reader extracts pack.js output', { skip: !haveServer && 'server workspace not available' }, async () => {
  const host = await import(pathToFileURL(path.join(SERVER_DIR, 'src', 'services', 'plugins.js')).href);
  const tar = await import(pathToFileURL(path.join(SERVER_DIR, 'src', 'lib', 'tar.js')).href);
  const src = samplePlugin(tmp());
  writeTree(src, { 'DEV-SIGNATURE.json': '{"kid":"abcdef01","alg":"ed25519","sig":"AA=="}', 'SIGNATURE.json': '{"kid":"x","alg":"ed25519","sig":"AA=="}', 'lib/SIGNATURE.json': '{}' });
  assert.ok(pack.packageDigest(src).equals(host.packageDigest(src)));
  const buf = pack.packDirectory(src);
  const dest = tmp();
  const list = tar.extractTar(zlib.gunzipSync(buf), dest);
  assert.deepEqual(list.map((e) => e.name), pack.listPackage(buf).map((e) => e.name));
  assert.ok(host.packageDigest(dest).equals(pack.packageDigest(src)), 'the digest survives pack → host extract');
  assert.ok(pack.packageDigest(dest).equals(host.packageDigest(src)));
});

test('parity: the host verifySignature accepts a SIGNATURE.json written by sign() and refuses a tampered copy', { skip: !haveServer && 'server workspace not available' }, async () => {
  const { createTestApp } = await import(pathToFileURL(path.join(SERVER_DIR, 'test', 'support', 'app.js')).href);
  const app = await createTestApp();
  try {
    const { privateKeyPem, publicKeyPem, kid } = pack.generateKeyPair();
    const keysDir = path.join(app.ctx.config.dataDir, 'plugin-keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, `${kid}.pub`), publicKeyPem);
    const src = samplePlugin(tmp(), minimalManifest({ id: 'net.example.parity' }));
    const sig = pack.sign(pack.packageDigest(src), privateKeyPem);
    pack.writeSignature(src, 'SIGNATURE.json', { kid, sig });
    const file = path.join(app.ctx.config.dataDir, 'parity.whmplugin');
    fs.writeFileSync(file, pack.packDirectory(src));
    const user = { id: null, username: 'root', role: 'root' };
    app.ctx.settings.set('plugins.require_signature', true);
    const r = await app.ctx.plugins.install({ path: file }, { user });
    assert.equal(r.plugin.signed, true);
    assert.equal(r.plugin.signer, kid);
    assert.deepEqual(r.warnings, ['in-process']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.ctx.config.pluginsDir, 'net.example.parity', 'SIGNATURE.json'), 'utf8')).sig, sig, 'the exact string reached the host');
    await app.ctx.plugins.uninstall('net.example.parity', { purge: true, user });
    fs.writeFileSync(path.join(src, 'main.js'), 'module.exports = { evil: true };');
    fs.writeFileSync(file, pack.packDirectory(src));
    await assert.rejects(app.ctx.plugins.install({ path: file }, { user }), (e) => e.code === 'invalid_signature');
    fs.unlinkSync(path.join(src, 'SIGNATURE.json'));
    fs.writeFileSync(file, pack.packDirectory(src));
    await assert.rejects(app.ctx.plugins.install({ path: file }, { user }), (e) => e.code === 'unsigned_package');
  } finally {
    await app.close();
  }
});
