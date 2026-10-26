// Locale XML interchange format, written and parsed without any XML library:
//
//   <?xml version="1.0" encoding="UTF-8"?>
//   <locale code="es" name="Español" base="en">
//     <string key="common.home">Inicio</string>
//   </locale>
//
// The parser accepts exactly this shape. It refuses a DOCTYPE (no entity
// expansion, no external references), comments and processing instructions are
// skipped, and every problem is reported with its line number.

export const LOCALE_CODE_RE = /^[a-z]{2,3}(_[a-z0-9]{2,8})?$/;
export const STRING_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export const MAX_XML_BYTES = 2 * 1024 * 1024;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c]);

export function decodeEntities(text, onError) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]+);/g, (m, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch { /* fallthrough */ } }
    }
    onError?.(`unknown entity ${m}`);
    return m;
  });
}

export function buildLocaleXml({ code, name, base = 'en', strings }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<locale code="${escapeXml(code)}" name="${escapeXml(name)}" base="${escapeXml(base)}">`];
  for (const key of Object.keys(strings).sort()) {
    const value = strings[key];
    if (value == null) continue;
    lines.push(`  <string key="${escapeXml(key)}">${escapeXml(value)}</string>`);
  }
  lines.push('</locale>', '');
  return lines.join('\n');
}

function parseAttributes(src, lineAt, errors) {
  const attrs = {};
  const re = /\s+([A-Za-z_][A-Za-z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index !== consumed) break;
    const value = m[3] ?? m[4];
    if (/[<]/.test(value)) errors.push(`line ${lineAt}: attribute ${m[1]} contains "<"`);
    if (m[1] in attrs) errors.push(`line ${lineAt}: duplicate attribute ${m[1]}`);
    attrs[m[1]] = decodeEntities(value, (e) => errors.push(`line ${lineAt}: ${e}`));
    consumed = re.lastIndex;
  }
  if (src.slice(consumed).trim() !== '') errors.push(`line ${lineAt}: malformed attribute list "${src.trim().slice(0, 40)}"`);
  return attrs;
}

// Returns { ok, errors: string[], locale: { code, name, base, strings } | null }.
// Validation errors never throw so the caller can render them as 422 field messages.
export function parseLocaleXml(input) {
  const errors = [];
  if (typeof input !== 'string') return { ok: false, errors: ['document must be text'], locale: null };
  if (Buffer.byteLength(input, 'utf8') > MAX_XML_BYTES) return { ok: false, errors: [`document is larger than ${MAX_XML_BYTES} bytes`], locale: null };
  const text = input.replace(/^﻿/, '');
  if (/<!DOCTYPE/i.test(text)) return { ok: false, errors: ['DOCTYPE declarations are not allowed'], locale: null };
  if (/[\0]/.test(text)) return { ok: false, errors: ['document contains NUL bytes'], locale: null };

  // Positions are only ever queried in increasing order, so the line counter
  // advances from the last query instead of rescanning from offset 0 (which
  // made the parser O(tags x bytes) and let a 2 MB upload block the event loop).
  let lineNo = 1;
  let linePos = 0;
  const lineAt = (p) => {
    const end = Math.min(p, text.length);
    for (let i = linePos; i < end; i++) if (text.charCodeAt(i) === 10) lineNo++;
    if (end > linePos) linePos = end;
    return lineNo;
  };
  let pos = 0;
  const strings = {};
  let root = null;
  let rootClosed = false;
  let openString = null;

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const chunk = lt === -1 ? text.slice(pos) : text.slice(pos, lt);
    if (openString) {
      openString.text += chunk;
    } else if (chunk.trim() !== '') {
      errors.push(`line ${lineAt(pos)}: unexpected text "${chunk.trim().slice(0, 40)}"`);
    }
    if (lt === -1) break;
    pos = lt;
    const line = lineAt(pos);
    if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos);
      if (end === -1) { errors.push(`line ${line}: unterminated processing instruction`); break; }
      pos = end + 2;
      continue;
    }
    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos);
      if (end === -1) { errors.push(`line ${line}: unterminated comment`); break; }
      pos = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', pos)) {
      const end = text.indexOf(']]>', pos);
      if (end === -1) { errors.push(`line ${line}: unterminated CDATA section`); break; }
      if (openString) openString.cdata += text.slice(pos + 9, end); else errors.push(`line ${line}: CDATA outside a <string> element`);
      pos = end + 3;
      continue;
    }
    const gt = text.indexOf('>', pos);
    if (gt === -1) { errors.push(`line ${line}: unterminated tag`); break; }
    const raw = text.slice(pos + 1, gt);
    pos = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (name === 'string') {
        if (!openString) { errors.push(`line ${line}: </string> without an open element`); continue; }
        finishString(openString, strings, errors);
        openString = null;
      } else if (name === 'locale') {
        if (openString) { errors.push(`line ${line}: </locale> closes an open <string>`); finishString(openString, strings, errors); openString = null; }
        if (!root) errors.push(`line ${line}: </locale> before <locale>`);
        rootClosed = true;
      } else {
        errors.push(`line ${line}: unexpected closing tag </${name}>`);
      }
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_:.-]*)/);
    if (!nameMatch) { errors.push(`line ${line}: malformed tag <${raw.slice(0, 40)}>`); continue; }
    const name = nameMatch[1];
    const attrs = parseAttributes(body.slice(name.length), line, errors);
    if (name === 'locale') {
      if (root) errors.push(`line ${line}: more than one <locale> element`);
      if (rootClosed) errors.push(`line ${line}: content after </locale>`);
      root = { line, ...attrs };
      if (selfClosing) rootClosed = true;
      continue;
    }
    if (name === 'string') {
      if (!root) errors.push(`line ${line}: <string> outside <locale>`);
      if (rootClosed) errors.push(`line ${line}: <string> after </locale>`);
      if (openString) { errors.push(`line ${line}: nested <string> elements`); finishString(openString, strings, errors); }
      openString = { line, key: attrs.key, text: '', cdata: '' };
      if (selfClosing) { finishString(openString, strings, errors); openString = null; }
      continue;
    }
    errors.push(`line ${line}: unknown element <${name}>`);
  }
  if (openString) errors.push(`line ${openString.line}: <string> is never closed`);
  if (!root) errors.push('no <locale> root element');
  else if (!rootClosed) errors.push(`line ${root.line}: <locale> is never closed`);

  let locale = null;
  if (root) {
    const code = typeof root.code === 'string' ? root.code.trim().toLowerCase().replace(/-/g, '_') : '';
    if (!code) errors.push(`line ${root.line}: <locale> needs a code attribute`);
    else if (!LOCALE_CODE_RE.test(code)) errors.push(`line ${root.line}: locale code "${root.code}" must look like "es" or "pt_br"`);
    const name = typeof root.name === 'string' ? root.name.trim() : '';
    if (name.length > 80) errors.push(`line ${root.line}: name is longer than 80 characters`);
    const base = typeof root.base === 'string' && root.base.trim() ? root.base.trim().toLowerCase() : 'en';
    if (!LOCALE_CODE_RE.test(base)) errors.push(`line ${root.line}: base "${root.base}" is not a locale code`);
    locale = { code, name, base, strings };
  }
  return { ok: errors.length === 0, errors, locale: errors.length === 0 ? locale : null };
}

function finishString(entry, strings, errors) {
  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (!key) { errors.push(`line ${entry.line}: <string> needs a key attribute`); return; }
  if (!STRING_KEY_RE.test(key)) { errors.push(`line ${entry.line}: key "${key.slice(0, 40)}" has unsupported characters`); return; }
  if (key in strings) { errors.push(`line ${entry.line}: duplicate key "${key}"`); return; }
  const value = decodeEntities(entry.text, (e) => errors.push(`line ${entry.line}: ${e}`)) + entry.cdata;
  if (value.length > 2000) { errors.push(`line ${entry.line}: value for "${key}" is longer than 2000 characters`); return; }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) { errors.push(`line ${entry.line}: value for "${key}" contains control characters`); return; }
  strings[key] = value;
}
