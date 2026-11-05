// Dependency-free QR code encoder (ISO/IEC 18004): byte mode, error-correction
// level M (L/Q/H tables included for completeness), versions 1–10 — enough for
// an otpauth:// enrolment URL of up to ~210 bytes. Output is a module matrix
// and an SVG path, nothing else; the pages render it inline.
//
// Encoding pipeline: data codewords (mode, count, bytes, terminator, padding)
// → Reed–Solomon blocks over GF(2^8) (0x11D) → interleaving → placement on the
// function-pattern grid → the mask with the lowest penalty → format/version
// information (BCH-coded).

export const EC_LEVELS = { L: 1, M: 0, Q: 3, H: 2 };
export const MAX_VERSION = 10;

// Per version: total codewords, then per level [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data].
const VERSIONS = [
  null,
  { total: 26, L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
  { total: 44, L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
  { total: 70, L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
  { total: 100, L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
  { total: 134, L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  { total: 172, L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
  { total: 196, L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
  { total: 242, L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
  { total: 292, L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
  { total: 346, L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [null, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// --- GF(256) arithmetic and Reed–Solomon ---------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

export function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const rem = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    if (factor === 0) continue;
    for (let j = 0; j < ecCount; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

// --- Data codewords ----------------------------------------------------------------

export function dataCapacity(version, level = 'M') {
  const [, g1n, g1d, g2n, g2d] = VERSIONS[version][level];
  return g1n * g1d + g2n * g2d;
}

export function byteCapacity(version, level = 'M') {
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCapacity(version, level) * 8 - 4 - countBits) / 8);
}

export function versionFor(byteLength, level = 'M') {
  for (let v = 1; v <= MAX_VERSION; v++) if (byteCapacity(v, level) >= byteLength) return v;
  throw new RangeError(`Too much data for a version ${MAX_VERSION} QR code (${byteLength} bytes)`);
}

export function toBytes(text) {
  if (text instanceof Uint8Array) return text;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
  return Uint8Array.from(Buffer.from(String(text), 'utf8'));
}

class BitBuffer {
  constructor() { this.bits = []; }
  push(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
}

export function dataCodewords(bytes, version, level = 'M') {
  const capacity = dataCapacity(version, level);
  const buf = new BitBuffer();
  buf.push(0b0100, 4);
  buf.push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) buf.push(b, 8);
  if (buf.length > capacity * 8) throw new RangeError('Data does not fit the chosen version');
  buf.push(0, Math.min(4, capacity * 8 - buf.length));
  while (buf.length % 8 !== 0) buf.push(0, 1);
  const out = [];
  for (let i = 0; i < buf.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
    out.push(byte);
  }
  for (let pad = 0xec; out.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) out.push(pad);
  return out;
}

export function interleave(data, version, level = 'M') {
  const [ecPerBlock, g1n, g1d, g2n, g2d] = VERSIONS[version][level];
  const blocks = [];
  let offset = 0;
  for (const [count, size] of [[g1n, g1d], [g2n, g2d]]) {
    for (let i = 0; i < count; i++) {
      const slice = data.slice(offset, offset + size);
      offset += size;
      blocks.push({ data: slice, ec: rsEncode(slice, ecPerBlock) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- Format and version information (BCH) ------------------------------------------

function bchRemainder(value, generator, degree) {
  let v = value << degree;
  for (let i = 31 - Math.clz32(v); i >= degree; i--) if (v & (1 << i)) v ^= generator << (i - degree);
  return v;
}

export function formatBits(level, mask) {
  const data = (EC_LEVELS[level] << 3) | mask;
  return ((data << 10) | bchRemainder(data, 0b10100110111, 10)) ^ 0b101010000010010;
}

export function versionBits(version) {
  return (version << 12) | bchRemainder(version, 0b1111100100101, 12);
}

// --- Matrix ---------------------------------------------------------------------------

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => { modules[r][c] = dark; reserved[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const edge = r === -1 || c === -1 || r === 7 || c === 7;
      const ring = r === 0 || c === 0 || r === 6 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, !edge && (ring || core));
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Alignment patterns skip the three finder corners; the ones centred on the
  // timing row/column (versions 7+) are drawn before the timing pattern.
  const positions = ALIGNMENT[version];
  const inFinder = (r0, c0) => (r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8);
  for (const r0 of positions) for (const c0 of positions) {
    if (inFinder(r0, c0)) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(r0 + r, c0 + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }

  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) set(6, i, i % 2 === 0);
    if (!reserved[i][6]) set(i, 6, i % 2 === 0);
  }

  // Format information areas (filled after masking) and the dark module.
  for (let i = 0; i < 9; i++) { reserved[8][i] = true; reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  set(size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[size - 11 + j][i] = true; reserved[i][size - 11 + j] = true; }
  }
  return { size, modules, reserved };
}

function placeData(matrix, codewords, version) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bits.push(0);
  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        modules[r][c] = index < bits.length ? bits[index] === 1 : false;
        index++;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, mask) {
  const { size, modules, reserved } = matrix;
  const fn = MASKS[mask];
  const out = modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c] && fn(r, c)) out[r][c] = !out[r][c];
  return out;
}

function writeFormat(modules, size, level, mask) {
  const bits = formatBits(level, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[8][i] = bit(14 - i);
  modules[8][7] = bit(8);
  modules[8][8] = bit(7);
  modules[7][8] = bit(6);
  for (let i = 9; i < 15; i++) modules[14 - i][8] = bit(14 - i);
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = bit(14 - i);
  for (let i = 7; i < 15; i++) modules[8][size - 15 + i] = bit(14 - i);
  modules[size - 8][8] = true;
}

function writeVersion(modules, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = size - 11 + (i % 3);
    modules[b][a] = dark;
    modules[a][b] = dark;
  }
}

export function penalty(modules) {
  const size = modules.length;
  let score = 0;
  const runs = (get) => {
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
  };
  runs((i, j) => modules[i][j]);
  runs((i, j) => modules[j][i]);
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = modules[r][c];
    if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
  }
  const pattern = [true, false, true, true, true, false, true];
  const finderLike = (get, i) => {
    for (let j = 0; j + 7 <= size; j++) {
      let ok = true;
      for (let k = 0; k < 7 && ok; k++) if (get(i, j + k) !== pattern[k]) ok = false;
      if (!ok) continue;
      const before = j >= 4 && [0, 1, 2, 3].every((k) => !get(i, j - 1 - k));
      const after = j + 11 <= size && [0, 1, 2, 3].every((k) => !get(i, j + 7 + k));
      if (before || after) score += 40;
    }
  };
  for (let i = 0; i < size; i++) { finderLike((a, b) => modules[a][b], i); finderLike((a, b) => modules[b][a], i); }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const percent = (dark * 100) / (size * size);
  const prev = Math.floor(percent / 5) * 5;
  score += Math.min(Math.abs(prev - 50) / 5, Math.abs(prev + 5 - 50) / 5) * 10;
  return score;
}

// Returns { version, size, mask, modules: boolean[][] } (modules[row][col], true = dark).
export function encodeQr(text, { level = 'M', mask: forcedMask = null, minVersion = 1 } = {}) {
  if (!(level in EC_LEVELS)) throw new RangeError(`Unknown error-correction level ${level}`);
  const bytes = toBytes(text);
  const version = Math.max(minVersion, versionFor(bytes.length, level));
  const codewords = interleave(dataCodewords(bytes, version, level), version, level);
  const matrix = buildFunctionPatterns(version);
  placeData(matrix, codewords, version);
  let best = null;
  const candidates = forcedMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const mask of candidates) {
    const modules = applyMask(matrix, mask);
    writeFormat(modules, matrix.size, level, mask);
    writeVersion(modules, matrix.size, version);
    const score = penalty(modules);
    if (!best || score < best.score) best = { mask, modules, score };
  }
  return { version, size: matrix.size, mask: best.mask, modules: best.modules };
}

// One SVG path covering every dark module of a 1-unit grid, offset by `margin` quiet-zone units.
export function qrPath(modules, margin = 4) {
  const parts = [];
  for (let r = 0; r < modules.length; r++) {
    let c = 0;
    while (c < modules.length) {
      if (!modules[r][c]) { c++; continue; }
      let end = c;
      while (end < modules.length && modules[r][end]) end++;
      parts.push(`M${c + margin} ${r + margin}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  }
  return parts.join('');
}

export function qrSvg(text, { level = 'M', margin = 4, size = 192, title = '' } = {}) {
  const { modules, size: n } = encodeQr(text, { level });
  const total = n + margin * 2;
  const escaped = String(title).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img"${title ? ` aria-label="${escaped}"` : ''}>${title ? `<title>${escaped}</title>` : ''}<rect width="${total}" height="${total}" fill="#fff"/><path d="${qrPath(modules, margin)}" fill="#000"/></svg>`;
}
