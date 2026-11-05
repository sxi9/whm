import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap, requireFeature } from './index.js';
import net from 'node:net';
import { createPanelDnsTrackService, FEATURE, LOOKUP_TYPES, isPublicAddress } from '../../services/panel-dns-track.js';

// A hostname or a literal address; anything else (an option, a shell token,
// a path) fails here with 422 before the agent's own schema sees it. A
// literal must be public: no probing of loopback, private, link-local or
// multicast ranges from the host.
const target = z.string().trim().max(253).pipe(z.union([fields.hostname, fields.ip], { error: 'Must be a hostname or an IP address' }))
  .refine((v) => !net.isIP(v) || isPublicAddress(v), { message: 'Only public addresses can be looked up or traced' });
const lookupQuery = z.object({ name: target, type: z.enum(LOOKUP_TYPES).default('A') }).strict();
const traceQuery = z.object({ host: target }).strict();

export async function register(ctx) {
  ctx.panelDnsTrack = createPanelDnsTrackService(ctx);
  const s = ctx.panelDnsTrack;

  const r = panelRouter(ctx, 'dns');
  r.use(requireFeature(FEATURE));
  r.get('/lookup', validate({ query: lookupQuery }), wrap((req) => s.lookup(req.panel, req.query, req)));
  r.get('/trace', validate({ query: traceQuery }), wrap((req) => s.trace(req.panel, req.query, req)));

  return { path: '/dns/track', router: r };
}
