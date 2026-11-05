import { Router } from 'express';
import { validate, z } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, requireFeature } from './index.js';

// /api/panel/plugins — the account-panel side of the plugin host (contract §53).
// Everything here answers for the ONE account pinned by panelScope: the page
// catalog and page files are filtered to audience 'panel', and a plugin route
// is dispatched with the scope attached, so a handler finds the account as
// req.panel and the host only lets routes that list the 'user' role answer.
// No panel:* token scope exists for this group: reads work with panel:read,
// mutations through a plugin route are browser-session actions.

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/;
const ID_MAX = 128;
const idParam = z.object({ id: z.string().max(ID_MAX).regex(ID_RE, 'Reverse-DNS plugin id with at least three segments') });
const fileQuery = z.object({ path: z.string().max(512).regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9_./-]+\.(md|html)$/) });

async function scopeOf(ctx, req) {
  if (req.panel) return req.panel;
  if (typeof ctx.panel?.scope !== 'function') throw new HttpError(403, 'panel_scope_required', 'This endpoint needs a customer panel session');
  return ctx.panel.scope(req);
}

export function register(ctx) {
  const host = () => ctx.plugins;
  const r = panelRouter(ctx, 'plugins');
  r.use((req, _res, next) => {
    Promise.resolve(scopeOf(ctx, req)).then((scope) => { req.panel = scope; next(); }).catch(next);
  });
  r.use(requireFeature('plugins'));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((d) => res.json({ data: d })).catch(next);
  const hostReady = (req, _res, next) => next(host() ? undefined : new HttpError(501, 'capability_missing', 'The plugin host is not available on this server'));

  r.get('/ui', hostReady, wrap(() => host().uiCatalog({ audience: 'panel' })));
  r.get('/ui/:id/file', hostReady, validate({ params: idParam, query: fileQuery }), wrap((req) => {
    const f = host().pageFile(req.params.id, req.query.path, { audience: 'panel' });
    return { kind: f.kind, content: f.content };
  }));

  // Plugin routes: /api/panel/plugins/<id>/... dispatched by the host with the
  // account scope; "ui" is never a valid plugin id (three dotted segments).
  r.use('/:id', hostReady, (req, res, next) => {
    const id = req.params.id;
    if (!ID_RE.test(id) || id.length > ID_MAX) return next();
    host().dispatch(id, req, res, { panel: req.panel }).catch(next);
  });

  return { path: '/plugins', router: r };
}
