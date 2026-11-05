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
  // Token confinement registry (middleware/auth.js); `prefixes` tells a
  // category that `{ path, prefix: true }` entries are honoured.
  ctx.confinedScopes = Object.assign(new Map(), { prefixes: true });
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
  let stopTlsWatch = () => {};
  for (const d of config.disabledPanelPorts || []) logger.warn({ port: d.port, collidesWith: d.collidesWith }, `${d.key} (${d.port}) is the same as ${d.collidesWith}; that account-panel listener is disabled`);
  // The account-panel listeners are optional: a bind failure there (another
  // service on 2082/2083) is logged and the administration shell keeps serving.
  const listenOptional = (server, port, shell, scheme) => {
    server.on('error', (err) => logger.error({ err, port }, `${shell} listener failed; the administration shell is unaffected`));
    server.listen(port, config.host, () => logger.info({ port }, `${shell} listening (${scheme})`));
    servers.push(server);
  };
  if (config.tls) {
    const readPair = () => ({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' });
    let pair;
    try {
      pair = readPair();
    } catch (err) {
      // The app was built TLS-only (Secure cookies, http redirect), so serving
      // plain http instead would leave the panel unusable; fail loudly instead.
      logger.fatal({ err, cert: config.tlsCert, key: config.tlsKey }, 'panel TLS certificate or key cannot be read; fix the files named by tlsCert/tlsKey (WHM_TLS_CERT/WHM_TLS_KEY) and restart whm-panel');
      throw err;
    }
    const tlsServers = [];
    const tlsServer = https.createServer(pair, app);
    tlsServer.listen(config.tlsPort, config.host, () => logger.info({ port: config.tlsPort }, 'WHM panel listening (https)'));
    servers.push(tlsServer);
    tlsServers.push(tlsServer);
    if (config.panelPort) {
      const panelTlsServer = https.createServer(pair, app);
      listenOptional(panelTlsServer, config.panelPort, 'account panel', 'https');
      tlsServers.push(panelTlsServer);
    }
    // Certificate installs and AutoSSL renewals replace the pair in place; the
    // listeners pick it up on SIGHUP or when the files change, no restart needed.
    const reloadTls = (reason) => {
      try {
        const next = readPair();
        for (const server of tlsServers) server.setSecureContext(next);
        logger.info({ reason }, 'panel TLS certificate reloaded');
      } catch (err) {
        logger.error({ err, reason }, 'panel TLS certificate reload failed; keeping the previous certificate');
      }
    };
    process.on('SIGHUP', () => reloadTls('SIGHUP'));
    let timer = null;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => reloadTls('file change'), 2_000); timer.unref(); };
    for (const file of [config.tlsCert, config.tlsKey]) fs.watchFile(file, { interval: 5_000, persistent: false }, onChange);
    stopTlsWatch = () => { clearTimeout(timer); for (const file of [config.tlsCert, config.tlsKey]) fs.unwatchFile(file, onChange); };
  }
  const httpServer = http.createServer(app);
  httpServer.listen(config.port, config.host, () => logger.info({ port: config.port, mode: config.mode, env: config.env, dataDir: config.dataDir, httpRedirect: config.tls && config.httpRedirect }, 'WHM panel listening (http)'));
  servers.push(httpServer);
  if (config.panelHttpPort) listenOptional(http.createServer(app), config.panelHttpPort, 'account panel', 'http');

  // Plugins load once the panel listens, so a slow activation never keeps the
  // operator from reaching Manage Plugins; the job workers start after that so
  // a queued plugin job finds its handler registered.
  ctx.plugins.loadAll()
    .catch((err) => logger.error({ err }, 'plugin load failed'))
    .finally(() => { jobs.start(); scheduler.start(); });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    jobs.stop();
    scheduler.stop();
    stopTlsWatch();
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
