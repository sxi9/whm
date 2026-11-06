import { validate, z } from '../../lib/validate.js';
import { HttpError } from '../../lib/errors.js';
import { panelRouter, wrap, requireFeature } from './index.js';
import { createPanelDavService, PASSWORD_MIN_LENGTH } from '../../services/panel-dav.js';
import { DAV_LOGIN_RE } from '../../services/dav.js';

const loginParam = z.object({ login: z.string().max(254).regex(DAV_LOGIN_RE, 'A DAV login such as name@example.com') });
const passwordBody = z.object({ password: z.string().min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`).max(128) }).strict();

// Calendars and Contacts (contract §70): /api/panel/email/calendars. Setting or
// removing a DAV password mints a credential, so it needs a browser session;
// a panel:email token may read the status and the collections.
export async function register(ctx) {
  ctx.panelDav = createPanelDavService(ctx);
  const s = () => ctx.panelDav;
  const r = panelRouter(ctx, 'email');
  r.use(requireFeature('caldav'));
  const sessionOnly = (req, _res, next) => (req.auth?.via === 'token' ? next(new HttpError(403, 'session_required', 'DAV passwords can only be managed from a browser session')) : next());
  r.get('/', wrap((req) => s().status(req.panel)));
  r.get('/:login/collections', validate({ params: loginParam }), wrap((req) => s().collections(req.panel, req.params.login)));
  r.put('/:login/password', sessionOnly, validate({ params: loginParam, body: passwordBody }), wrap((req) => s().setPassword(req.panel, req.params.login, req.body, req)));
  r.delete('/:login/password', sessionOnly, validate({ params: loginParam }), wrap((req) => s().removePassword(req.panel, req.params.login, req)));
  return { path: '/email/calendars', router: r };
}
