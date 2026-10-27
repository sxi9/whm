import crypto from 'node:crypto';
import { newId } from './db.js';

// Outbound webhooks for every owner type. Vendor and reseller endpoints live
// in license.db (webhook_endpoints/webhook_deliveries); developer endpoints in
// marketplace.db (developer_webhooks/developer_webhook_deliveries) — the caller
// passes the matching db handle.
const TABLES = {
  vendor: { endpoints: 'webhook_endpoints', deliveries: 'webhook_deliveries', fk: 'endpoint_id', ownerWhere: 'owner_type = @ownerType AND owner_id = @ownerId' },
  reseller: { endpoints: 'webhook_endpoints', deliveries: 'webhook_deliveries', fk: 'endpoint_id', ownerWhere: 'owner_type = @ownerType AND owner_id = @ownerId' },
  developer: { endpoints: 'developer_webhooks', deliveries: 'developer_webhook_deliveries', fk: 'webhook_id', ownerWhere: 'developer_id = @ownerId' },
};

// 1 m → 24 h over 10 attempts (§16.7).
export const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440, 1440, 1440];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

export function backoffMs(attempt) {
  return BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), MAX_ATTEMPTS) - 1] * 60_000;
}

export function signPayload(secret, t, body) {
  return crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

export function signatureHeader(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${signPayload(secret, t, body)}`;
}

export function verifySignatureHeader(secret, body, header, { now = Math.floor(Date.now() / 1000), toleranceS = 300 } = {}) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > toleranceS) return false;
  const expected = signPayload(secret, t, body);
  return expected.length === m[2].length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}

function tables(ownerType) {
  const t = TABLES[ownerType];
  if (!t) throw new Error(`unknown webhook owner type "${ownerType}"`);
  return t;
}

// Queues one delivery per enabled endpoint of the owner subscribed to `event`
// (events_json lists events or "*"). Returns the number of deliveries queued.
export function enqueue(db, { ownerType, ownerId, event, data, now = Date.now() }) {
  const t = tables(ownerType);
  const endpoints = db.prepare(`SELECT id, events_json FROM ${t.endpoints} WHERE enabled = 1 AND ${t.ownerWhere}`).all({ ownerType, ownerId });
  const insert = db.prepare(`INSERT INTO ${t.deliveries} (${t.fk}, event, payload_json, attempt, status, next_at, created_at) VALUES (?, ?, ?, 0, 'pending', ?, ?)`);
  const ts = new Date(now).toISOString();
  let n = 0;
  for (const ep of endpoints) {
    let events = [];
    try { events = JSON.parse(ep.events_json || '[]'); } catch { events = []; }
    if (!events.includes('*') && !events.includes(event)) continue;
    insert.run(ep.id, event, JSON.stringify({ id: newId('evt', now), event, ts, data }), ts, ts);
    n++;
  }
  return n;
}

// Delivers due rows: 2xx → delivered; otherwise the attempt counter grows and
// next_at follows the backoff table until MAX_ATTEMPTS, then `failed`.
export async function deliver(db, { ownerType = 'vendor', fetch, crypto: cryptoSvc, now = () => Date.now(), limit = 100, logger } = {}) {
  const t = tables(ownerType);
  if (!fetch) throw new Error('deliver() needs a fetch implementation');
  const due = db.prepare(`SELECT d.*, e.url, e.secret_enc FROM ${t.deliveries} d JOIN ${t.endpoints} e ON e.id = d.${t.fk}
    WHERE d.status IN ('pending', 'retrying') AND d.next_at <= ? AND e.enabled = 1 ORDER BY d.next_at LIMIT ?`).all(new Date(now()).toISOString(), limit);
  const update = db.prepare(`UPDATE ${t.deliveries} SET attempt = @attempt, status = @status, next_at = @next_at, last_code = @last_code, last_error = @last_error, delivered_at = @delivered_at WHERE id = @id`);
  const results = [];
  for (const row of due) {
    const body = row.payload_json;
    const nowS = Math.floor(now() / 1000);
    let secret = '';
    try { secret = row.secret_enc ? cryptoSvc.decrypt(row.secret_enc) : ''; } catch { secret = ''; }
    const attempt = row.attempt + 1;
    let code = null; let error = null;
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'whm-hub-webhooks/1', 'x-whm-webhook-signature': signatureHeader(secret, body, nowS), 'x-whm-webhook-event': row.event },
        body,
        timeoutMs: 10_000,
      });
      code = res.status;
    } catch (err) {
      error = String(err?.message || err).slice(0, 300);
    }
    const ok = code != null && code >= 200 && code < 300;
    const exhausted = !ok && attempt >= MAX_ATTEMPTS;
    update.run({
      id: row.id, attempt,
      status: ok ? 'delivered' : exhausted ? 'failed' : 'retrying',
      next_at: ok || exhausted ? null : new Date(now() + backoffMs(attempt)).toISOString(),
      last_code: code, last_error: error, delivered_at: ok ? new Date(now()).toISOString() : null,
    });
    if (!ok) logger?.warn({ delivery: row.id, attempt, code, error }, 'webhook delivery failed');
    results.push({ id: row.id, attempt, ok, code, status: ok ? 'delivered' : exhausted ? 'failed' : 'retrying' });
  }
  return results;
}

// Re-queues a delivery from the portal ("replay").
export function replay(db, { ownerType = 'vendor', id, now = Date.now() }) {
  const t = tables(ownerType);
  return db.prepare(`UPDATE ${t.deliveries} SET status = 'pending', attempt = 0, next_at = ?, last_error = NULL WHERE id = ?`).run(new Date(now).toISOString(), id).changes > 0;
}
