// The §18.3 reject/flag rule table as data, a small JavaScript tokeniser, the
// UTS #39-style skeleton used for typosquat checks and Damerau-Levenshtein.

export const FILE_EXTENSIONS = ['.js', '.cjs', '.json', '.md', '.html', '.css', '.svg', '.png', '.jpg', '.txt', '.map'];
export const FILE_BASENAMES = ['LICENSE', 'README'];
export const CODE_EXTENSIONS = ['.js', '.cjs', '.json'];

export const REQUIRE_ALLOWLIST = ['crypto', 'path', 'url', 'util', 'buffer', 'events', 'stream', 'string_decoder', 'querystring', 'zlib', 'assert', 'timers', 'whm/plugins/sdk'];
export const FORBIDDEN_IDENTIFIERS = ['eval', 'Reflect', 'process', 'globalThis', 'WebAssembly'];
export const HIGH_RISK_SCOPES = ['accounts:write', 'backups:restore'];
export const RESERVED_BRANDS = ['whm', 'cpanel', 'trywhm', 'imunify', 'wordpress', 'official'];
export const MINIFIED_BUNDLE_BYTES = 1024 * 1024;

export const SECRET_PATTERNS = [
  { code: 'private_key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { code: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { code: 'gcp_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { code: 'stripe_key', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { code: 'password_literal', re: /\bpassword\s*[:=]\s*["'][^"']{4,}["']/i },
];

export const RULES = [
  { id: 'require_outside_allowlist', action: 'reject', text: 'require() of a module outside the host allow-list' },
  { id: 'dynamic_require', action: 'reject', text: 'require() with a non-literal argument' },
  { id: 'forbidden_identifier', action: 'reject', text: 'eval, Reflect, process, globalThis or WebAssembly' },
  { id: 'function_constructor', action: 'reject', text: 'new Function / Function(' },
  { id: 'constructor_chain', action: 'reject', text: '.constructor.constructor' },
  { id: 'computed_constructor', action: 'reject', text: 'computed "constructor" property access' },
  { id: 'dynamic_import', action: 'reject', text: 'import()' },
  { id: 'identifier_escape', action: 'reject', text: '\\u or \\x escape inside an identifier or property name' },
  { id: 'file_type', action: 'reject', text: 'file type outside the allow-list' },
  { id: 'secret', action: 'reject', text: 'secret material in the package' },
  { id: 'undeclared_fetch', action: 'flag', text: 'fetch() or URL literal without a matching net:outbound scope' },
  { id: 'undeclared_agent_op', action: 'flag', text: 'ctx.agent.op() literal not covered by an agent:op scope' },
  { id: 'typosquat', action: 'flag', text: 'name resembles another plugin or a reserved brand' },
];

export function fileTypeAllowed(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (FILE_BASENAMES.some((b) => base === b || base.startsWith(`${b}.`))) return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return FILE_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// Tokeniser: strings, templates, comments, regex literals (heuristic), numbers,
// identifiers (raw text kept so escapes are visible) and punctuators.
// ---------------------------------------------------------------------------
const ID_START = /[A-Za-z_$\\ -￿]/;
const ID_PART = /[A-Za-z0-9_$\\ -￿]/;
const PUNCT3 = ['...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT2 = ['=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**'];
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '&&', '||', '??', '=>', 'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else']);

export function tokenize(src) {
  const text = String(src);
  const out = [];
  let i = 0;
  let line = 1;
  const push = (type, value, raw) => out.push({ type, value, raw: raw ?? value, line });
  const last = () => { for (let k = out.length - 1; k >= 0; k--) return out[k]; return null; };
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === 'punct' || t.type === 'ident') return REGEX_PRECEDERS.has(t.value);
    return false;
  };
  const templateDepth = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e === -1 ? text.length : e; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e === -1 ? text.length : e + 2;
      for (let k = i; k < end; k++) if (text[k] === '\n') line++;
      i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1; let val = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') { const d = decodeEscape(text, j); val += d.value; j = d.next; continue; }
        if (text[j] === '\n') break;
        val += text[j++];
      }
      push('string', val, text.slice(i, j + 1));
      i = j + 1; continue;
    }
    if (c === '`' || (c === '}' && templateDepth.length && templateDepth[templateDepth.length - 1] === 0)) {
      if (c === '}') templateDepth.pop();
      let j = i + 1; let val = '';
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') { const d = decodeEscape(text, j); val += d.value; j = d.next; continue; }
        if (text[j] === '`') { closed = true; break; }
        if (text[j] === '$' && text[j + 1] === '{') { break; }
        if (text[j] === '\n') line++;
        val += text[j++];
      }
      push('template', val, text.slice(i, j + 1));
      if (!closed && j < text.length) { templateDepth.push(0); i = j + 2; continue; }
      i = j + 1; continue;
    }
    if (templateDepth.length) {
      if (c === '{') templateDepth[templateDepth.length - 1]++;
      if (c === '}') templateDepth[templateDepth.length - 1]--;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      push('regex', text.slice(i, j));
      i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let j = i + 1;
      while (j < text.length && /[0-9A-Za-z_.]/.test(text[j])) j++;
      push('number', text.slice(i, j));
      i = j; continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < text.length && ID_PART.test(text[j])) j++;
      const raw = text.slice(i, j);
      push('ident', raw.replace(/\\u\{?[0-9a-fA-F]+\}?/g, (m) => safeFromCode(m)), raw);
      i = j; continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (PUNCT3.includes(three)) { push('punct', three); i += 3; continue; }
    if (PUNCT2.includes(two)) { push('punct', two); i += 2; continue; }
    push('punct', c);
    i++;
  }
  return out;
}

