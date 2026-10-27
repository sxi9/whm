import { domainToASCII } from 'node:url';
import { HttpError } from '../../shared/errors.js';

export const DEFAULT_RESERVED = ['net.whm', 'net.trywhm', 'net.example', 'com.cpanel', 'net.cpanel', 'com.whm'];
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// A namespace is a lower-cased, IDNA-normalised reverse-DNS prefix of ≥ 2
// segments ("net.acme"). Returns the normalised form or throws 422.
export function normalize(ns) {
  const raw = String(ns || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\./, '');
  if (!raw) throw new HttpError(422, 'invalid_namespace', 'A namespace is required');
  const labels = raw.split('.').map((label) => {
    const ascii = domainToASCII(label);
    if (!ascii || !LABEL_RE.test(ascii)) throw new HttpError(422, 'invalid_namespace', `Namespace label "${label}" is not a valid DNS label`);
    return ascii;
  });
  if (labels.length < 2) throw new HttpError(422, 'invalid_namespace', 'A namespace needs at least two segments (e.g. net.acme)');
  if (labels.join('.').length > 200) throw new HttpError(422, 'invalid_namespace', 'Namespace is too long');
  return labels.join('.');
}

// net.acme ↔ acme.net
export const domainOf = (ns) => normalize(ns).split('.').reverse().join('.');
export const namespaceOfDomain = (domain) => String(domain).toLowerCase().split('.').reverse().join('.');

// net.acme covers net.acme.cache-boost, never net.acme-evil.x.
export const covers = (ns, id) => String(id).startsWith(`${ns}.`);

export function isReserved(ns, { reserved = [], bundledIds = [] } = {}) {
  const list = [...DEFAULT_RESERVED, ...reserved.map((r) => String(r).toLowerCase())];
  if (list.some((r) => ns === r || ns.startsWith(`${r}.`) || r.startsWith(`${ns}.`))) return true;
  // Every bundled-plugin id prefix (net.whm.x → net.whm, net.whm.x) is reserved.
  for (const id of bundledIds) {
    const segs = String(id).toLowerCase().split('.');
    for (let i = 2; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('.');
      if (ns === prefix || ns.startsWith(`${prefix}.`)) return true;
    }
    if (ns === String(id).toLowerCase()) return true;
  }
  return false;
}

// A namespace already held, or a prefix/extension of a held one, conflicts.
export function conflicts(ns, existing) {
  return existing.filter((e) => e === ns || e.startsWith(`${ns}.`) || ns.startsWith(`${e}.`));
}

// Evidence must sit on exactly the namespace's domain or its registrable parent.
export function evidenceHostAllowed(ns, host, psl) {
  const domain = domainOf(ns);
  const h = psl.normalizeHost(host);
  if (!h) return false;
  if (h === domain) return true;
  const reg = psl.registrableDomain(domain);
  return !!reg && h === reg;
}

// The PSL section of the suffix that governs `domain` (icann|private|null).
export function suffixSection(domain, psl) {
  const suffix = psl.publicSuffix(domain);
  if (!suffix) return null;
  const exact = psl.rules?.get(suffix);
  if (exact) return exact.section;
  const labels = suffix.split('.');
  const wildcard = psl.rules?.get(`*.${labels.slice(1).join('.')}`);
  return wildcard ? wildcard.section : null;
}

// PSL rule: the registrable domain must exist (≥ 2 labels), the domain itself
// must not be a public suffix, and a domain under a private-section suffix
// (acme.github.io) cannot be proven by DNS/well-known: GitHub organisations
// claim com.github.<org> through the OAuth method instead.
export function assertClaimable(ns, psl) {
  const domain = domainOf(ns);
  if (psl.isPublicSuffix(domain) || !psl.registrableDomain(domain)) {
    throw new HttpError(422, 'namespace_reserved', `"${ns}" maps to the public suffix "${domain}", which cannot be claimed`);
  }
  if (suffixSection(domain, psl) === 'private') {
    throw new HttpError(422, 'namespace_reserved', `"${ns}" maps to "${domain}", which sits on the hosting-platform suffix "${psl.publicSuffix(domain)}"; claim it through the GitHub-organisation method or use your own domain`);
  }
  return domain;
}
