#!/usr/bin/env node
// Builds a .whmplugin package from a plugin directory with the SDK's deterministic
// packer, optionally signing it.
//
//   node scripts/build-plugin.js <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>]
//                                      [--exclude <pattern>]... [--include-tests] [--json]
//
//   --sign <pem> --dev   developer signature: writes DEV-SIGNATURE.json over the digest with
//                        both signature files excluded (marketplace.md §18.3); what an upload
//                        to the marketplace must carry. The source may not contain SIGNATURE.json.
//   --sign <pem>         operator signature: writes SIGNATURE.json over the host digest
//                        (everything but SIGNATURE.json) for panels that trust the key under
//                        $WHM_DATA_DIR/plugin-keys/<kid>.pub. An existing SIGNATURE.json is replaced.
//   --kid <kid>          key id to record; default = first 8 hex of sha256(raw public key)
//   --exclude <pat>      extra exclude (exact path, "dir/" prefix or "*.ext" glob); repeatable
//   --include-tests      keep test/ and tests/ in the package (excluded by default)
//   --json               print the result as JSON
//
// Without --sign the package is unsigned; a DEV-SIGNATURE.json already present in the source
// is kept. A source directory that already contains SIGNATURE.json is refused unless --sign is
// given without --dev (the hub is the only writer of that file in distributed packages).
// Prints sha256 of the package, the digest, the kid and the entry count.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sdk = require(path.join(here, '..', 'plugins', 'sdk', 'index.js'));
const { pack, validateManifest } = sdk;

function usage(code = 0) {
  const out = code ? console.error : console.log;
  out(`Usage: build-plugin <dir> [--out file.whmplugin] [--sign <private.pem> [--dev]] [--kid <kid>] [--exclude <pattern>]... [--include-tests] [--json]`);
  process.exit(code);
}

function fail(message, details) {
  console.error(`build-plugin: ${message}`);
  if (details) for (const d of details) console.error(`  - ${d}`);
  process.exit(2);
}

export function parseArgs(argv) {
  const opts = { dir: null, out: null, sign: null, dev: false, kid: null, exclude: [], includeTests: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') opts.out = next();
    else if (a === '--sign') opts.sign = next();
    else if (a === '--dev') opts.dev = true;
    else if (a === '--kid') opts.kid = next();
    else if (a === '--exclude') opts.exclude.push(next());
    else if (a === '--include-tests') opts.includeTests = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.dev && !opts.sign) throw new Error('--dev requires --sign <private.pem>');
  if (opts.kid !== null && !pack.KID_RE.test(opts.kid)) throw new Error('--kid must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/');
  return opts;
}

/**
 * Build a package. Returns { out, bytes, sha256, digest, kid, signature, entries, manifest }.
 * Throws Error with .details for an invalid manifest.
 */
export function buildPlugin(opts) {
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${opts.dir} is not a directory`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (err) { throw new Error(`plugin.json could not be read: ${err.message}`); }
  const vr = validateManifest(manifest);
  if (!vr.ok) throw Object.assign(new Error('plugin.json is invalid'), { details: vr.errors.map((e) => `${e.path || '(root)'}: ${e.message}`) });
  const mainFile = path.resolve(dir, manifest.main);
  if (!mainFile.startsWith(dir + path.sep) || !fs.existsSync(mainFile)) throw new Error(`main "${manifest.main}" does not exist in ${opts.dir}`);

  const hasSig = fs.existsSync(path.join(dir, pack.SIGNATURE_FILE));
  const operatorSigning = Boolean(opts.sign) && !opts.dev;
  if (hasSig && !operatorSigning) throw new Error(`${opts.dir} already contains ${pack.SIGNATURE_FILE}; only the marketplace writes that file (remove it, or sign locally with --sign without --dev)`);

  const exclude = [...pack.DEFAULT_PACK_EXCLUDE.filter((e) => opts.includeTests ? !['test/', 'tests/'].includes(e) : true), ...opts.exclude];
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-build-plugin-'));
  try {
    const root = path.join(staging, 'pkg');
    fs.mkdirSync(root);
    for (const f of pack.walkFiles(dir, { exclude })) {
      const to = path.join(root, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.full, to);
      fs.chmodSync(to, f.mode & 0o100 ? 0o755 : 0o644);
    }
    let signature = null;
    let kid = null;
    if (opts.sign) {
      const pem = fs.readFileSync(path.resolve(opts.sign), 'utf8');
      kid = opts.kid || pack.kidOf(pem);
      const fileName = opts.dev ? pack.DEV_SIGNATURE_FILE : pack.SIGNATURE_FILE;
      const excludeFiles = opts.dev ? [...pack.SIGNATURE_FILES] : [pack.SIGNATURE_FILE];
      for (const f of opts.dev ? [pack.SIGNATURE_FILE] : []) fs.rmSync(path.join(root, f), { force: true });
      const sig = pack.sign(pack.packageDigest(root, { exclude: excludeFiles }), pem);
      pack.writeSignature(root, fileName, { kid, sig });
      signature = { file: fileName, kid, sig };
    }
    const buf = pack.packDirectory(root, { exclude: [] });
    const entries = pack.listPackage(buf);
    const out = path.resolve(opts.out || `${manifest.id}-${manifest.version}.whmplugin`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf, { mode: 0o644 });
    return {
      out, bytes: buf.length, sha256: pack.sha256(buf), digest: pack.packageDigest(root).toString('hex'), kid, signature,
      entries: entries.map((e) => e.name), manifest: { id: manifest.id, version: manifest.version, name: manifest.name },
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`build-plugin: ${err.message}`); usage(2); }
  if (opts.help) usage(0);
  if (!opts.dir) usage(2);
  let result;
  try { result = buildPlugin(opts); } catch (err) { fail(err.message, err.details); }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.manifest.id}@${result.manifest.version} → ${result.out}`);
    console.log(`  entries: ${result.entries.length}   bytes: ${result.bytes}`);
    console.log(`  sha256:  ${result.sha256}`);
    console.log(`  digest:  ${result.digest}`);
    console.log(result.signature ? `  signed:  ${result.signature.file} kid=${result.signature.kid}` : '  signed:  no (unsigned package)');
  }
}
