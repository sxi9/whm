# Category route modules

One file per WHM sidebar category, named after the category slug from
`client/src/nav.js` (e.g. `dns-functions.js`, `database-services.js`). Discovered and
mounted automatically by `routes/index.js` **after** authentication, so nothing here needs
to be registered anywhere else.

```js
// routes/categories/dns-functions.js
import { Router } from 'express';
import { validate, z, fields } from '../../lib/validate.js';
import { requireRoot, requireReseller } from '../../middleware/rbac.js';
import { createDnsService } from '../../services/dns.js';

export async function register(ctx) {
  ctx.dns = createDnsService(ctx);               // other categories reach it via ctx.dns at call time
  ctx.jobs.register('dns.sync', (job) => ctx.dns.syncAll(job));   // background jobs, if any
  ctx.scheduler.ensure('dns-cleanup', '30 3 * * 0', 'dns.cleanup'); // schedules, if any
  ctx.capabilities.register('bind', { binaries: ['named', 'rndc', 'named-checkzone'], required: ['named'] });

  const r = Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json(d?.meta ? d : { data: d })).catch(next);
  r.get('/zones', requireReseller, validate({ query: pagination }), wrap((req) => ctx.dns.listZones(req.query, req.user)));
  // ...
  return { path: '/dns', router: r };
}
```

Rules (see CLAUDE.md → "Category module contract" for the full list):
- Thin routes: validate → service → envelope. Services hold all logic and call the agent.
- Reach other categories' services through `ctx.<name>` **inside handlers**, never at
  construction time (modules load alphabetically).
- Every mutating route must be reachable only by the right role and is auto-audited.
