import fs from 'node:fs';
import path from 'node:path';

// Minimal ustar / GNU tar reader for plugin packages. It never spawns a process
// and accepts only what a plugin package needs: regular files, directories and
// GNU long-name records. Anything that could escape the destination directory
// (absolute names, "..", symlinks, hard links, devices, fifos) is refused.

const BLOCK = 512;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 2000;

export class TarError extends Error {
  constructor(message, entry) {
    super(message);
    this.name = 'TarError';
    this.code = 'invalid_package';
    if (entry !== undefined) this.entry = entry;
  }
}

function field(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

function octal(buf, offset, length, what) {
  const raw = buf.subarray(offset, offset + length);
  if (raw[0] & 0x80) throw new TarError(`${what}: base-256 numeric fields are not supported`);
  const text = field(buf, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`${what}: invalid numeric field "${text}"`);
  return parseInt(text, 8);
}

function checksumOk(header) {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += b >= 128 ? b - 256 : b;
  }
  const stored = octal(header, 148, 8, 'checksum');
  return stored === unsigned || stored === signed;
}

// Entry names may not contain whitespace or control characters: the signed
// package digest is built from `<name> <sha256>` lines, so a name holding a
// space or a newline could forge a line of another file.
export const UNSAFE_NAME_CHARS = /[\s\x00-\x1f\x7f]/;

// Returns the normalised relative name or throws.
export function safeEntryName(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new TarError('entry has an empty name');
  if (raw.includes('\0')) throw new TarError('entry name contains a NUL byte', raw);
  if (UNSAFE_NAME_CHARS.test(raw)) throw new TarError('entry name contains whitespace or a control character', raw);
  if (raw.includes('\\')) throw new TarError('entry name contains a backslash', raw);
  if (raw.startsWith('/')) throw new TarError('absolute entry names are not allowed', raw);
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw new TarError('entry name contains a ".." segment', raw);
  return segments.join('/');
}

function* entries(buf) {
  if (!Buffer.isBuffer(buf)) throw new TarError('archive must be a Buffer');
  let offset = 0;
  let longName = null;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) throw new TarError(`corrupt tar header at offset ${offset}`);
    const size = octal(header, 124, 12, 'size');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const magic = field(header, 257, 6);
    let name = field(header, 0, 100);
    const prefix = magic.startsWith('ustar') && !magic.startsWith('ustar ') ? field(header, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError(`truncated archive: entry "${name}" claims ${size} bytes`, name);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    offset = dataStart + padded;
    if (type === 'L') {
      longName = field(buf, dataStart, size);
      continue;
    }
    if (longName !== null) { name = longName; longName = null; }
    const mode = octal(header, 100, 8, 'mode') & 0o777;
    yield { name, type, size, mode, data: buf.subarray(dataStart, dataEnd) };
  }
}

const TYPE_LABEL = { 1: 'hard link', 2: 'symbolic link', 3: 'character device', 4: 'block device', 6: 'fifo', 7: 'contiguous file', x: 'PAX extended header', g: 'PAX global header' };

function classify(entry) {
  if (entry.type === '0') return 'file';
  if (entry.type === '5') return 'dir';
  const label = TYPE_LABEL[entry.type] || `type "${entry.type}"`;
  throw new TarError(`entry "${entry.name}" is a ${label}, which plugin packages may not contain`, entry.name);
}

/** List entries → [{ name, type: 'file'|'dir', size, mode }]. Validates every name and type. */
export function listTar(buf, { maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const e of entries(buf)) {
    const type = classify(e);
    const name = safeEntryName(e.name);
    if (name === '') continue;
    if (seen.has(name)) throw new TarError(`duplicate entry "${name}"`, name);
    seen.add(name);
    total += e.size;
    if (total > maxBytes) throw new TarError(`archive exceeds ${maxBytes} bytes when extracted`);
    out.push({ name, type, size: e.size, mode: e.mode });
    if (out.length > maxEntries) throw new TarError(`archive has more than ${maxEntries} entries`);
  }
  return out;
}

/** Extract into destDir (created if missing). Returns the entry list. */
export function extractTar(buf, destDir, { maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  const list = [];
  const seen = new Set();
  let total = 0;
  for (const e of entries(buf)) {
    const type = classify(e);
    const name = safeEntryName(e.name);
    if (name === '') continue;
    if (seen.has(name)) throw new TarError(`duplicate entry "${name}"`, name);
    seen.add(name);
    total += e.size;
    if (total > maxBytes) throw new TarError(`archive exceeds ${maxBytes} bytes when extracted`);
    list.push({ name, type, size: e.size, mode: e.mode });
    if (list.length > maxEntries) throw new TarError(`archive has more than ${maxEntries} entries`);
    const target = path.join(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new TarError('entry resolves outside the destination', name);
    // Every existing component must be a real directory: a symlink planted by an
    // earlier entry (or already present) would redirect the write elsewhere.
    let cur = root;
    for (const seg of name.split('/')) {
      cur = path.join(cur, seg);
      let st = null;
      try { st = fs.lstatSync(cur); } catch { break; }
      if (st.isSymbolicLink()) throw new TarError('refusing to write through a symbolic link', name);
      if (cur !== target && !st.isDirectory()) throw new TarError(`entry "${name}" has a file as a parent`, name);
    }
    try {
      if (type === 'dir') {
        fs.mkdirSync(target, { recursive: true, mode: 0o750 });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      fs.writeFileSync(target, e.data, { mode: (e.mode & 0o100 ? 0o750 : 0o640), flag: 'w' });
    } catch (err) {
      if (['EEXIST', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw new TarError(`entry "${name}" conflicts with an earlier entry (${err.code})`, name);
      throw err;
    }
  }
  return list;
}
