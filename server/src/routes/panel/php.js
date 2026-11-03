import { validate, z, fields } from '../../lib/validate.js';
import { panelRouter, wrap } from './index.js';
import { createPanelPhpService } from '../../services/panel-php.js';

const phpVersionId = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/, 'PHP version id such as 8.3 or ea-php83');
const iniKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/);
const iniValue = z.string().max(1024).regex(/^[^\r\n\0]*$/, 'Directive values are a single line');
const domainParam = z.object({ domain: fields.hostname });

export async function register(ctx) {
  ctx.panelPhp = createPanelPhpService(ctx);
  const s = ctx.panelPhp;

  const r = panelRouter(ctx, 'php');
  r.get('/versions', wrap((req) => s.versions(req.panel)));
  r.get('/domains', wrap((req) => s.domains(req.panel)));
  r.put('/domains/:domain', validate({ params: domainParam, body: z.object({ version: phpVersionId.nullable() }).strict() }), wrap((req) => s.setVersion(req.panel, req.params.domain, req.body.version, req)));
  r.get('/domains/:domain/ini', validate({ params: domainParam }), wrap((req) => s.readIni(req.panel, req.params.domain)));
  r.put('/domains/:domain/ini', validate({ params: domainParam, body: z.object({ directives: z.record(iniKey, iniValue.nullable()) }).strict() }), wrap((req) => s.writeIni(req.panel, req.params.domain, req.body, req)));

  return { path: '/php', router: r };
}
