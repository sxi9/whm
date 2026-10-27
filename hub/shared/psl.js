import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainToASCII } from 'node:url';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'psl.dat');

// Public Suffix List rules (ICANN and private sections) with wildcard (*.) and
// exception (!) handling per https://publicsuffix.org/list/.
export function parsePsl(text) {
  const rules = new Map();
  let section = 'icann';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//')) {
      if (line.includes('===BEGIN PRIVATE DOMAINS===')) section = 'private';
      if (line.includes('===END PRIVATE DOMAINS===')) section = 'icann';
      continue;
    }
    const rule = line.split(/\s/)[0].toLowerCase();
    const exception = rule.startsWith('!');
    const name = domainToASCII(exception ? rule.slice(1) : rule);
    if (!name) continue;
    rules.set(name, { exception, wildcard: name.startsWith('*.'), section });
  }
  return rules;
}

export function createPsl({ file = BUNDLED, text } = {}) {
  const rules = parsePsl(text ?? fs.readFileSync(file, 'utf8'));

  function normalizeHost(host) {
    const ascii = domainToASCII(String(host || '').trim().toLowerCase().replace(/\.$/, ''));
    if (!ascii || !/^[a-z0-9.-]+$/.test(ascii)) return null;
    return ascii;
  }

  // Returns the number of labels that form the public suffix of `host`.
  function suffixLength(labels) {
    let best = null;
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      const exact = rules.get(candidate);
      if (exact) {
        if (exact.exception) return labels.length - i - 1;
        best = best == null ? labels.length - i : Math.max(best, labels.length - i);
      }
      const wildcard = rules.get(`*.${labels.slice(i + 1).join('.')}`);
      if (i + 1 < labels.length && wildcard) best = Math.max(best ?? 0, labels.length - i);
    }
    return best ?? 1;
  }

  function publicSuffix(host) {
    const h = normalizeHost(host);
    if (!h) return null;
    const labels = h.split('.');
    return labels.slice(labels.length - suffixLength(labels)).join('.');
  }

  function isPublicSuffix(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    return publicSuffix(h) === h;
  }

  // The registrable domain: the public suffix plus one label; null when the
  // host is itself a public suffix (or shorter).
  function registrableDomain(host) {
    const h = normalizeHost(host);
    if (!h) return null;
    const labels = h.split('.');
    const n = suffixLength(labels);
    if (labels.length <= n) return null;
    return labels.slice(labels.length - n - 1).join('.');
  }

  return { rules, size: rules.size, publicSuffix, isPublicSuffix, registrableDomain, normalizeHost, source: text ? 'inline' : file };
}

const bundled = createPsl();
export const registrableDomain = bundled.registrableDomain;
export const isPublicSuffix = bundled.isPublicSuffix;
export const publicSuffix = bundled.publicSuffix;
export default bundled;
