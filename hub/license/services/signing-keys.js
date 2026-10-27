import { HttpError, notFound } from '../../shared/errors.js';
import { nowIso } from '../../shared/db.js';

// U1 owns signing_keys, the key files and the rotation rules; the marketplace
// consumes keys through ctx.keys and hooks into keyActivated/beforeKeyRetire.
export function createSigningKeysService(ctx) {
  const now = () => ctx.clock.now();

  function minRetireWindowMs(purpose) {
    const l = ctx.config.license;
    return purpose === 'license' ? 2 * l.token_ttl_hours * 3600_000 : 2 * l.checkin_interval_hours * 3600_000;
  }

  return {
    list: (purpose) => ctx.keys.list(purpose),
    get(kid) {
      const k = ctx.keys.byKid(kid);
      if (!k) throw notFound('Signing key');
      return k;
    },
    create(purpose, { actor = null } = {}) {
      const created = ctx.keys.generate(purpose, { status: 'pending' });
      ctx.audit.record({ principal: actor?.principal ?? 'system', ip: actor?.ip ?? null, action: 'signing_key.create', target: created.kid, args: { purpose }, result: 'ok' });
      return created;
    },
    // pending → active; the previous active key becomes retiring.
    activate(kid, { actor = null } = {}) {
      const k = this.get(kid);
      if (k.status === 'active') return k;
      if (k.status === 'retired') throw new HttpError(409, 'key_retired', 'A retired key cannot be activated');
      if (!k.has_private_key) throw new HttpError(409, 'key_unavailable', `No private key file for "${kid}" in ${ctx.keys.dir}`);
      const previous = ctx.keys.active(k.purpose);
      const at = nowIso(now());
      if (previous && previous.kid !== kid) ctx.keys.setStatus(previous.kid, 'retiring');
      ctx.keys.setStatus(kid, 'active', { activatedAt: at });
      ctx.audit.record({ principal: actor?.principal ?? 'system', ip: actor?.ip ?? null, action: 'signing_key.activate', target: kid, args: { purpose: k.purpose, previous: previous?.kid || null }, result: 'ok' });
      for (const fn of ctx.hooks.keyActivated) {
        try { fn({ kid, purpose: k.purpose, previousKid: previous?.kid || null }); } catch (err) { ctx.logger.error({ err, kid }, 'keyActivated hook failed'); }
      }
      return this.get(kid);
    },
    // Refused (409 key_in_use) while the key is still the active one, while its
    // successor was activated less than 2× TTL / check-in interval ago, or when a
    // beforeKeyRetire hook objects (the marketplace while packages reference it).
    retire(kid, { actor = null, force = false } = {}) {
      const k = this.get(kid);
      if (k.status === 'retired') return k;
      if (k.status === 'active') throw new HttpError(409, 'key_in_use', 'Activate a successor key before retiring the active one');
      const successor = ctx.keys.active(k.purpose);
      const successorRow = successor ? ctx.keys.byKid(successor.kid) : null;
      if (!force && successorRow?.activated_at && now() - new Date(successorRow.activated_at).getTime() < minRetireWindowMs(k.purpose)) {
        throw new HttpError(409, 'key_in_use', `Tokens or packages signed with "${kid}" may still be in use; retry after ${Math.ceil(minRetireWindowMs(k.purpose) / 3600_000)} h`);
      }
      for (const fn of ctx.hooks.beforeKeyRetire) fn({ kid, purpose: k.purpose });
      ctx.keys.setStatus(kid, 'retired', { retiredAt: nowIso(now()) });
      ctx.audit.record({ principal: actor?.principal ?? 'system', ip: actor?.ip ?? null, action: 'signing_key.retire', target: kid, args: { purpose: k.purpose, force }, result: 'ok' });
      return this.get(kid);
    },
    minRetireWindowMs,
  };
}
