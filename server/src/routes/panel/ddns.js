import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate, z, fields } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, created, requireFeature } from './index.js';
import { createPanelDdnsService } from '../../services/panel-ddns.js';

const createBody = z.object({
  domain: fields.hostname,
  recordId: fields.id,
  label: z.string().trim().max(64).optional().nullable(),
}).strict();
const idParam = z.object({ id: fields.id });
const updateQuery = z.object({ ip: z.string().trim().max(64).optional(), format: z.enum(['json', 'text']).optional() });

// Public updates are keyed by caller address; the budget is generous for a
// router that retries every few minutes and tight for a token guess.
export const DDNS_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 60 };

// The update endpoint also takes the token out of the path, for clients that
// keep secrets out of URLs and access logs: HTTP basic with the token as the
// password and any user name (the ddclient/dyndns2 shape). Not `Bearer`: the
// panel's attachUser middleware reads every Bearer header as an API token and
// answers 401 for an unknown one before any public route runs.
export function headerToken(req) {
  const h = String(req.get('authorization') || '');
  const basic = h.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!basic) return null;
  const pair = Buffer.from(basic[1], 'base64').toString('utf8');
  const colon = pair.indexOf(':');
  return colon >= 0 ? pair.slice(colon + 1) : pair;
}

export async function register(ctx) {
  ctx.panelDdns = createPanelDdnsService(ctx);
  const s = ctx.panelDdns;

  // Scoped (session or panel:dns token) management under /api/panel/dns/ddns.
  const r = panelRouter(ctx, 'dns');
  r.use(requireFeature('ddns'));
  // A token never mints another credential: a panel:dns API token may read
  // the list but creating or revoking a non-expiring update URL needs a session.
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'Dynamic DNS tokens can only be managed from a browser session')) : next());
  r.get('/', wrap((req) => s.list(req.panel)));
  r.post('/', sessionOnly, validate({ body: createBody }), created((req) => s.create(req.panel, req.body, req)));
  r.delete('/:id', sessionOnly, validate({ params: idParam }), wrap((req) => s.revoke(req.panel, req.params.id, req)));

  // Public (no session, mounted before requireAuth like /panel/sso): the token
  // is the credential. `?format=text` answers the ddclient-style one-liner.
  // The limiter sits on the public handlers only: the scoped list/create/revoke
  // share this prefix and must never spend the per-address budget of a router
  // behind the same NAT.
  const pub = Router();
  const limiter = rateLimit({ ...DDNS_RATE_LIMIT, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many dynamic DNS updates, please wait' } } });
  // A malformed token is "unknown" (404), never a validation hint; the service applies DDNS_TOKEN_RE.
  const update = (token) => (req, res, next) => {
    Promise.resolve(s.update(token(req), { ip: req.query.ip }, req)).then((d) => {
      if (req.query.format === 'text') return res.type('text/plain').send(`${d.changed ? 'good' : 'nochg'} ${d.ip}\n`);
      return res.json({ data: d });
    }).catch(next);
  };
  pub.get('/update', limiter, validate({ query: updateQuery }), update(headerToken));
  pub.get('/:token', limiter, validate({ query: updateQuery }), update((req) => req.params.token));

  return [{ path: '/dns/ddns', router: r }, { path: '/dns/ddns', router: pub, public: true }];
}
