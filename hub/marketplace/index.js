import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDb, newId, nowIso as toIso } from '../shared/db.js';
import { record as auditRecord } from '../shared/audit.js';
import { HttpError } from '../shared/errors.js';
import { createDevSecurityService } from './services/dev-security.js';
import { createDevelopersService } from './services/developers.js';
import { createDevKeysService } from './services/keys.js';
import { createVerificationService } from './services/verification.js';
import { createSubmissionsService } from './services/submissions.js';
import { createScannerService } from './services/scanner.js';
import { createReviewService } from './services/review.js';
import { createSigningService } from './services/signing.js';
import { createCatalogService } from './services/catalog.js';
import { createDistributionService } from './services/distribution.js';
import { createEntitlementsService } from './services/entitlements.js';
import { createMarketBillingService } from './services/billing.js';
import { createRevocationsService } from './services/revocations.js';
import { createPayoutsService } from './services/payouts.js';
import { createStatsService } from './services/stats.js';
import { createPluginReviewsService } from './services/plugin-reviews.js';
import { publicRoutes } from './routes/public.js';
import { developerRoutes } from './routes/developer.js';
import { adminRoutes } from './routes/admin.js';
import { createMarketJobs, MARKET_SCHEDULES } from './jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MARKET_MIGRATIONS = path.join(HERE, 'migrations');
const BUNDLED_DIR = path.resolve(HERE, '../../plugins/bundled');

const rateLimit = (max, windowMs) => z.object({ max: z.number().int().min(1).default(max), windowMs: z.number().int().min(1000).default(windowMs) }).default({ max, windowMs });

// hub.conf `marketplace:` section (§18.1), validated here because src/config.js
// keeps it as an opaque record.
export const marketplaceConfigSchema = z.object({
  packages_dir: z.string().optional(),
  max_package_bytes: z.number().int().min(1024).default(20 * 1024 * 1024),
  download_url_ttl_s: z.number().int().min(60).default(900),
  download_hmac_file: z.string().optional(),
  scan: z.object({ av_command: z.array(z.string().min(1)).nullable().default(null) }).default({}),
  review: z.object({ require_two_reviewers_for_high_risk: z.boolean().default(true) }).default({}),
  revenue_share_pct: z.number().int().min(0).max(100).default(70),
  payout_min_cents: z.number().int().min(0).default(5000),
  currencies: z.array(z.string().length(3)).min(1).default(['USD', 'EUR']),
  github_oauth: z.object({ client_id: z.string().optional(), client_secret: z.string().optional(), client_secret_enc: z.string().optional(), redirect_url: z.string().url().optional() }).nullable().default(null),
  public_suffix_list: z.string().optional(),
  reserved_namespaces: z.array(z.string()).default([]),
  reserved_brands: z.array(z.string()).default([]),
  bundled_ids: z.array(z.string()).optional(),
  host_api_versions: z.array(z.string()).min(1).default(['1.0.0']),
  evidence_purge_days: z.number().int().min(1).default(30),
  session_ttl_hours: z.number().int().min(1).default(12),
  stepup_max_age_s: z.number().int().min(30).default(300),
  disposable_domains: z.array(z.string()).default(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'yopmail.com', 'trashmail.com']),
  rate_limits: z.object({
    register: rateLimit(5, 24 * 3600_000),
    upload: rateLimit(10, 24 * 3600_000),
    recheck: rateLimit(5, 3600_000),
    download: rateLimit(60, 3600_000),
    feed: rateLimit(30, 3600_000),
    catalog: rateLimit(600, 3600_000),
    dev_login: rateLimit(30, 15 * 60_000),
  }).default({}),
});

