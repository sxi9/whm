import { z } from 'zod';

// The web-performance half of the panel-managed .htaccess block: mod_deflate
// compression (Optimize website) and referer-based hotlink protection. Both are
// rendered from a structured spec into a closed grammar, like the rest of the
// family in htaccess.js; this module owns the constants, the schema shape, the
// renderer, the grammar rules and the parser for these lines only. No ops.

export const DEFLATE_TYPES = [
  'text/html', 'text/plain', 'text/xml', 'text/css', 'text/javascript',
  'application/javascript', 'application/x-javascript', 'application/json', 'application/xml',
  'application/rss+xml', 'application/atom+xml', 'application/xhtml+xml', 'image/svg+xml',
  'font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/vnd.ms-fontobject',
];
export const HOTLINK_EXTENSIONS = [
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff',
  'mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav', 'pdf', 'zip', 'rar', '7z',
];
export const MAX_HOTLINK_HOSTS = 100;
export const HOTLINK_HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The redirect target is a RewriteRule substitution: no whitespace, quote,
// backslash, "$" or "%" (back-references and variable expansions), no "#" or
// brackets (flags), and a dotted host rather than a bare word.
export const HOTLINK_REDIRECT = /^https?:\/\/(?=.{1,2000}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~!*'(),:@&=+;/-]*)?(?:\?[A-Za-z0-9._~!*'(),:@&=+;/-]*)?$/;
const TYPES_PER_LINE = 6;

const orderOf = (list, values) => list.filter((v) => values.includes(v));

export const deflateSchema = z.object({ types: z.array(z.enum(DEFLATE_TYPES)).min(1).max(DEFLATE_TYPES.length) }).strict();
export const hotlinkSchema = z.object({
  hosts: z.array(z.string().regex(HOTLINK_HOST)).min(1).max(MAX_HOTLINK_HOSTS),
  extensions: z.array(z.enum(HOTLINK_EXTENSIONS)).min(1).max(HOTLINK_EXTENSIONS.length),
  allowBlank: z.boolean().default(true),
  redirect: z.string().regex(HOTLINK_REDIRECT).nullable().default(null),
}).strict().superRefine((h, ctx) => {
  // A redirect target that is itself a protected file would loop.
  if (h.redirect && redirectLoops(h.redirect, h.extensions)) ctx.addIssue({ code: 'custom', path: ['redirect'], message: 'The redirect target must not be one of the protected file types' });
});

export function redirectLoops(redirect, extensions) {
  let pathname;
  try { pathname = new URL(redirect).pathname.toLowerCase(); } catch { return true; }
  return extensions.some((e) => pathname.endsWith(`.${e}`));
}

export const webSchemaShape = {
  deflate: deflateSchema.nullable().default(null),
  hotlink: hotlinkSchema.nullable().default(null),
};

export const escapeHost = (host) => host.replace(/\./g, '\\.');
const unescapeHost = (s) => s.replace(/\\\./g, '.');

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export function renderWeb(s) {
  const lines = [];
  if (s.deflate) {
    lines.push('<IfModule mod_deflate.c>');
    for (const part of chunk(orderOf(DEFLATE_TYPES, s.deflate.types), TYPES_PER_LINE)) lines.push(`  AddOutputFilterByType DEFLATE ${part.join(' ')}`);
    lines.push('</IfModule>');
  }
  if (s.hotlink) {
    lines.push('<IfModule mod_rewrite.c>', '  RewriteEngine On');
    if (s.hotlink.allowBlank) lines.push('  RewriteCond %{HTTP_REFERER} !^$');
    for (const host of [...new Set(s.hotlink.hosts)]) lines.push(refererCond(host));
    const ext = orderOf(HOTLINK_EXTENSIONS, s.hotlink.extensions).join('|');
    lines.push(s.hotlink.redirect ? `  RewriteRule \\.(${ext})$ ${s.hotlink.redirect} [R=302,NC,L]` : `  RewriteRule \\.(${ext})$ - [F,NC,L]`);
    lines.push('</IfModule>');
  }
  return lines;
}

const refererCond = (host) => `  RewriteCond %{HTTP_REFERER} !^https?://(www\\.)?${escapeHost(host)}(:[0-9]+)?(/|$) [NC]`;
const REFERER_COND = /^ {2}RewriteCond %\{HTTP_REFERER\} !\^https\?:\/\/\(www\\\.\)\?(\S+)\(:\[0-9\]\+\)\?\(\/\|\$\) \[NC\]$/;
const HOTLINK_RULE = /^ {2}RewriteRule \\\.\(([a-z0-9|]+)\)\$ (\S+) \[(F|R=302),NC,L\]$/;
const DEFLATE_LINE = /^ {2}AddOutputFilterByType DEFLATE((?: \S+)+)$/;

export function parseRefererCond(line) {
  const m = line.match(REFERER_COND);
  if (!m) return null;
  const host = unescapeHost(m[1]);
  return HOTLINK_HOST.test(host) && escapeHost(host) === m[1] ? host : null;
}

export function parseHotlinkRule(line) {
  const m = line.match(HOTLINK_RULE);
  if (!m) return null;
  const extensions = m[1].split('|');
  if (!extensions.every((e) => HOTLINK_EXTENSIONS.includes(e)) || new Set(extensions).size !== extensions.length) return null;
  if (m[3] === 'F') return m[2] === '-' ? { extensions, redirect: null } : null;
  return HOTLINK_REDIRECT.test(m[2]) && !redirectLoops(m[2], extensions) ? { extensions, redirect: m[2] } : null;
}

export function parseDeflateLine(line) {
  const m = line.match(DEFLATE_LINE);
  if (!m) return null;
  const types = m[1].trim().split(' ');
  return types.every((t) => DEFLATE_TYPES.includes(t)) ? types : null;
}

export const WEB_GRAMMAR = [
  (l) => l === '<IfModule mod_deflate.c>' || l === '<IfModule mod_rewrite.c>' || l === '</IfModule>',
  (l) => parseDeflateLine(l) !== null,
  (l) => l === '  RewriteEngine On' || l === '  RewriteCond %{HTTP_REFERER} !^$',
  (l) => parseRefererCond(l) !== null,
  (l) => parseHotlinkRule(l) !== null,
];

export const emptyWeb = () => ({ deflateTypes: [], hosts: [], allowBlank: false, rule: null });

// Feeds one line into the accumulator; false when the line is none of ours.
export function parseWebLine(line, acc) {
  if (WEB_GRAMMAR[0](line) || line === '  RewriteEngine On') return true;
  if (line === '  RewriteCond %{HTTP_REFERER} !^$') { acc.allowBlank = true; return true; }
  const types = parseDeflateLine(line);
  if (types) { acc.deflateTypes.push(...types); return true; }
  const host = parseRefererCond(line);
  if (host) { acc.hosts.push(host); return true; }
  const rule = parseHotlinkRule(line);
  if (rule) { acc.rule = rule; return true; }
  return false;
}

// The spec fields from an accumulator; a rule without any host is reported as
// a foreign line rather than a half spec.
export function finishWeb(acc) {
  const deflate = acc.deflateTypes.length ? { types: orderOf(DEFLATE_TYPES, [...new Set(acc.deflateTypes)]) } : null;
  const hotlink = acc.rule && acc.hosts.length ? { hosts: [...new Set(acc.hosts)], extensions: acc.rule.extensions, allowBlank: acc.allowBlank, redirect: acc.rule.redirect } : null;
  return { deflate, hotlink, foreign: acc.rule && !acc.hosts.length ? 1 : 0 };
}
