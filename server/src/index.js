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

  const ctx = { config, logger, db, crypto, agent, capabilities, jobs, scheduler, settings, version };
  ctx.sessionStore = new SqliteSessionStore(db, { ttlMs: config.sessionTtlMs });
  ctx.auth = createAuthService(ctx);
  ctx.packages = createPackagesService(ctx);
  ctx.accounts = createAccountsService(ctx);
  ctx.system = createSystemService(ctx);
  ctx.serviceManager = createServiceManager(ctx);
  ctx.audit = createAuditService(ctx);
  ctx.app = createApp(ctx);

  try {
    await agent.ping();
    await capabilities.refresh();
  } catch (err) {
    logger.error({ err }, config.mode === 'split' ? 'whm-agentd is not reachable; privileged operations will fail until it starts' : 'agent self-check failed');
  }

  return ctx;
}

export async function start() {
  const ctx = await bootstrap();
  const { config, logger, app, jobs, scheduler } = ctx;
  jobs.start();
  scheduler.start();

  const servers = [];
  if (config.tls) {
    const tlsServer = https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, app);
    tlsServer.listen(config.tlsPort, config.host, () => logger.info({ port: config.tlsPort }, 'WHM panel listening (https)'));
    servers.push(tlsServer);
  }
  const httpServer = http.createServer(app);
  httpServer.listen(config.port, config.host, () => logger.info({ port: config.port, mode: config.mode, env: config.env, dataDir: config.dataDir }, 'WHM panel listening (http)'));
  servers.push(httpServer);

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    jobs.stop();
    scheduler.stop();
    ctx.sessionStore?.close();
    Promise.all(servers.map((s) => new Promise((r) => s.close(r)))).then(() => { ctx.db.close(); process.exit(0); });
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
