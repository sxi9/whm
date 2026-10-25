import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authRoutes } from './auth.js';
import { systemRoutes } from './system.js';
import { accountRoutes, packageRoutes } from './accounts.js';

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
  api.use(requireAuth);
  api.use('/system', systemRoutes(ctx));
  api.use('/accounts', accountRoutes(ctx));
  api.use('/packages', packageRoutes(ctx));

  const files = fs.existsSync(categoriesDir) ? fs.readdirSync(categoriesDir).filter((f) => f.endsWith('.js')).sort() : [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(categoriesDir, file)).href);
    if (typeof mod.register !== 'function') throw new Error(`routes/categories/${file} must export register(ctx)`);
    const mounts = [].concat(await mod.register(ctx)).filter(Boolean);
    for (const mount of mounts) {
      if (!mount.path || !mount.router) throw new Error(`routes/categories/${file}: register() must return { path, router }`);
      api.use(mount.path, mount.router);
      ctx.logger.debug({ category: file, path: mount.path }, 'mounted category router');
    }
  }
  return api;
}
