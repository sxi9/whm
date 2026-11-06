import { validate, z } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, created, requireFeature } from './index.js';
import { createPanelTerminalService, FEATURE } from '../../services/panel-terminal.js';

// /api/panel/terminal — mounted by routes/categories/panel.js behind panelScope.
// Every route is session-only: a terminal is a browser thing, and the WebSocket
// upgrade at /api/panel/terminal/ws (served by index.js, not by this router)
// needs the session cookie as well as the single-use token minted here.

const openBody = z.object({ cols: z.number().int().min(20).max(500).optional(), rows: z.number().int().min(5).max(200).optional() }).strict();
const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/, 'A terminal session id') });

export function register(ctx) {
  ctx.panelTerminal = createPanelTerminalService(ctx);
  const svc = () => ctx.panelTerminal;
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'The terminal can only be opened from a browser session')) : next());

  const r = panelRouter(ctx, 'terminal');
  r.use(sessionOnly, requireFeature(FEATURE));
  r.get('/sessions', wrap((req) => svc().list(req.panel, req)));
  r.post('/sessions', validate({ body: openBody }), created((req) => svc().open(req.panel, req.body, req)));
  r.delete('/sessions/:id', validate({ params: idParam }), wrap((req) => svc().close(req.panel, req.params.id, req)));

  return { path: '/terminal', router: r };
}
