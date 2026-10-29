import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase } from './db/index.js';
import { seed } from './db/seed.js';
import { SqliteSessionStore } from './db/session-store.js';
import { createCrypto } from './lib/crypto.js';
import { PanelEvents } from './lib/events.js';
import { createAgentClient } from './lib/agent-client.js';
import { createCapabilities } from './lib/capabilities.js';
import { createJobs } from './lib/jobs.js';
import { createScheduler } from './lib/scheduler.js';
import { createSettingsService } from './services/settings.js';
import { createAuthService } from './services/auth.js';
import { createSystemService } from './services/system.js';
import { createServiceManager } from './services/services.js';
import { createPackagesService } from './services/packages.js';
import { createAccountsService } from './services/accounts.js';
import { createAuditService } from './services/audit.js';
import { createPluginHost } from './services/plugins.js';
import { createLicenseService } from './services/license.js';
import { createMarketplaceClient } from './services/marketplace-client.js';
import { createApp } from './app.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// The hostname flow installs a fresh panel certificate into the files the
// listener was started from; polling their identity lets the TLS server pick
// the new pair up without a restart (a half-written pair is skipped until both
// files parse together).
export function watchTlsFiles({ server, cert, key, logger, intervalMs = 30_000 }) {
  const identity = () => [cert, key].map((f) => { const st = fs.statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}`; }).join('|');
  let last = null;
  try { last = identity(); } catch { last = null; }
  const check = () => {
    let current;
    try { current = identity(); } catch (err) { logger?.warn({ err }, 'panel certificate files unreadable'); return false; }
    if (current === last) return false;
    try {
      server.setSecureContext({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), minVersion: 'TLSv1.2' });
      last = current;
      logger?.info({ cert }, 'panel certificate reloaded');
      return true;
    } catch (err) {
      logger?.warn({ err }, 'panel certificate reload failed; the previous certificate stays in use');
      return false;
    }
  };
  const timer = intervalMs > 0 ? setInterval(check, intervalMs) : null;
  timer?.unref?.();
  return { check, stop: () => { if (timer) clearInterval(timer); } };
}

// Builds the whole service graph. Exported so tests can boot an in-memory panel.
export async function bootstrap(overrides = {}) {
  const config = loadConfig(overrides);
  const logger = createLogger(config.logLevel, config.env);
  const db = openDatabase(overrides.dbPath || config.dbPath, logger);
  const crypto = createCrypto(config.masterKeyHex);
  await seed({ db, config, crypto, logger });

  const agent = overrides.agent || createAgentClient({ config, logger });
  const capabilities = createCapabilities({ agent, db, logger });
  const jobs = createJobs({ db, logger, agent });
  const scheduler = createScheduler({ db, jobs, logger });
  const settings = createSettingsService({ db });

  const ctx = { config, logger, db, crypto, agent, capabilities, jobs, scheduler, settings, version, events: new PanelEvents(logger) };
  ctx.sessionStore = new SqliteSessionStore(db, { ttlMs: config.sessionTtlMs });
  ctx.auth = createAuthService(ctx);
  ctx.packages = createPackagesService(ctx);
  ctx.accounts = createAccountsService(ctx);
  ctx.system = createSystemService(ctx);
  ctx.serviceManager = createServiceManager(ctx);
  ctx.audit = createAuditService(ctx);
  ctx.plugins = createPluginHost(ctx);
  ctx.license = createLicenseService(ctx);
  ctx.marketplace = createMarketplaceClient(ctx);
  await ctx.license.boot();
  ctx.app = await createApp(ctx);
  // Categories (Contact Manager among them) exist now: deliver what boot() found.
  ctx.license.flushNotifications();
  ctx.marketplace.boot();
  if (overrides.loadPlugins !== false) await ctx.plugins.loadAll();

  try {
    await agent.ping();
    await capabilities.refresh();
  } catch (err) {
    logger.error({ err }, config.mode === 'split' ? 'whm-agentd is not reachable; privileged operations will fail until it starts' : 'agent self-check failed');
  }

  return ctx;
}

export async function start() {
  const ctx = await bootstrap({ loadPlugins: false });
  const { config, logger, app, jobs, scheduler } = ctx;

  const servers = [];
  let tlsWatch = null;
  if (config.tls) {
    const tlsServer = https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, app);
    tlsServer.listen(config.tlsPort, config.host, () => logger.info({ port: config.tlsPort }, 'WHM panel listening (https)'));
    servers.push(tlsServer);
    tlsWatch = watchTlsFiles({ server: tlsServer, cert: config.tlsCert, key: config.tlsKey, logger });
  }
  const httpServer = http.createServer(app);
  httpServer.listen(config.port, config.host, () => logger.info({ port: config.port, mode: config.mode, env: config.env, dataDir: config.dataDir }, 'WHM panel listening (http)'));
  servers.push(httpServer);

  // Plugins load once the panel listens, so a slow activation never keeps the
  // operator from reaching Manage Plugins; the job workers start after that so
  // a queued plugin job finds its handler registered.
  // 'panel.started' tells the categories the panel is up (Service Configuration
  // renders the hostname's landing vhost on it).
  ctx.plugins.loadAll()
    .catch((err) => logger.error({ err }, 'plugin load failed'))
    .finally(() => {
      jobs.start();
      scheduler.start();
      ctx.events.emit('panel.started', { version, tls: config.tls, port: config.port, tlsPort: config.tls ? config.tlsPort : null }).catch((err) => logger.warn({ err }, 'panel.started listeners failed'));
    });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    jobs.stop();
    scheduler.stop();
    tlsWatch?.stop();
    ctx.sessionStore?.close();
    Promise.all([ctx.plugins.stopAll().catch(() => {}), ...servers.map((s) => new Promise((r) => s.close(r)))]).then(() => { ctx.db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return ctx;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