export function loadMarketplaceConfig(ctx) {
  const parsed = marketplaceConfigSchema.safeParse(ctx.config.marketplace || {});
  if (!parsed.success) throw new Error(`invalid marketplace configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const cfg = parsed.data;
  cfg.packages_dir ||= path.join(ctx.config.db_dir, 'packages');
  cfg.download_hmac_file ||= path.join(ctx.config.keys.dir, 'download.hmac');
  cfg.public_suffix_list ||= path.join(ctx.config.db_dir, 'public_suffix_list.dat');
  if (!cfg.bundled_ids) cfg.bundled_ids = fs.existsSync(BUNDLED_DIR) ? fs.readdirSync(BUNDLED_DIR).filter((d) => /^[a-z][a-z0-9.-]+$/.test(d)) : [];
  return cfg;
}

// Mail templates (no secrets: tokens arrive as links the developer owns).
export const MARKET_TEMPLATES = {
  'dev.email_verify': (d) => ({ subject: 'Verify your developer account', text: `Hello ${d.display_name},\n\nConfirm your e-mail within 24 hours: ${d.link}\n` }),
  'dev.verification_received': (d) => ({ subject: 'Verification evidence received', text: `We received ${d.method} evidence${d.ns ? ` for ${d.ns}` : ''}. A reviewer will look at it.\n` }),
  'dev.verified': (d) => ({ subject: 'Your developer account is verified', text: `Hello ${d.display_name},\n\nYou can now publish plugins to the marketplace.\n` }),
  'dev.rejected': (d) => ({ subject: 'Developer verification rejected', text: `Hello ${d.display_name},\n\nYour verification was rejected: ${d.reason || 'no reason given'}. You can resubmit evidence from the portal.\n` }),
  'dev.reverify_due': (d) => ({ subject: 'Re-verification required', text: `Hello ${d.display_name},\n\nYour developer account needs re-verification (${d.trigger}). Uploads continue; publishing resumes once a reviewer approves.\n` }),
  'dev.suspended': (d) => ({ subject: 'Developer account suspended', text: `Hello ${d.display_name},\n\nYour account was suspended: ${d.reason || 'policy'}.\n` }),
  'dev.evidence_requested': (d) => ({ subject: 'More verification evidence requested', text: `Hello ${d.display_name},\n\n${d.text || 'A reviewer asked for more evidence.'}\n` }),
  'dev.key_added': (d) => ({ subject: `Signing key ${d.kid} added`, text: `A signing key (${d.kid}${d.label ? `, ${d.label}` : ''}) was added to your developer account.\n` }),
  'dev.key_revoked': (d) => ({ subject: `Signing key ${d.kid} revoked`, text: `Signing key ${d.kid} was revoked${d.reason ? `: ${d.reason}` : ''}.\n` }),
  'dev.security_event': (d) => ({ subject: `Developer account security notice: ${d.event}`, text: `${d.detail || d.event}\n` }),
  'dev.password_reset': (d) => ({ subject: 'Developer password reset', text: `Use this link within 15 minutes to reset your password: ${d.link}\n` }),
  'dev.submission_scanned': (d) => ({ subject: `${d.plugin_id} ${d.version}: automated checks ${d.ok ? 'passed' : 'failed'}`, text: d.ok ? 'The version is now in human review.\n' : `Rejected by the automated checks:\n${(d.rejects || []).map((r) => `  - ${r}`).join('\n')}\n` }),
  'dev.submission_reviewed': (d) => ({ subject: `${d.plugin_id} ${d.version}: ${d.outcome}`, text: `${d.outcome === 'approved' ? 'The version was approved and signed; publish it from the portal.' : `Reasons:\n${(d.reasons || []).map((r) => `  - ${r}`).join('\n')}`}\n` }),
  'dev.submission_published': (d) => ({ subject: `${d.plugin_id} ${d.version} published`, text: `Version ${d.version} is live on the ${d.channel} channel.\n` }),
  'dev.submission_revoked': (d) => ({ subject: `${d.plugin_id}${d.version ? ` ${d.version}` : ''} revoked`, text: `Severity ${d.severity}: ${d.reason || 'no reason given'}.\n` }),
  'dev.payout_paid': (d) => ({ subject: 'Payout sent', text: `Hello ${d.display_name},\n\n${d.net_cents / 100} ${d.currency} for ${d.period_start.slice(0, 10)} – ${d.period_end.slice(0, 10)} was paid.\n` }),
  'customer.magic_link': (d) => ({ subject: 'Your WHM Marketplace sign-in link', text: `Hello ${d.name || ''},\n\nSign in within 15 minutes: ${d.link}\n` }),
};

function buildMessage({ from, to, subject, text }) {
  const safe = (s) => String(s).replace(/[\r\n]+/g, ' ');
  return `From: ${safe(from)}\r\nTo: ${safe(to)}\r\nSubject: ${safe(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
}

// The marketplace context every service receives: the marketplace db, config,
// clock, audit (marketplace.db audit_log), mail, rate buckets, webhooks, state.
export function createMarketContext(ctx, { db, cfg }) {
  const now = () => ctx.clock.now();
  const rate = {
    insert: db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)'),
    count: db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND ts >= ?'),
    prune: db.prepare('DELETE FROM rate_events WHERE ts < ?'),
  };
  const state = {
    get: db.prepare('SELECT value_json FROM market_state WHERE key = ?'),
    set: db.prepare('INSERT INTO market_state (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json'),
  };
  const m = {
    ctx, db, cfg, now, newId: (prefix) => newId(prefix, now()),
    nowIso: (ms = now()) => toIso(ms),
    hashIp: (ip) => (ip ? crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32) : null),
    audit(entry) {
      try { auditRecord(db, { ts: toIso(now()), ...entry }); } catch (err) { ctx.logger.error({ err, action: entry.action }, 'marketplace audit write failed'); }
    },
    mail(to, template, data = {}) {
      const tpl = MARKET_TEMPLATES[template];
      if (!tpl) throw new Error(`unknown marketplace mail template "${template}"`);
      const { subject, text } = tpl(data);
      if (!to || ctx.config.license.mail.enabled === false) return Promise.resolve({ ok: false, skipped: true });
      return Promise.resolve(ctx.mailer.transport.send(buildMessage({ from: ctx.config.license.mail.from, to, subject, text }), { to, template, subject, data }))
        .then(() => ({ ok: true }), (err) => { ctx.logger.error({ err, template, to }, 'marketplace mail failed'); return { ok: false }; });
    },
    limits: {
      count: (key, windowMs) => rate.count.get(key, now() - windowMs).n,
      hit: (key) => rate.insert.run(key, now()),
      assert(key, max, windowMs, message = 'Too many requests') {
        if (rate.count.get(key, now() - windowMs).n >= max) throw Object.assign(new HttpError(429, 'rate_limited', message), { retryAfterS: Math.ceil(windowMs / 1000) });
        rate.insert.run(key, now());
      },
      prune: (maxAgeMs = 48 * 3600_000) => rate.prune.run(now() - maxAgeMs).changes,
    },
    webhook: (developerId, event, data) => { try { return ctx.webhooks.enqueue(db, { ownerType: 'developer', ownerId: developerId, event, data, now: now() }); } catch (err) { ctx.logger.error({ err, event }, 'developer webhook enqueue failed'); return 0; } },
    state: {
      get: (key) => { const row = state.get.get(key); return row ? JSON.parse(row.value_json) : null; },
      set: (key, value) => state.set.run(key, JSON.stringify(value ?? null)),
    },
  };
  return m;
}

// register(ctx): called by hub/src/index.js through ctx.registerModule before
// the app is finalised. Opens marketplace.db, builds the services, mounts the
// routes and registers every U1 hook (§18 preamble, build plan U2).
export async function register(ctx) {
  const cfg = loadMarketplaceConfig(ctx);
  fs.mkdirSync(cfg.packages_dir, { recursive: true, mode: 0o750 });
  const db = openDb(path.join(ctx.config.db_dir, 'marketplace.db'), { migrationsDir: MARKET_MIGRATIONS, logger: ctx.logger });
  ctx.dbs.marketplace = db;
  const m = createMarketContext(ctx, { db, cfg });
  m.devSecurity = createDevSecurityService(m);
  m.developers = createDevelopersService(m);
  m.devKeys = createDevKeysService(m);
  m.verification = createVerificationService(m);
  m.submissions = createSubmissionsService(m);
  m.scanner = createScannerService(m);
  m.review = createReviewService(m);
  m.signing = createSigningService(m);
  m.catalog = createCatalogService(m);
  m.distribution = createDistributionService(m);
  m.entitlements = createEntitlementsService(m);
  m.billing = createMarketBillingService(m);
  m.revocations = createRevocationsService(m);
  m.payouts = createPayoutsService(m);
  m.stats = createStatsService(m);
  m.pluginReviews = createPluginReviewsService(m);
  m.jobs = createMarketJobs(m);

  // Hooks into the license server.
  ctx.hooks.activationExtras.push(() => ({ plugin_signing_keys: ctx.keys.listPublic('plugin'), revocations_head_ts: m.revocations.headTs() }));
  ctx.hooks.checkin.push(({ activation, license, usage }) => m.jobs.recordUsage({ activation, license, usage }));
  ctx.hooks.billing.push((source, ev, meta) => m.billing.hook(source, ev, meta));
  ctx.hooks.keyActivated.push(({ kid, purpose }) => { if (purpose === 'plugin') m.signing.resignAll(kid, { by: 'keyActivated' }); });
  ctx.hooks.beforeKeyRetire.push((e) => m.signing.guardRetire(e));
  ctx.metrics?.gauges.push(() => m.stats.gauges());
  for (const { name, cron } of MARKET_SCHEDULES) ctx.scheduler.ensure(name, cron, m.jobs.handlers[name]);
  const webhookRetry = ctx.scheduler.ensure('webhook-retry', '10 * * * *', async () => ({ vendor: await ctx.webhooks.deliverDue(), developer: await ctx.webhooks.deliver(db, { ownerType: 'developer' }) }));
  void webhookRetry;

  ctx.app.use('/v1/market', publicRoutes(m));
  ctx.app.use('/v1/dev', developerRoutes(m));
  ctx.app.use('/v1/admin/market', adminRoutes(m));

  const baseHealth = ctx.health;
  ctx.health = () => {
    const h = baseHealth();
    let marketDb = false;
    try { db.prepare('SELECT 1').get(); marketDb = true; } catch { marketDb = false; }
    return { ...h, ok: h.ok && marketDb, marketplace: { db: marketDb, packages_dir: cfg.packages_dir } };
  };
  ctx.marketplace = m;
  return m;
}
