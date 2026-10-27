'use strict';

/**
 * WHM Plugin SDK — .whmplugin packaging, digests and Ed25519 package signatures.
 *
 * Zero dependencies (node:fs, node:path, node:crypto, node:zlib). CommonJS, like the
 * rest of the SDK, so the hub (through createRequire), scripts/build-plugin.js and
 * plugin test suites can all load it.
 *
 * The package format and the digest are the host's (server/src/services/plugins.js,
 * server/src/lib/tar.js — docs/design/plugin-host.md "Package format"):
 *
 *   - gzip'ed ustar with plugin.json and main.js at the root; regular files and
 *     directories only; names free of whitespace/control characters, no "..", no
 *     absolute names; ≤ MAX_PACKAGE_BYTES packed, ≤ MAX_EXTRACTED_BYTES unpacked,
 *     ≤ MAX_ENTRIES entries.
 *   - packageDigest(dir) = sha256( join('\n', sorted(`${name} ${sha256hex(content)}`)) )
 *     over every file except SIGNATURE.json (DEV-SIGNATURE.json is excluded as well
 *     when a developer signs, marketplace.md §18.3).
 *   - SIGNATURE.json / DEV-SIGNATURE.json = { kid, alg: 'ed25519', sig } where sig is
 *     Ed25519 over the digest bytes, encoded as STANDARD base64 WITH padding — the
 *     exact string the host decodes with Buffer.from(sig, 'base64').
 *   - kid = first 8 hex characters of sha256(raw 32-byte public key) (§16.4 / §18.2).
 *
 * packDirectory() is deterministic: two packs of the same tree are byte-identical
 * (sorted entries, mtime 0, uid/gid 0, mode 0644 or 0755, gzip level 9).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const BLOCK = 512;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const SIGNATURE_FILE = 'SIGNATURE.json';
const DEV_SIGNATURE_FILE = 'DEV-SIGNATURE.json';
const SIGNATURE_FILES = Object.freeze([SIGNATURE_FILE, DEV_SIGNATURE_FILE]);
const KID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNSAFE_NAME_CHARS = /[\s\x00-\x1f\x7f]/;
const DEFAULT_PACK_EXCLUDE = Object.freeze(['node_modules/', '.git/', 'test/', 'tests/', '*.whmplugin', '.DS_Store']);

class PackError extends Error {
  constructor(message, entry) {
    super(message);
    this.name = 'PackError';
    this.code = 'invalid_package';
    if (entry !== undefined) this.entry = entry;
  }
}

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Names and exclusions
// ---------------------------------------------------------------------------

/** Normalise a relative entry name the way the host's tar reader does, or throw. */
function safeEntryName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new PackError('entry has an empty name');
  if (raw.includes('\0')) throw new PackError('entry name contains a NUL byte', raw);
  if (UNSAFE_NAME_CHARS.test(raw)) throw new PackError('entry name contains whitespace or a control character', raw);
  if (raw.includes('\\')) throw new PackError('entry name contains a backslash', raw);
  if (raw.startsWith('/')) throw new PackError('absolute entry names are not allowed', raw);
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw new PackError('entry name contains a ".." segment', raw);
  return segments.join('/');
}

