import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from './support/app.js';
import { redact } from '../src/middleware/audit.js';

describe('audit redaction', () => {
  it('summarises raw upload bodies instead of serialising every byte', () => {
    expect(redact(Buffer.alloc(512 * 1024))).toEqual({ bytes: 524288 });
    expect(redact({ logo: new Uint8Array(16), name: 'x' })).toEqual({ logo: { bytes: 16 }, name: 'x' });
  });

  it('still masks secret-looking keys and truncates long strings', () => {
    const out = redact({ password: 'hunter2', note: 'a'.repeat(600) });
    expect(out.password).toBe('[redacted]');
    expect(out.note.length).toBeLessThan(600);
  });

  it('never passes a container through once nesting exceeds the depth limit', () => {
    const nest = (n, leaf) => (n === 0 ? leaf : { level: nest(n - 1, leaf) });
    for (const depth of [7, 8, 12]) {
      for (const opaque of [false, true]) {
        const row = JSON.stringify(redact(nest(depth, { password: 'hunter2', token: 'tok-1', env: { KEY: 'k' } }), 0, { opaque }));
        expect(row).not.toContain('hunter2');
        expect(row).not.toContain('tok-1');
        expect(row).toContain('[…]');
      }
    }
    // arrays past the limit are replaced too, and the limit does not touch what sits within it
    expect(JSON.stringify(redact(nest(7, [{ secret: 's3cr3t' }])))).not.toContain('s3cr3t');
    expect(redact(nest(6, { password: 'p', note: 'n' }))).toEqual(nest(6, { password: '[redacted]', note: 'n' }));
    expect(redact(nest(7, 'leaf'))).toEqual(nest(7, 'leaf'));
  });

  it('drops free text whole for audit rows (opaque), at any depth, and keeps every other key', () => {
    const input = { body: 'Welcome aboard', text: 't', message: 'm', content: 'c', env: { DATABASE_URL: 'pg://x' }, environment: { A: 1 }, name: 'kept', nested: { Body: 'x', note: 'n' }, list: [{ MESSAGE: 'z', chars: 3 }] };
    expect(redact(input, 0, { opaque: true })).toEqual({ body: '[redacted]', text: '[redacted]', message: '[redacted]', content: '[redacted]', env: '[redacted]', environment: '[redacted]', name: 'kept', nested: { Body: '[redacted]', note: 'n' }, list: [{ MESSAGE: '[redacted]', chars: 3 }] });
    // only the exact key names: a key that merely contains the word is ordinary data
    expect(redact({ contentType: 'text/plain', bodyBytes: 3, textual: true, messages: 2 }, 0, { opaque: true })).toEqual({ contentType: 'text/plain', bodyBytes: 3, textual: true, messages: 2 });
    // the license event log and support snapshots call redact() for secrets only: error messages stay
    expect(redact({ code: 'hub_unreachable', message: 'getaddrinfo ENOTFOUND hub', keyPrefix: 'WHM-1', env: { A: 1 } })).toEqual({ code: 'hub_unreachable', message: 'getaddrinfo ENOTFOUND hub', keyPrefix: '[redacted]', env: '[redacted]' });
  });
});

// Requests refused before their category router (requireAuth 401/403, the
// license gate 423) finish with the raw req.body: the middleware's own row
// must not carry the text either.
describe('automatic request audit', () => {
  let app;
  let csrf;
  beforeAll(async () => {
    app = await createTestApp();
    csrf = await app.login();
  });
  afterAll(async () => { await app?.close(); });

  it('records a request refused before its route without the free text it carried', async () => {
    const rows = () => app.ctx.db.prepare('SELECT principal, action, args_redacted, result FROM audit_log ORDER BY id').all();
    const before = rows().length;
    app.ctx.db.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'root'").run();
    try {
      await app.http.post('/api/support/chat/alice/messages').set('X-CSRF-Token', csrf).send({ body: 'SECRET-PROBE welcome' }).expect(403);
      await app.http.post('/api/accounts').set('X-CSRF-Token', csrf).send({ username: 'alice', domain: 'alice.example', message: 'SECRET-PROBE-2', env: { TOKEN: 'SECRET-PROBE-3' } }).expect(403);
    } finally { app.ctx.db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'root'").run(); }
    const added = rows().slice(before);
    expect(added.map((r) => [r.principal, r.action, r.result])).toEqual([['root', 'POST /api/support/chat/alice/messages', 'error:403'], ['root', 'POST /api/accounts', 'error:403']]);
    expect(JSON.parse(added[0].args_redacted)).toEqual({ body: '[redacted]' });
    expect(JSON.parse(added[1].args_redacted)).toEqual({ username: 'alice', domain: 'alice.example', message: '[redacted]', env: '[redacted]' });
    for (const r of added) expect(r.args_redacted).not.toContain('SECRET-PROBE');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = 'alice'").get().n).toBe(0);
  });
});
