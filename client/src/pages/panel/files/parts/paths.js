// Pure helpers of the Files group: every path the pages send is relative to the
// account home ('' means the home itself), exactly what the API's relPath accepts.

export const MAX_TEXT_BYTES = 4 * 1024 * 1024;
export const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz)$/i;
export const TEXT_RE = /\.(txt|md|html?|htaccess|css|scss|less|js|mjs|cjs|jsx|ts|tsx|json|xml|yml|yaml|ini|conf|cfg|env|log|php|phtml|py|rb|pl|sh|sql|csv|svg|toml|lock|twig|tpl|vue|htpasswd|cnf)$/i;

export function normalizeRel(input) {
  const parts = String(input ?? '').replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  return parts.join('/');
}

export function joinRel(dir, name) {
  const d = normalizeRel(dir) ?? '';
  const n = String(name ?? '').replace(/^\/+|\/+$/g, '');
  return d ? (n ? `${d}/${n}` : d) : n;
}

export function parentOf(rel) {
  const p = normalizeRel(rel) ?? '';
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function baseName(rel) {
  const p = normalizeRel(rel) ?? '';
  return p.slice(p.lastIndexOf('/') + 1);
}

// [{ name, path }] from the home down to `rel`, without the home itself.
export function segmentsOf(rel) {
  const parts = (normalizeRel(rel) ?? '').split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

export const listPath = (dir) => `/files/list?path=${encodeURIComponent(normalizeRel(dir) ?? '')}&limit=10000`;
export const duPath = (dir, depth = 1) => `/files/du?path=${encodeURIComponent(normalizeRel(dir) ?? '')}&depth=${depth}`;
export const downloadHref = (rel) => `/api/panel/files/download?path=${encodeURIComponent(rel)}`;
export const managerHref = (dir) => `/panel/files/file-manager${dir ? `?path=${encodeURIComponent(dir)}` : ''}`;
export const diskUsageHref = (dir) => `/panel/files/disk-usage${dir ? `?path=${encodeURIComponent(dir)}` : ''}`;

export const isArchiveName = (name) => ARCHIVE_RE.test(String(name ?? ''));
export const isEditable = (entry) => Boolean(entry) && entry.type === 'file' && (entry.size ?? 0) <= MAX_TEXT_BYTES;
export const looksLikeText = (name) => TEXT_RE.test(String(name ?? '')) || /^\.[a-z0-9_-]+$/i.test(String(name ?? ''));

export function filterEntries(entries, q = '', showHidden = true) {
  const needle = q.trim().toLowerCase();
  return (entries || []).filter((e) => (showHidden || !e.name.startsWith('.')) && (!needle || e.name.toLowerCase().includes(needle)));
}

// Directories first, then the chosen column; name order is locale-aware.
export function sortEntries(entries, sort = 'name', dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = (a, b) => {
    if (sort === 'size') return (a.size ?? 0) - (b.size ?? 0);
    if (sort === 'mtime') return String(a.mtime ?? '').localeCompare(String(b.mtime ?? ''));
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  };
  return [...(entries || [])].sort((a, b) => {
    const ad = a.type === 'dir', bd = b.type === 'dir';
    if (ad !== bd) return ad ? -1 : 1;
    return sign * cmp(a, b);
  });
}

const WHO = ['owner', 'group', 'others'];
const BIT = { r: 4, w: 2, x: 1 };

// '0644' → { owner: { r, w, x }, group: {...}, others: {...} }
export function modeToBits(mode) {
  const digits = String(mode ?? '').replace(/^0(?=[0-7]{3}$)/, '').slice(-3).padStart(3, '0');
  const out = {};
  WHO.forEach((who, i) => {
    const n = parseInt(digits[i], 8) || 0;
    out[who] = { r: Boolean(n & 4), w: Boolean(n & 2), x: Boolean(n & 1) };
  });
  return out;
}

export function bitsToMode(bits) {
  return `0${WHO.map((who) => ['r', 'w', 'x'].reduce((n, k) => n + (bits?.[who]?.[k] ? BIT[k] : 0), 0)).join('')}`;
}

export const isValidMode = (mode) => /^0?[0-7]{3,4}$/.test(String(mode ?? '')) && !(parseInt(mode, 8) & 0o6000);

// rwxr-xr-x for a '0755' mode string.
export function modeText(mode) {
  const b = modeToBits(mode);
  return WHO.map((who) => ['r', 'w', 'x'].map((k) => (b[who][k] ? k : '-')).join('')).join('');
}

export function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export const isCapabilityError = (error) => Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
export const isFeatureDisabled = (error) => Boolean(error) && error.status === 403 && error.code === 'feature_disabled';

export function archiveNameFor(paths, format) {
  const first = baseName(paths?.[0] ?? '') || 'archive';
  const stem = paths?.length > 1 ? 'files' : first.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
  return `${stem}.${format}`;
}
