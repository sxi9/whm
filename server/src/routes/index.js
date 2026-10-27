import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authRoutes } from './auth.js';
import { systemRoutes } from './system.js';
import { accountRoutes, packageRoutes } from './accounts.js';
import { pluginRoutes } from './plugins.js';
import { marketplaceRoutes } from './marketplace.js';
import { licenseRoutes } from './license.js';
import { licenseGate } from '../middleware/license.js';

const categoriesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'categories');

// Core routers are mounted explicitly; every sidebar category lives in its own
// module under routes/categories/ and is discovered here, so adding a category
// never touches a shared file. Each module exports:
//   register(ctx) -> { path: '/dns', router } | [{ path, router }, ...]
// It may also create its services and attach them to ctx (e.g. ctx.dns = ...).
export async function apiRouter(ctx) {
  const api = Router();
  api.get('/health', (_req, res) => res.json({ data: { ok: true, mode: ctx.config.mode, version: ctx.version } }));
  api.use('/auth', authRoutes(ctx));

  // Categories register first so a module may mark a read-only mount `public: true`
  // (served before the session check, e.g. login-page branding); everything else
  // is mounted after requireAuth in discovery order.
  const files = fs.existsSync(categoriesDir) ? fs.readdirSync(categoriesDir).filter((f) => f.endsWith('.js')).sort() : [];
  const mounts = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(categoriesDir, file)).href);
    if (typeof mod.register !== 'function') throw new Error(`routes/categories/${file} must export register(ctx)`);
    for (const mount of [].concat(await mod.register(ctx)).filter(Boolean)) {
      if (!mount.path || !mount.router) throw new Error(`routes/categories/${file}: register() must return { path, router }`);
      mounts.push({ ...mount, file });
    }
  }
  for (const mount of mounts.filter((m) => m.public)) api.use(mount.path, mount.router);

  api.use(requireAuth);
  // The license routes sit before the gate so a degraded panel can always be re-licensed.
  api.use('/license', licenseRoutes(ctx));
  api.use(licenseGate(ctx));
  api.use('/system', systemRoutes(ctx));
  api.use('/accounts', accountRoutes(ctx));
  api.use('/packages', packageRoutes(ctx));
  api.use('/plugins', pluginRoutes(ctx));
  api.use('/marketplace', marketplaceRoutes(ctx));
  for (const mount of mounts.filter((m) => !m.public)) {
    api.use(mount.path, mount.router);
    ctx.logger.debug({ category: mount.file, path: mount.path }, 'mounted category router');
  }
  return api;
}
