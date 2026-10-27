// fetch wrapper for the hub API: CSRF double-submit header on mutations, the
// { data, meta } / { error } envelopes, and a step-up re-prompt: a 403
// totp_stepup_required answer hands the request to the registered handler
// (the StepUpModal), and the request is retried once after a fresh TOTP.

export class ApiError extends Error {
  constructor(status, body) {
    const err = body?.error || {};
    super(err.message || `Request failed with status ${status}`);
    this.status = status;
    this.code = err.code || 'error';
    this.fields = err.fields || null;
    this.requestId = err.requestId || null;
    this.extra = Object.fromEntries(Object.entries(err).filter(([k]) => !['code', 'message', 'fields', 'requestId'].includes(k)));
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Answers that mean "no session" for these paths are part of normal login
// and session discovery, so they never trigger the unauthorized handler.
const AUTH_PATHS = ['/portal/login', '/portal/me', '/dev/login', '/dev/me', '/dev/register', '/dev/verify-email', '/dev/password/reset'];

export function queryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createApiClient({ base = '/v1', fetchImpl = null } = {}) {
  let csrfToken = null;
  let onUnauthorized = null;
  let onStepUp = null;
  let pendingStepUp = null;
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  async function parse(res) {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // One modal at a time: concurrent step-up refusals share the same prompt.
  function stepUp(err, info) {
    if (!pendingStepUp) {
      pendingStepUp = Promise.resolve().then(() => onStepUp(err, info)).finally(() => { pendingStepUp = null; });
    }
    return pendingStepUp;
  }

  async function request(method, path, body, { raw = false, headers: extraHeaders = {}, contentType = null, retry = true } = {}) {
    const headers = { Accept: 'application/json', ...extraHeaders };
    let payload;
    if (body !== undefined) {
      if (contentType) { headers['Content-Type'] = contentType; payload = body; } else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    }
    if (csrfToken && !SAFE_METHODS.has(method)) headers['X-CSRF-Token'] = csrfToken;
    const res = await doFetch(`${base}${path}`, { method, headers, body: payload, credentials: 'same-origin' });
    if (raw) return res;
    const json = await parse(res);
    if (res.ok) return json ?? {};
    const err = new ApiError(res.status, json);
    if (err.status === 403 && err.code === 'totp_stepup_required' && retry && onStepUp) {
      const ok = await stepUp(err, { method, path });
      if (ok) return request(method, path, body, { raw, headers: extraHeaders, contentType, retry: false });
    }
    if (err.status === 401 && onUnauthorized && !AUTH_PATHS.some((p) => path.startsWith(p))) onUnauthorized(err, path);
    throw err;
  }

  const client = {
    base,
    request,
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    put: (path, body = {}) => request('PUT', path, body),
    patch: (path, body = {}) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
    // Binary upload (plugin packages): the body is sent as-is under `contentType`.
    postRaw: (path, body, contentType, headers = {}) => request('POST', path, body, { contentType, headers }),
    setCsrfToken(token) { csrfToken = token || null; },
    getCsrfToken: () => csrfToken,
    setUnauthorizedHandler(fn) { onUnauthorized = fn; },
    setStepUpHandler(fn) { onStepUp = fn; },
  };
  return client;
}

export const api = createApiClient();
