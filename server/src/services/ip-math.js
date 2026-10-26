import net from 'node:net';

// Pure address arithmetic for IP Functions: IPv4/IPv6 parsing, canonical text,
// CIDR bounds, range enumeration and netmask conversion. No system access.

export const familyOf = (address) => (net.isIPv6(address) ? 6 : net.isIPv4(address) ? 4 : 0);

export function ipv4ToInt(address) {
  if (!net.isIPv4(address)) throw new RangeError(`Not an IPv4 address: ${address}`);
  return address.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

export function intToIpv4(n) {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
}

export function ipv6ToBigInt(address) {
  if (!net.isIPv6(address)) throw new RangeError(`Not an IPv6 address: ${address}`);
  let text = address.split('%')[0];
  // Embedded IPv4 tail (::ffff:1.2.3.4) → two hextets.
  const v4 = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    text = text.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail = ''] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = text.includes('::') ? [...headParts, ...new Array(Math.max(0, missing)).fill('0'), ...tailParts] : headParts;
  if (parts.length !== 8) throw new RangeError(`Not an IPv6 address: ${address}`);
  return parts.reduce((acc, p) => (acc << 16n) + BigInt(parseInt(p || '0', 16)), 0n);
}

export function bigIntToIpv6(value) {
  const parts = [];
  for (let i = 7; i >= 0; i--) parts.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run of zero hextets (length ≥ 2), leftmost on ties.
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8;) {
    if (parts[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && parts[j] === 0) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const hex = parts.map((p) => p.toString(16));
  if (best.len < 2) return hex.join(':');
  const left = hex.slice(0, best.start).join(':');
  const right = hex.slice(best.start + best.len).join(':');
  return `${left}::${right}`;
}

// Canonical text form: lowercase compressed IPv6, unchanged IPv4.
export function canonical(address) {
  const family = familyOf(address);
  if (family === 6) return bigIntToIpv6(ipv6ToBigInt(address));
  if (family === 4) return address;
  throw new RangeError(`Not an IP address: ${address}`);
}

export function prefixToNetmask(prefix) {
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIpv4(bits);
}

export function netmaskToPrefix(mask) {
  if (mask == null || mask === '') return null;
  if (/^\/?\d{1,3}$/.test(String(mask))) { const n = Number(String(mask).replace('/', '')); return n >= 0 && n <= 128 ? n : null; }
  if (!net.isIPv4(mask)) return null;
  const bits = mask.split('.').map((p) => Number(p).toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return null;
  const idx = bits.indexOf('0');
  return idx === -1 ? 32 : idx;
}

// { family, first, last, size (BigInt), prefix, network } for "addr/prefix".
export function parseCidr(cidr) {
  const [addr, pfxText] = String(cidr).trim().split('/');
  const family = familyOf(addr);
  if (!family) throw new RangeError(`Not a CIDR network: ${cidr}`);
  const maxPrefix = family === 4 ? 32 : 128;
  const prefix = pfxText === undefined ? maxPrefix : Number(pfxText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) throw new RangeError(`Invalid prefix length in ${cidr}`);
  const bits = BigInt(maxPrefix);
  const value = family === 4 ? BigInt(ipv4ToInt(addr)) : ipv6ToBigInt(addr);
  const hostBits = bits - BigInt(prefix);
  const mask = ((1n << bits) - 1n) ^ ((1n << hostBits) - 1n);
  const first = value & mask;
  const last = first | ((1n << hostBits) - 1n);
  const toText = (n) => (family === 4 ? intToIpv4(Number(n)) : bigIntToIpv6(n));
  return { family, prefix, network: `${toText(first)}/${prefix}`, first: toText(first), last: toText(last), size: last - first + 1n, firstValue: first, lastValue: last };
}

export function toValue(address) {
  return familyOf(address) === 6 ? ipv6ToBigInt(address) : BigInt(ipv4ToInt(address));
}

export function fromValue(value, family) {
  return family === 6 ? bigIntToIpv6(value) : intToIpv4(Number(value));
}

export function cidrContains(cidr, address) {
  const c = parseCidr(cidr);
  if (familyOf(address) !== c.family) return false;
  const v = toValue(address);
  return v >= c.firstValue && v <= c.lastValue;
}

// Inclusive list of addresses between two of the same family, capped.
export function enumerateRange(start, end, { max = 256 } = {}) {
  const family = familyOf(start);
  if (!family || familyOf(end) !== family) throw new RangeError('Range endpoints must be IP addresses of the same family');
  const a = toValue(start);
  const b = toValue(end);
  if (b < a) throw new RangeError('Range end is before its start');
  if (b - a + 1n > BigInt(max)) throw new RangeError(`Range holds ${b - a + 1n} addresses; the maximum per operation is ${max}`);
  const out = [];
  for (let v = a; v <= b; v++) out.push(fromValue(v, family));
  return out;
}

// Addresses from a CIDR starting at `offset` (0 = network address), skipping any
// in `taken`. The reserved network/anycast address (offset 0) is skipped by default.
export function nextFreeInCidr(cidr, taken, { count = 1, offset = 1 } = {}) {
  const c = parseCidr(cidr);
  const used = new Set([...taken].map((t) => canonical(t)));
  const out = [];
  for (let v = c.firstValue + BigInt(offset); v <= c.lastValue && out.length < count; v++) {
    const text = fromValue(v, c.family);
    if (!used.has(text)) out.push(text);
  }
  return out;
}

export function isPrivateOrSpecial(address) {
  const family = familyOf(address);
  if (family === 4) {
    const n = ipv4ToInt(address);
    return n >>> 24 === 127 || n >>> 24 === 0 || (n >>> 16) === 0xa9fe || n >>> 24 === 10 || (n >>> 20) === 0xac1 || (n >>> 16) === 0xc0a8 || n >>> 28 === 0xe;
  }
  if (family === 6) {
    const v = ipv6ToBigInt(address);
    return v === 1n || v === 0n || (v >> 118n) === 0x3ffn || (v >> 120n) === 0xffn || (v >> 121n) === 0x7en;
  }
  return false;
}