function safeFromCode(escape) {
  const hex = escape.replace(/^\\u\{?/, '').replace(/\}$/, '');
  const n = parseInt(hex, 16);
  return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeEscape(text, j) {
  const n = text[j + 1];
  if (n === 'u') {
    if (text[j + 2] === '{') { const e = text.indexOf('}', j); return { value: safeFromCode(text.slice(j, e + 1)), next: e + 1 }; }
    return { value: safeFromCode(text.slice(j, j + 6)), next: j + 6 };
  }
  if (n === 'x') { const h = text.slice(j + 2, j + 4); const v = parseInt(h, 16); return { value: Number.isFinite(v) ? String.fromCharCode(v) : '', next: j + 4 }; }
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' };
  return { value: map[n] ?? n ?? '', next: j + 2 };
}

// ---------------------------------------------------------------------------
// Skeleton (NFKC + confusables + case fold, separators removed) and distance.
// ---------------------------------------------------------------------------
const CONFUSABLES = {
  // Greek
  'α': 'a', 'Α': 'a', 'β': 'b', 'Β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'Ε': 'e', 'ζ': 'z', 'Ζ': 'z', 'η': 'n', 'Η': 'h', 'ι': 'i', 'Ι': 'i', 'κ': 'k', 'Κ': 'k', 'μ': 'u', 'Μ': 'm', 'ν': 'v', 'Ν': 'n', 'ο': 'o', 'Ο': 'o', 'ρ': 'p', 'Ρ': 'p', 'τ': 't', 'Τ': 't', 'υ': 'u', 'Υ': 'y', 'χ': 'x', 'Χ': 'x', 'ω': 'w',
  // Cyrillic
  'а': 'a', 'А': 'a', 'в': 'b', 'В': 'b', 'е': 'e', 'Е': 'e', 'ѕ': 's', 'Ѕ': 's', 'і': 'i', 'І': 'i', 'ј': 'j', 'Ј': 'j', 'к': 'k', 'К': 'k', 'м': 'm', 'М': 'm', 'н': 'h', 'Н': 'h', 'о': 'o', 'О': 'o', 'р': 'p', 'Р': 'p', 'с': 'c', 'С': 'c', 'т': 't', 'Т': 't', 'у': 'y', 'У': 'y', 'х': 'x', 'Х': 'x', 'ԁ': 'd', 'ԛ': 'q', 'ѡ': 'w', 'ꓲ': 'i',
  // Latin lookalikes and digits
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', '0': 'o', '1': 'l', '3': 'e', '5': 's', '7': 't', '8': 'b', '|': 'l', '¡': 'i', 'ĳ': 'ij', 'ǉ': 'lj', 'ⅰ': 'i', 'ⅼ': 'l', 'ⅴ': 'v', 'ⅹ': 'x',
};

export function skeleton(name) {
  let s = String(name || '').normalize('NFKC');
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of s) out += CONFUSABLES[ch] ?? ch;
  return out.toLowerCase().replace(/[\s\-_.]+/g, '');
}

