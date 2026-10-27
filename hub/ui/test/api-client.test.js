import { describe, it, expect, vi } from 'vitest';
import { createApiClient, ApiError, queryString } from '../src/api/client.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}
function scripted(...answers) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); const next = answers.shift(); return typeof next === 'function' ? next(url, init) : next; });
  return { fetchImpl, calls };
}

describe('api client', () => {
  it('sends JSON with the CSRF header on mutations only and returns the envelope', async () => {
    const { fetchImpl, calls } = scripted(response(200, { data: { ok: 1 }, meta: { total: 1 } }), response(200, { data: [] }));
    const api = createApiClient({ fetchImpl });
    api.setCsrfToken('tok123');
    const out = await api.post('/admin/licenses', { sku: 'whm-pro-annual' });
    expect(out).toEqual({ data: { ok: 1 }, meta: { total: 1 } });
    expect(calls[0].url).toBe('/v1/admin/licenses');
    expect(calls[0].init.headers['X-CSRF-Token']).toBe('tok123');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.body).toBe('{"sku":"whm-pro-annual"}');
    expect(calls[0].init.credentials).toBe('same-origin');
    await api.get('/admin/licenses');
    expect(calls[1].init.headers['X-CSRF-Token']).toBeUndefined();
    expect(calls[1].init.body).toBeUndefined();
  });

  it('turns { error } answers into ApiError with code, fields and extra', async () => {
    const { fetchImpl } = scripted(response(422, { error: { code: 'validation_failed', message: 'Validation failed', fields: { sku: ['Malformed SKU'] } } }), response(409, { error: { code: 'activation_limit', message: '1 of 1', activations: [{ id: 'act_1' }] } }));
    const api = createApiClient({ fetchImpl });
    const err = await api.post('/admin/licenses', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toEqual({ sku: ['Malformed SKU'] });
    const err2 = await api.post('/activate', {}).catch((e) => e);
    expect(err2.extra.activations).toEqual([{ id: 'act_1' }]);
  });

  it('re-prompts for a TOTP step-up on 403 totp_stepup_required and retries the request once', async () => {
    const { fetchImpl, calls } = scripted(
      response(403, { error: { code: 'totp_stepup_required', message: 'Confirm your TOTP code to continue' } }),
      response(200, { data: { approved: true } }),
    );
    const api = createApiClient({ fetchImpl });
    const handler = vi.fn(async (err, info) => { expect(err.code).toBe('totp_stepup_required'); expect(info).toEqual({ method: 'POST', path: '/admin/market/verifications/dev_1/approve' }); return true; });
    api.setStepUpHandler(handler);
    const out = await api.post('/admin/market/verifications/dev_1/approve', { note: 'ok' });
    expect(out.data.approved).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe('{"note":"ok"}');
  });

  it('does not retry when the step-up is cancelled, and never loops on a second refusal', async () => {
    const { fetchImpl, calls } = scripted(
      response(403, { error: { code: 'totp_stepup_required', message: 'x' } }),
      response(403, { error: { code: 'totp_stepup_required', message: 'x' } }),
      response(403, { error: { code: 'totp_stepup_required', message: 'x' } }),
    );
    const api = createApiClient({ fetchImpl });
    api.setStepUpHandler(async () => false);
    await expect(api.post('/admin/signing-keys', { purpose: 'plugin' })).rejects.toMatchObject({ status: 403, code: 'totp_stepup_required' });
    expect(calls).toHaveLength(1);
    api.setStepUpHandler(async () => true);
    await expect(api.post('/admin/signing-keys', { purpose: 'plugin' })).rejects.toMatchObject({ code: 'totp_stepup_required' });
    expect(calls).toHaveLength(3);
  });

  it('shares one step-up prompt between concurrent refused requests', async () => {
    let resolveStepUp;
    const handler = vi.fn(() => new Promise((resolve) => { resolveStepUp = resolve; }));
    const refused = () => response(403, { error: { code: 'totp_stepup_required', message: 'x' } });
    const { fetchImpl, calls } = scripted(refused(), refused(), response(200, { data: 1 }), response(200, { data: 2 }));
    const api = createApiClient({ fetchImpl });
    api.setStepUpHandler(handler);
    const a = api.post('/admin/market/payouts/p1/approve');
    const b = api.post('/admin/market/payouts/p2/approve');
    await new Promise((r) => setTimeout(r, 5));
    expect(handler).toHaveBeenCalledTimes(1);
    resolveStepUp(true);
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.data, rb.data].sort()).toEqual([1, 2]);
    expect(calls).toHaveLength(4);
  });

  it('ignores totp_required (no 2FA enrolled) for the step-up flow and surfaces it as an error', async () => {
    const { fetchImpl } = scripted(response(403, { error: { code: 'totp_required', message: 'Enable two-factor authentication to do that' } }));
    const api = createApiClient({ fetchImpl });
    const handler = vi.fn();
    api.setStepUpHandler(handler);
    await expect(api.post('/dev/keys')).rejects.toMatchObject({ code: 'totp_required' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the unauthorized handler on 401 except for login and session-discovery paths', async () => {
    const unauthorized = () => response(401, { error: { code: 'unauthorized', message: 'Sign in first' } });
    const { fetchImpl } = scripted(unauthorized(), unauthorized(), unauthorized());
    const api = createApiClient({ fetchImpl });
    const handler = vi.fn();
    api.setUnauthorizedHandler(handler);
    await expect(api.get('/portal/me')).rejects.toMatchObject({ status: 401 });
    await expect(api.post('/dev/login', {})).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    await expect(api.get('/admin/licenses')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uploads raw bodies with the given content type and extra headers', async () => {
    const { fetchImpl, calls } = scripted(response(201, { data: { version: '1.0.1' } }));
    const api = createApiClient({ fetchImpl });
    api.setCsrfToken('c');
    const bytes = new Uint8Array([1, 2, 3]);
    const out = await api.postRaw('/dev/plugins/net.acme.x/versions?channel=beta', bytes, 'application/gzip', { 'X-WHM-Changelog': 'LS0t' });
    expect(out.data.version).toBe('1.0.1');
    expect(calls[0].init.body).toBe(bytes);
    expect(calls[0].init.headers['Content-Type']).toBe('application/gzip');
    expect(calls[0].init.headers['X-WHM-Changelog']).toBe('LS0t');
    expect(calls[0].init.headers['X-CSRF-Token']).toBe('c');
  });

  it('builds query strings without empty values', () => {
    expect(queryString({ page: 1, q: '', status: undefined, edition: 'pro' })).toBe('?page=1&edition=pro');
    expect(queryString({})).toBe('');
  });
});
