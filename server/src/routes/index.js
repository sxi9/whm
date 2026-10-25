import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authRoutes } from './auth.js';
import { systemRoutes } from './system.js';
import { accountRoutes, packageRoutes } from './accounts.js';

// One router per sidebar category is mounted here. Everything except /auth and
// /health requires an authenticated principal; roles are enforced per route.
export function apiRouter(ctx) {
  const api = Router();
  api.get('/health', (_req, res) => res.json({ data: { ok: true, mode: ctx.config.mode, version: ctx.version } }));
  api.use('/auth', authRoutes(ctx));
  api.use(requireAuth);
  api.use('/system', systemRoutes(ctx));
  api.use('/accounts', accountRoutes(ctx));
  api.use('/packages', packageRoutes(ctx));
  return api;
}
