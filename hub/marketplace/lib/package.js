import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../shared/errors.js';

// The committed SDK is CommonJS; the hub loads it by path so no workspace link
// is needed. pack.js carries the host's package format, digest and signature
// encoding (standard base64 with padding) — nothing is reimplemented here.
const require = createRequire(import.meta.url);
const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/sdk');
export const pack = require(path.join(SDK_DIR, 'pack.js'));
export const sdk = require(path.join(SDK_DIR, 'index.js'));
export const validateManifest = sdk.validateManifest;
export const semver = sdk.semver;

export const SIGNATURE_FILE = pack.SIGNATURE_FILE;
export const DEV_SIGNATURE_FILE = pack.DEV_SIGNATURE_FILE;
export const MAX_PACKAGE_BYTES = pack.MAX_PACKAGE_BYTES;
export const MAX_EXTRACTED_BYTES = pack.MAX_EXTRACTED_BYTES;
export const MAX_ENTRIES = pack.MAX_ENTRIES;

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function invalid(message, entry) {
  return new HttpError(422, 'invalid_package', message, entry ? { entry: [entry] } : undefined);
}

// Unpacks a .whmplugin into a fresh temp dir with the host's limits and
// refusals. Returns { dir, root, entries, extractedBytes, cleanup }; `root`
// is the wrapper-stripped package root (the directory holding plugin.json).
export function unpack(buffer, { maxBytes = MAX_PACKAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalid('The upload is empty');
  if (buffer.length > maxBytes) throw invalid(`package exceeds ${maxBytes} bytes`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-pkg-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let entries;
  try {
    entries = pack.unpack(buffer, dir, { maxBytes: MAX_EXTRACTED_BYTES, maxEntries: MAX_ENTRIES });
  } catch (err) {
    cleanup();
    if (err?.name === 'PackError') throw invalid(err.message, err.entry);
    throw err;
  }
  let root;
  try { root = pack.packageRoot(dir); } catch (err) { cleanup(); throw invalid(err.message, 'plugin.json'); }
  const extractedBytes = entries.reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0);
  return { dir, root, entries, extractedBytes, cleanup };
}

// Moves the wrapper-stripped root to the top: digest, file list, scan and
// repack are all defined over it, and the repacked file has no wrapper.
export function stripWrapper(unpacked) {
  if (unpacked.root === unpacked.dir) return unpacked.dir;
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-hub-flat-'));
  fs.rmSync(flat, { recursive: true, force: true });
  fs.renameSync(unpacked.root, flat);
  fs.rmSync(unpacked.dir, { recursive: true, force: true });
  unpacked.dir = flat;
  unpacked.root = flat;
  unpacked.cleanup = () => fs.rmSync(flat, { recursive: true, force: true });
  return flat;
}

// Hex digest the way the host computes it (SIGNATURE.json excluded) or with
// the developer's exclusion list.
export function packageDigest(dir, { exclude = [SIGNATURE_FILE] } = {}) {
  return pack.packageDigest(dir, { exclude });
}

// Sorted canonical file list over the root: the lines packageDigest hashes.
export function fileList(root) {
  return pack.walkFiles(root, { exclude: [] }).map((f) => ({ path: f.rel, sha256: sha256(fs.readFileSync(f.full)), bytes: f.size }));
}

// Deterministic repack from the wrapper-stripped root (sorted entries, mtime 0, mode 0644/0755).
export function repackDeterministic(root) {
  return pack.packDirectory(root, { exclude: [] });
}

export function readManifest(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); } catch (err) { throw new HttpError(422, 'invalid_manifest', `plugin.json is not valid JSON: ${err.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new HttpError(422, 'invalid_manifest', 'plugin.json must be an object');
  return manifest;
}

export function readSignature(root, fileName) {
  try { return pack.readSignature(root, fileName); } catch (err) { throw new HttpError(422, 'invalid_signature', err.message); }
}

export const verifyDigest = (digest, sig, publicPem) => pack.verify(digest, sig, publicPem);
export const kidOf = (pem) => pack.kidOf(pem);
export const writeSignature = (dir, fileName, sig) => pack.writeSignature(dir, fileName, sig);
export const listPackage = (buf) => pack.listPackage(buf);

export function isTextPath(p) {
  return /\.(js|cjs|json|md|html|css|svg|txt|map)$/i.test(p) || /(^|\/)(LICENSE|README)(\.[a-z]+)?$/i.test(p);
}