function globToRegExp(pattern) {
  const re = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${re}$`);
}

/**
 * Compile an exclude list. Entries: an exact relative path ("SIGNATURE.json",
 * "docs/draft.md"), a directory prefix ending in "/" ("node_modules/"), or a
 * basename glob with "*" ("*.whmplugin"). Matching is against the relative path
 * (forward slashes) and, for globs, against the basename too.
 */
function compileExclude(list) {
  const exact = new Set();
  const dirs = [];
  const globs = [];
  for (const raw of list || []) {
    if (typeof raw !== 'string' || raw.length === 0) throw new TypeError('exclude entries must be non-empty strings');
    const e = raw.replace(/^\.\//, '');
    if (e.endsWith('/')) dirs.push(e);
    else if (e.includes('*')) globs.push(globToRegExp(e));
    else exact.add(e);
  }
  return (rel) => {
    if (exact.has(rel)) return true;
    for (const d of dirs) if (rel.startsWith(d)) return true;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    for (const g of globs) if (g.test(rel) || g.test(base)) return true;
    return false;
  };
}

/**
 * Walk a directory into sorted relative file paths. Symlinks and special files are
 * refused (the host refuses them in packages and in { dir } installs alike).
 * Sorting is by UTF-16 code unit on the full relative path — the order
 * packageDigest() uses for its lines.
 */
function walkFiles(dir, { exclude } = {}) {
  const root = path.resolve(dir);
  const st = fs.statSync(root);
  if (!st.isDirectory()) throw new PackError(`${dir} is not a directory`);
  const excluded = compileExclude(exclude);
  const out = [];
  const walk = (d, relBase) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (UNSAFE_NAME_CHARS.test(ent.name) || ent.name.includes('\\')) throw new PackError('file names may not contain whitespace, control characters or backslashes', rel);
      const full = path.join(d, ent.name);
      const lst = fs.lstatSync(full);
      if (lst.isSymbolicLink()) throw new PackError('plugin directories may not contain symbolic links', rel);
      if (lst.isDirectory()) {
        if (excluded(`${rel}/`) || excluded(rel)) continue;
        walk(full, rel);
        continue;
      }
      if (!lst.isFile()) throw new PackError(`unsupported file type: ${rel}`, rel);
      if (excluded(rel)) continue;
      out.push({ rel, full, size: lst.size, mode: lst.mode });
    }
  };
  walk(root, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Digest, signatures, keys
// ---------------------------------------------------------------------------

/**
 * Canonical content digest of an unpacked plugin directory → 32-byte Buffer.
 * Default exclusion is the host's (SIGNATURE.json at the root); developers pass
 * { exclude: ['SIGNATURE.json', 'DEV-SIGNATURE.json'] } for DEV-SIGNATURE.json.
 * Exclusions are exact relative paths (a nested SIGNATURE.json is hashed, as on the host).
 */
function packageDigest(dir, { exclude = [SIGNATURE_FILE] } = {}) {
  const skip = new Set(exclude);
  const lines = walkFiles(dir, { exclude: [] })
    .filter((f) => !skip.has(f.rel))
    .map((f) => `${f.rel} ${sha256Hex(fs.readFileSync(f.full))}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest();
}

function toPrivateKey(key) {
  let k = key;
  if (typeof key === 'string' || Buffer.isBuffer(key)) {
    try { k = crypto.createPrivateKey(key); } catch (err) { throw new TypeError(`not a PEM private key: ${err.message}`); }
  }
  if (!k || k.type !== 'private') throw new TypeError('sign() expects an Ed25519 private key (PEM or KeyObject)');
  if (k.asymmetricKeyType !== 'ed25519') throw new TypeError(`expected an Ed25519 private key, got ${k.asymmetricKeyType}`);
  return k;
}

function toPublicKey(key) {
  let k = key;
  if (typeof key === 'string' || Buffer.isBuffer(key)) {
    try { k = crypto.createPublicKey(key); } catch (err) { throw new TypeError(`not a PEM public key: ${err.message}`); }
  } else if (key && key.type === 'private') {
    k = crypto.createPublicKey(key);
  }
  if (!k || k.type !== 'public') throw new TypeError('expected an Ed25519 public key (PEM SPKI or KeyObject)');
  if (k.asymmetricKeyType !== 'ed25519') throw new TypeError(`expected an Ed25519 public key, got ${k.asymmetricKeyType}`);
  return k;
}

/** Ed25519 signature over the digest bytes → standard base64 WITH padding. */
function sign(digest, privateKeyPem) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new TypeError('sign() expects the 32-byte digest Buffer from packageDigest()');
  return crypto.sign(null, digest, toPrivateKey(privateKeyPem)).toString('base64');
}

/**
 * Verify a signature string exactly the way the host does
 * (crypto.verify(null, digest, key, Buffer.from(sig, 'base64'))). Returns a boolean;
 * never throws on a malformed signature.
 */
function verify(digest, sigB64, publicKeyPem) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new TypeError('verify() expects the 32-byte digest Buffer from packageDigest()');
  if (typeof sigB64 !== 'string') return false;
  let key;
  try { key = toPublicKey(publicKeyPem); } catch { return false; }
  try { return crypto.verify(null, digest, key, Buffer.from(sigB64, 'base64')); } catch { return false; }
}

