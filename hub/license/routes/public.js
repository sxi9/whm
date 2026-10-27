import express from 'express';
import { z, validate, fields, wrap } from '../../shared/validate.js';
import { HttpError } from '../../shared/errors.js';

const panelFields = {
  fingerprint: fields.fingerprint,
  fp_components: fields.fpComponents,
  hostname: fields.hostname.optional(),
  panel_version: fields.panelVersion.optional(),
  os: fields.os,
  nonce: fields.nonce,
  ts: fields.ts,
};

const activateBody = z.object({ key: fields.licenseKey, ...panelFields }).strict();
const transferBody = z.object({ key: fields.licenseKey, from_activation: fields.id, ...panelFields }).strict();
const trialBody = z.object({ email: fields.email, ...panelFields }).strict();
const checkinBody = z.object({
  token: fields.token, ...panelFields,
  usage: z.object({
    accounts: z.number().int().min(0).optional(), resellers: z.number().int().min(0).optional(), domains: z.number().int().min(0).optional(),
    plugins: z.array(z.object({ id: z.string().regex(/^[a-z0-9.-]{3,128}$/), version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/), state: z.enum(['installed', 'enabled', 'disabled', 'errored', 'activating']).optional() }).strict()).max(500).optional(),
  }).strict().optional(),
}).strict();
const deactivateBody = z.object({ token: fields.token, reason: fields.reason, nonce: fields.nonce, ts: fields.ts }).strict();

export function publicRoutes(ctx) {
  const r = express.Router();
  const { signed, limiters } = ctx.app;
  const guard = (req, _res, next) => { try { ctx.licenses.lookupGuard.assertNotBlocked(req.ip); next(); } catch (err) { next(err); } };

  r.post('/activate', limiters.activate, guard, ...signed(validate({ body: activateBody }), wrap(async (req, res) => {
    const out = ctx.activations.activate({ ...req.body, ip: req.ip });
    res.json({ data: await withExtras(ctx, out) });
  })));

  r.post('/checkin', limiters.checkin, ...signed(validate({ body: checkinBody }), wrap(async (req, res) => {
    const out = ctx.activations.checkin({ ...req.body, ip: req.ip });
    res.json({ data: await withExtras(ctx, out) });
  })));

  r.post('/deactivate', limiters.public, ...signed(validate({ body: deactivateBody }), wrap(async (req, res) => {
    const out = ctx.activations.deactivateByToken({ token: req.body.token, reason: req.body.reason, ip: req.ip });
    res.json({ data: out });
  })));

  r.post('/transfers', limiters.activate, guard, ...signed(validate({ body: transferBody }), wrap(async (req, res) => {
    const out = ctx.transfers.request({ ...req.body, ip: req.ip });
    res.json({ data: await withExtras(ctx, out) });
  })));

  r.post('/trial', limiters.trial, guard, ...signed(validate({ body: trialBody }), wrap(async (req, res) => {
    const out = ctx.trials.start({ ...req.body, ip: req.ip });
    res.status(201).json({ data: await withExtras(ctx, out) });
  })));

  // Always 202: the mail lists key prefixes and the portal link, never keys.
  r.post('/recover', limiters.recover, validate({ body: z.object({ email: fields.email }).strict() }), wrap(async (req, res) => {
    const customer = ctx.customers.findByEmail(req.body.email);
    if (customer) {
      const prefixes = ctx.licenses.list({ customer_id: customer.id, pageSize: 100 }).data.map((l) => ({ key_prefix: l.key_prefix, edition: l.edition, status: ctx.licenses.statusAt(l) }));
      await ctx.mailer.send({ to: customer.email, template: 'license.recover', data: { prefixes, portal_url: ctx.config.license.vendor.portal_url || ctx.config.public_url } });
    }
    ctx.audit.record({ principal: 'anonymous', ip: req.ip, action: 'license.recover', target: null, args: { found: !!customer }, result: 'ok' });
    res.status(202).json({ data: { accepted: true } });
  }));

  r.get('/keys', limiters.public, (_req, res) => {
    res.json({ data: { keys: ctx.keys.listPublic('license').map((k) => ({ ...k, purpose: 'license' })) } });
  });

  r.get('/status/:prefix', limiters.public, validate({ params: z.object({ prefix: fields.licensePrefix }) }), (req, res) => {
    res.json({ data: ctx.licenses.statusByPrefix(req.params.prefix) });
  });

  return r;
}

// Hooks (the marketplace) add plugin_signing_keys and revocations_head_ts
// inside the signed body of activation, check-in, transfer and trial answers.
async function withExtras(ctx, out) {
  let data = out;
  for (const fn of ctx.hooks.activationExtras) {
    try {
      const extra = await fn(ctx.activations.find(out.activation_id) || { id: out.activation_id });
      if (extra && typeof extra === 'object') data = { ...data, ...extra };
    } catch (err) {
      ctx.logger.error({ err }, 'activationExtras hook failed');
    }
  }
  return data;
}

export { HttpError };
