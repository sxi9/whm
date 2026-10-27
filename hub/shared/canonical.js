// JCS (RFC 8785) subset shared byte-for-byte with the panel: object keys sorted
// by UTF-16 code unit, no whitespace, integers only, strings escaped only where
// JSON requires it, UTF-8 output. Anything JCS cannot represent losslessly
// (floats, NaN, Infinity, undefined, functions, symbols, bigint) throws so a
// non-canonical payload can never be signed by accident.
export class CanonicalError extends Error {
  constructor(message, path) {
    super(path ? `${message} at ${path}` : message);
    this.code = 'not_canonical';
  }
}

function serialize(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError('non-finite number', path);
      if (!Number.isInteger(value)) throw new CanonicalError('non-integer number', path);
      if (!Number.isSafeInteger(value)) throw new CanonicalError('integer outside the safe range', path);
      return Object.is(value, -0) ? '0' : String(value);
    case 'string': return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map((v, i) => serialize(v === undefined ? null : v, `${path}[${i}]`)).join(',')}]`;
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw new CanonicalError('binary values are not canonical JSON', path);
      if (typeof value.toJSON === 'function') throw new CanonicalError('objects with toJSON are not canonical', path);
      return `{${Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort(compareUtf16)
        .map((k) => `${JSON.stringify(k)}:${serialize(value[k], path ? `${path}.${k}` : k)}`)
        .join(',')}}`;
    default:
      throw new CanonicalError(`unsupported value type ${typeof value}`, path);
  }
}

// JavaScript's default string comparison already orders by UTF-16 code unit,
// which is exactly what RFC 8785 requires (surrogate pairs sort before U+FFFF).
function compareUtf16(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalString(value) {
  if (value === undefined) throw new CanonicalError('undefined is not canonical JSON');
  return serialize(value, '');
}

export function canonicalize(value) {
  return Buffer.from(canonicalString(value), 'utf8');
}

// True when `bytes` is the canonical form of the JSON it encodes.
export function isCanonical(bytes) {
  try {
    const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
    return canonicalString(JSON.parse(text)) === text;
  } catch {
    return false;
  }
}