/** Raw 32-byte Ed25519 public key. */
function rawPublicKey(publicKeyPem) {
  const jwk = toPublicKey(publicKeyPem).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

/** kid = first 8 hex of sha256(raw 32-byte public key). Accepts a public or private key. */
function kidOf(publicKeyPem) {
  const raw = rawPublicKey(publicKeyPem);
  if (raw.length !== 32) throw new TypeError('Ed25519 public keys are 32 bytes');
  return sha256Hex(raw).slice(0, 8);
}

/** PEM SPKI of the public half (what goes into $WHM_DATA_DIR/plugin-keys/<kid>.pub). */
function publicPem(key) {
  return toPublicKey(key).export({ type: 'spki', format: 'pem' });
}

/** A fresh Ed25519 pair as PEM strings plus its kid (fixtures, local operator keys). */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    kid: kidOf(publicKey),
  };
}

/** Write <dir>/<fileName> = { kid, alg: 'ed25519', sig }. fileName ∈ SIGNATURE_FILES. */
function writeSignature(dir, fileName, { kid, sig }) {
  if (!SIGNATURE_FILES.includes(fileName)) throw new TypeError(`fileName must be one of ${SIGNATURE_FILES.join(', ')}`);
  if (typeof kid !== 'string' || !KID_RE.test(kid)) throw new TypeError('kid must match the host KID_RE (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)');
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig) || sig.length % 4 !== 0) throw new TypeError('sig must be standard base64 with padding');
  const file = path.join(path.resolve(dir), fileName);
  const body = `${JSON.stringify({ kid, alg: 'ed25519', sig }, null, 2)}\n`;
  fs.writeFileSync(file, body, { mode: 0o644 });
  return file;
}

/** Read and shape-check a signature file → { kid, alg, sig } or null when absent. */
function readSignature(dir, fileName = SIGNATURE_FILE) {
  if (!SIGNATURE_FILES.includes(fileName)) throw new TypeError(`fileName must be one of ${SIGNATURE_FILES.join(', ')}`);
  const file = path.join(path.resolve(dir), fileName);
  if (!fs.existsSync(file)) return null;
  let sig;
  try { sig = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new PackError(`${fileName} is not valid JSON`, fileName); }
  if (!sig || typeof sig !== 'object' || Array.isArray(sig) || typeof sig.kid !== 'string' || !KID_RE.test(sig.kid) || sig.alg !== 'ed25519' || typeof sig.sig !== 'string') {
    throw new PackError(`${fileName} must be { kid, alg: "ed25519", sig }`, fileName);
  }
  return { kid: sig.kid, alg: sig.alg, sig: sig.sig };
}

/**
 * Verify the signature file of an unpacked directory against a public key.
 * SIGNATURE.json is checked over the host digest; DEV-SIGNATURE.json over the
 * digest with both signature files excluded. → { ok, kid, reason? }
 */