export function damerauLevenshtein(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// ---------------------------------------------------------------------------
// Static scan of one JavaScript source → findings [{ rule, action, line, detail }].
// ---------------------------------------------------------------------------
function isRelativeSpec(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

export function scanSource(src, { scopes = [], matchesNetScope = () => false } = {}) {
  const findings = [];
  const add = (rule, line, detail) => findings.push({ rule, action: RULES.find((r) => r.id === rule)?.action || 'reject', line, detail });
  let tokens;
  try { tokens = tokenize(src); } catch (err) { add('require_outside_allowlist', 0, `tokeniser failed: ${err.message}`); return findings; }
  const netScopes = scopes.filter((s) => s.startsWith('net:outbound:'));
  const agentScopes = new Set(scopes.filter((s) => s.startsWith('agent:op:')).map((s) => s.slice('agent:op:'.length)));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    const afterDot = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.');
    if (t.type === 'ident' && /\\/.test(t.raw)) add('identifier_escape', t.line, t.raw);
    if (t.type === 'ident' && !afterDot) {
      if (t.value === 'require' && next?.value === '(') {
        const arg = tokens[i + 2];
        if (!arg || (arg.type !== 'string' && arg.type !== 'template') || tokens[i + 3]?.value !== ')') add('dynamic_require', t.line, 'require(<expression>)');
        else {
          const spec = arg.value.replace(/^node:/, '');
          if (!isRelativeSpec(arg.value) && !REQUIRE_ALLOWLIST.includes(spec)) add('require_outside_allowlist', t.line, arg.value);
        }
      }
      if (FORBIDDEN_IDENTIFIERS.includes(t.value)) add('forbidden_identifier', t.line, t.value);
      if (t.value === 'Function' && (next?.value === '(' || prev?.value === 'new')) add('function_constructor', t.line, 'Function(');
      if (t.value === 'import' && next?.value === '(') add('dynamic_import', t.line, 'import(');
      if (t.value === 'fetch' && next?.value === '(' && !netScopes.length) add('undeclared_fetch', t.line, 'fetch() without a net:outbound scope');
    }
    if (t.type === 'ident' && afterDot) {
      if (t.value === 'constructor' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'constructor') add('constructor_chain', t.line, '.constructor.constructor');
      if (t.value === 'fetch' && next?.value === '(' && !netScopes.length) add('undeclared_fetch', t.line, '.fetch() without a net:outbound scope');
      if (t.value === 'op' && next?.value === '(' && prev && tokens[i - 2]?.value === 'agent') {
        const arg = tokens[i + 2];
        if (arg?.type === 'string' && !agentScopes.has(arg.value)) add('undeclared_agent_op', t.line, arg.value);
      }
    }
    // A "constructor" literal only matters as a property key: x['constructor'], x?.['constructor'] or { 'constructor': … }.
    if ((t.type === 'string' || t.type === 'template') && t.value === 'constructor' && (prev?.value === '[' || next?.value === ':')) add('computed_constructor', t.line, t.raw);
    if (t.type === 'string' || t.type === 'template') {
      const m = /^https?:\/\/([^/\s:]+)(?::(\d+))?(\/|$)/i.exec(t.value);
      if (m) {
        const host = m[1].toLowerCase();
        const port = m[2] ? Number(m[2]) : 443;
        if (!netScopes.length || !matchesNetScope(host, port, netScopes)) add('undeclared_fetch', t.line, t.value.slice(0, 120));
      }
    }
  }
  return findings;
}

export function scanSecrets(text) {
  const out = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) out.push(p.code);
  return out;
}

export function looksMinified(text) {
  if (text.length < MINIFIED_BUNDLE_BYTES) return false;
  let longest = 0; let cur = 0;
  for (let i = 0; i < text.length; i++) { if (text.charCodeAt(i) === 10) { longest = Math.max(longest, cur); cur = 0; } else cur++; }
  return Math.max(longest, cur) > 5000;
}
