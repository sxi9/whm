import { z } from 'zod';
import { unprocessable } from './errors.js';

const HEX64 = /^[0-9a-f]{64}$/;
// zod 3's IPv6 validator, kept verbatim so the accepted set is unchanged (zone ids allowed,
// embedded IPv4 only after "::" or "h:h:h:h::"), where zod 4's z.ipv6() does the opposite.
const IPV6_RE = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

export const fields = {
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'At least 10 characters').max(128),
  id: z.string().regex(/^[a-z]{2,4}_[0-9A-Za-z]{6,40}$/, 'Malformed identifier'),
  kid: z.string().regex(/^[0-9a-f]{8}$/, 'A key id is 8 hex characters'),
  purpose: z.enum(['license', 'plugin']),
  sku: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'Malformed SKU'),
  licenseKey: z.string().trim().min(16).max(40).regex(/^[A-Za-z0-9 *~$=-]+$/, 'Malformed license key'),
  licensePrefix: z.string().trim().toUpperCase().regex(/^WHM-[0-9A-HJKMNP-TV-Z]{4}$/, 'A key prefix looks like WHM-XXXX'),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'Malformed fingerprint'),
  fpComponents: z.object({
    machine_id: z.string().regex(HEX64),
    mac: z.string().regex(HEX64),
    disk: z.string().regex(HEX64),
  }).strict(),
  hostname: z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'Must be a valid hostname'),
  panelVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
  os: z.string().regex(/^[0-9A-Za-z._ -]{1,64}$/).optional(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'Malformed nonce'),
  ts: z.number().int().min(0),
  token: z.string().regex(/^WHMT1\.[A-Za-z0-9_-]{16,16384}\.[A-Za-z0-9_-]{80,100}$/, 'Malformed token'),
  reason: z.string().trim().max(500).optional(),
  termMonths: z.number().int().min(1).max(120),
  ip: z.union([z.ipv4(), z.string().regex(IPV6_RE)], { error: 'Invalid IP address' }),
  url: z.url().max(2048).refine((u) => u.startsWith('https://'), 'Must be an https URL'),
  cents: z.number().int().min(0).max(1e9),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
};

export const pagination = z.object({
  page: fields.page,
  pageSize: fields.pageSize,
  q: z.string().trim().max(200).optional(),
  sort: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  dir: fields.sortDir,
});

function formatIssues(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ||= []).push(issue.message);
  }
  return out;
}

// validate({ body, query, params }) -> express middleware that replaces the
// request parts with their parsed (coerced, defaulted) values.
export function validate(schemas) {
  return (req, _res, next) => {
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        return next(unprocessable('Request validation failed', formatIssues(result.error)));
      }
      req[part] = result.data;
    }
    next();
  };
}

// For services that validate outside a request (CLI, jobs, hooks).
export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw unprocessable('Validation failed', formatIssues(result.error));
  return result.data;
}

export { z };

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