function verifySignatureFile(dir, fileName, publicKeyPem) {
  const sig = readSignature(dir, fileName);
  if (!sig) return { ok: false, kid: null, reason: 'missing' };
  const exclude = fileName === DEV_SIGNATURE_FILE ? [SIGNATURE_FILE, DEV_SIGNATURE_FILE] : [SIGNATURE_FILE];
  const ok = verify(packageDigest(dir, { exclude }), sig.sig, publicKeyPem);
  return ok ? { ok: true, kid: sig.kid } : { ok: false, kid: sig.kid, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------
// tar writer
// ---------------------------------------------------------------------------

function octal(n, len) {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

function header({ name, prefix = '', size, mode, type }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

function padded(data) {
  const out = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK, 0);
  data.copy(out);
  return out;
}

// ustar holds 100 bytes of name plus a 155-byte prefix split at a "/"; longer
// names go through a GNU "L" record, which the host reader understands.
function nameFields(rel) {
  const bytes = Buffer.byteLength(rel, 'utf8');
  if (bytes <= 100) return { name: rel, prefix: '', long: false };
  const segs = rel.split('/');
  for (let i = segs.length - 1; i > 0; i--) {
    const prefix = segs.slice(0, i).join('/');
    const name = segs.slice(i).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix, long: false };
  }
  return { name: '', prefix: '', long: true };
}

function fileRecord(rel, data, mode) {
  const parts = [];
  const nf = nameFields(rel);
  if (nf.long) {
    const longName = Buffer.from(`${rel}\0`, 'utf8');
    parts.push(header({ name: '././@LongLink', size: longName.length, mode: 0o644, type: 'L' }), padded(longName));
    parts.push(header({ name: rel.slice(0, 100), size: data.length, mode, type: '0' }));
  } else {
    parts.push(header({ name: nf.name, prefix: nf.prefix, size: data.length, mode, type: '0' }));
  }
  if (data.length) parts.push(padded(data));
  return parts;
}

/**
 * Pack a plugin directory into a gzip'ed ustar Buffer. Files only (the host
 * recreates directories), sorted by relative path, mtime 0, uid/gid 0, mode 0644
 * (0755 when the source file is owner-executable). Refuses links/special files,
 * unsafe names, more than MAX_ENTRIES files or MAX_EXTRACTED_BYTES of content,
 * and a result over MAX_PACKAGE_BYTES.
 */
function packDirectory(dir, { exclude = DEFAULT_PACK_EXCLUDE, level = 9 } = {}) {
  const files = walkFiles(dir, { exclude });
  if (!files.some((f) => f.rel === 'plugin.json')) throw new PackError('plugin.json is missing at the package root', 'plugin.json');
  if (files.length > MAX_ENTRIES) throw new PackError(`plugin has more than ${MAX_ENTRIES} files`);
  const parts = [];
  let total = 0;
  for (const f of files) {
    safeEntryName(f.rel);
    total += f.size;
    if (total > MAX_EXTRACTED_BYTES) throw new PackError(`plugin exceeds ${MAX_EXTRACTED_BYTES} bytes`);
    const data = fs.readFileSync(f.full);
    parts.push(...fileRecord(f.rel, data, f.mode & 0o100 ? 0o755 : 0o644));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  const gz = zlib.gzipSync(Buffer.concat(parts), { level });
  if (gz.length > MAX_PACKAGE_BYTES) throw new PackError(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  return gz;
}

// ---------------------------------------------------------------------------
// tar reader (same refusals as server/src/lib/tar.js)
// ---------------------------------------------------------------------------

function field(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function readOctal(buf, offset, length, what) {
  const raw = buf.subarray(offset, offset + length);
  if (raw[0] & 0x80) throw new PackError(`${what}: base-256 numeric fields are not supported`);
  const text = field(buf, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new PackError(`${what}: invalid numeric field "${text}"`);
  return parseInt(text, 8);
}

function checksumOk(h) {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b >= 128 ? b - 256 : b;
  }
  const stored = readOctal(h, 148, 8, 'checksum');
  return stored === unsigned || stored === signed;
}

const TYPE_LABEL = { 1: 'hard link', 2: 'symbolic link', 3: 'character device', 4: 'block device', 6: 'fifo', 7: 'contiguous file', x: 'PAX extended header', g: 'PAX global header' };

function* tarEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new PackError('archive must be a Buffer');
  let offset = 0;
  let longName = null;
  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new PackError(`corrupt tar header at offset ${offset}`);
    const size = readOctal(h, 124, 12, 'size');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const magic = field(h, 257, 6);
    let name = field(h, 0, 100);
    const prefix = magic.startsWith('ustar') && !magic.startsWith('ustar ') ? field(h, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new PackError(`truncated archive: entry "${name}" claims ${size} bytes`, name);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') { longName = field(buf, dataStart, size); continue; }
    if (longName !== null) { name = longName; longName = null; }
    const mode = readOctal(h, 100, 8, 'mode') & 0o777;
    yield { name, type, size, mode, data: buf.subarray(dataStart, dataEnd) };
  }
}

function classify(e) {
  if (e.type === '0') return 'file';
  if (e.type === '5') return 'dir';
  throw new PackError(`entry "${e.name}" is a ${TYPE_LABEL[e.type] || `type "${e.type}"`}, which plugin packages may not contain`, e.name);
}

function gunzip(buf, maxBytes) {
  if (!Buffer.isBuffer(buf)) throw new PackError('package must be a Buffer');
  if (buf.length > MAX_PACKAGE_BYTES) throw new PackError(`package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  try { return zlib.gunzipSync(buf, { maxOutputLength: maxBytes + 1024 }); } catch (err) { throw new PackError(`package is not a gzip'ed tar: ${err.message}`); }
}

/** List a .whmplugin's entries without writing → [{ name, type, size, mode }]. */
function listPackage(buf, { maxBytes = MAX_EXTRACTED_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const e of tarEntries(gunzip(buf, maxBytes))) {
    const type = classify(e);
    const name = safeEntryName(e.name);
    if (name === '') continue;
    if (seen.has(name)) throw new PackError(`duplicate entry "${name}"`, name);
    seen.add(name);
    total += e.size;
    if (total > maxBytes) throw new PackError(`archive exceeds ${maxBytes} bytes when extracted`);
    out.push({ name, type, size: e.size, mode: e.mode });
    if (out.length > maxEntries) throw new PackError(`archive has more than ${maxEntries} entries`);
  }
  return out;
}

/**
 * Unpack a .whmplugin Buffer into dest (created when missing). Same refusals as
 * the host's extractTar: absolute names, "..", NUL/whitespace/control characters,
 * links, devices, fifos, PAX headers, duplicates, file/directory conflicts,
 * writes through symlinks, size and entry caps. Returns the entry list.
 */
function unpack(buf, dest, { maxBytes = MAX_EXTRACTED_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  const tar = gunzip(buf, maxBytes);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const list = [];
  const seen = new Set();
  let total = 0;
  for (const e of tarEntries(tar)) {
    const type = classify(e);
    const name = safeEntryName(e.name);
    if (name === '') continue;
    if (seen.has(name)) throw new PackError(`duplicate entry "${name}"`, name);
    seen.add(name);
    total += e.size;
    if (total > maxBytes) throw new PackError(`archive exceeds ${maxBytes} bytes when extracted`);
    list.push({ name, type, size: e.size, mode: e.mode });
    if (list.length > maxEntries) throw new PackError(`archive has more than ${maxEntries} entries`);
    const target = path.join(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new PackError('entry resolves outside the destination', name);
    let cur = root;
    for (const seg of name.split('/')) {
      cur = path.join(cur, seg);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { break; }
      if (st.isSymbolicLink()) throw new PackError('refusing to write through a symbolic link', name);
      if (cur !== target && !st.isDirectory()) throw new PackError(`entry "${name}" has a file as a parent`, name);
    }
    try {
      if (type === 'dir') { fs.mkdirSync(target, { recursive: true, mode: 0o750 }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      fs.writeFileSync(target, e.data, { mode: e.mode & 0o100 ? 0o750 : 0o640, flag: 'w' });
    } catch (err) {
      if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new PackError(`entry "${name}" conflicts with an earlier entry (${err.code})`, name);
      throw err;
    }
  }
  return list;
}

/**
 * The directory that holds plugin.json inside an unpacked tree: the tree itself,
 * or its single top-level directory (a wrapper the host strips). Throws otherwise.
 */
function packageRoot(dir) {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, 'plugin.json'))) return root;
  const ents = fs.readdirSync(root, { withFileTypes: true });
  if (ents.length === 1 && ents[0].isDirectory() && fs.existsSync(path.join(root, ents[0].name, 'plugin.json'))) return path.join(root, ents[0].name);
  throw new PackError('package has no plugin.json at its root', 'plugin.json');
}

module.exports = {
  MAX_PACKAGE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_ENTRIES,
  SIGNATURE_FILE,
  DEV_SIGNATURE_FILE,
  SIGNATURE_FILES,
  KID_RE,
  UNSAFE_NAME_CHARS,
  DEFAULT_PACK_EXCLUDE,
  PackError,
  sha256: sha256Hex,
  safeEntryName,
  walkFiles,
  packDirectory,
  listPackage,
  unpack,
  packageRoot,
  packageDigest,
  sign,
  verify,
  kidOf,
  rawPublicKey,
  publicPem,
  generateKeyPair,
  writeSignature,
  readSignature,
  verifySignatureFile,
};
