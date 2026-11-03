import { z } from 'zod';
import { unprocessable } from './errors.js';

// zod 3's IPv6 validator, kept verbatim so the accepted set is unchanged: it allows a
// link-local zone id (fe80::1%eth0) and takes an embedded IPv4 tail only after "::" or
// "h:h:h:h::", where zod 4's z.ipv6() does the opposite on both counts.
const IPV6_RE = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

// Shared field schemas. Every identifier that reaches a system command is
// constrained here so nothing starting with "-" or containing shell metacharacters
// can ever become an argv element.
export const fields = {
  username: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Lowercase letters, digits, "_" or "-"; must start with a letter; max 32 chars'),
  domain: z.string().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Must be a valid fully-qualified domain name'),
  hostname: z.string().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Must be a valid hostname'),
  ipv4: z.ipv4(),
  ipv6: z.string().regex(IPV6_RE, 'Invalid IPv6 address'),
  ip: z.union([z.ipv4(), z.string().regex(IPV6_RE)], { error: 'Invalid IP address' }),
  email: z.email().max(254),
  password: z.string().min(8, 'At least 8 characters').max(128),
  packageName: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/, 'Letters, digits, spaces, "_", "." or "-"; max 64 chars'),
  dbName: z.string().regex(/^[a-z0-9_]{1,64}$/, 'Lowercase letters, digits or "_"; max 64 chars'),
  // An absolute path with no traversal segments. Services further restrict the root.
  absPath: z.string().regex(/^\/(?!(?:.*\/)?\.\.(?:\/|$))[^\0]*$/s, 'Must be an absolute path without ".." segments'),
  cron: z.string().regex(/^(\S+\s+){4}\S+$/, 'Must be a 5-field cron expression'),
  shell: z.enum(['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell']),
  id: z.coerce.number().int().positive(),
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

// A PATCH body derived from a create schema. zod 4's .partial() keeps a field's
// .default(), which would turn an absent key into the default and overwrite the
// stored value, so defaults are removed before the fields become optional.
export function patchOf(schema) {
  const shape = {};
  for (const [key, field] of Object.entries(schema.shape)) shape[key] = field instanceof z.ZodDefault ? field.removeDefault() : field;
  return schema.extend(shape).partial();
}

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

export { z };
