import crypto from 'node:crypto';

// Human license keys: WHM-XXXX-XXXX-XXXX-XXXX. 15 Crockford base32 characters
// (75 random bits) followed by one Crockford mod-37 check character.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CHECK_ALPHABET = ALPHABET + '*~$=U';
export const PREFIX = 'WHM';
const DATA_LENGTH = 15;

function checkChar(data) {
  let value = 0n;
  for (const ch of data) value = value * 32n + BigInt(ALPHABET.indexOf(ch));
  return CHECK_ALPHABET[Number(value % 37n)];
}

function group(chars) {
  return `${PREFIX}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

export function generate() {
  const bytes = crypto.randomBytes(DATA_LENGTH);
  let data = '';
  for (let i = 0; i < DATA_LENGTH; i++) data += ALPHABET[bytes[i] % 32];
  return group(data + checkChar(data));
}

// Accepts any case, optional dashes/spaces and an optional WHM prefix, and maps
// the Crockford look-alikes (O->0, I/L->1) in the data characters. Returns the
// formatted key or null when the input cannot be a key at all.
export function normalize(input) {
  if (typeof input !== 'string') return null;
  let s = input.toUpperCase().replace(/[\s-]+/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  if (s.length !== DATA_LENGTH + 1) return null;
  const data = s.slice(0, DATA_LENGTH).replace(/O/g, '0').replace(/[IL]/g, '1');
  const check = s[DATA_LENGTH];
  if (![...data].every((c) => ALPHABET.includes(c))) return null;
  if (!CHECK_ALPHABET.includes(check)) return null;
  return group(data + check);
}

export function check(input) {
  const key = normalize(input);
  if (!key) return false;
  const chars = key.slice(PREFIX.length + 1).replace(/-/g, '');
  return checkChar(chars.slice(0, DATA_LENGTH)) === chars[DATA_LENGTH];
}

export function prefixOf(input) {
  const key = normalize(input);
  return key ? key.slice(0, PREFIX.length + 5) : null;
}

// The hub stores only this; the clear-text key is shown once at issue time.
export function hash(input) {
  const key = normalize(input);
  if (!key) throw new Error('cannot hash a malformed license key');
  return crypto.createHash('sha256').update(key).digest('hex');
}
