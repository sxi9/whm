export class ApiError extends Error {
  constructor(status, body) {
    const err = body?.error || {};
    super(err.message || `Request failed with status ${status}`);
    this.status = status;
    this.code = err.code || 'error';
    this.fields = err.fields || null;
    this.capability = err.capability || null;
    this.details = err.details || null;
    this.requestId = err.requestId || null;
  }
}

let csrfToken = null;
let onUnauthorized = null;

export const api = {
  setCsrfToken(token) { csrfToken = token; },
  setUnauthorizedHandler(fn) { onUnauthorized = fn; },

  async request(method, path, body, { raw = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrfToken && !['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    if (raw) return res;
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/login')) onUnauthorized();
      throw new ApiError(res.status, json);
    }
    return json ?? {};
  },

  get: (path) => api.request('GET', path),
  post: (path, body = {}) => api.request('POST', path, body),
  put: (path, body = {}) => api.request('PUT', path, body),
  patch: (path, body = {}) => api.request('PATCH', path, body),
  delete: (path) => api.request('DELETE', path),

  // Server-sent events for job progress. Returns a function that closes the stream.
  stream(path, onEvent, onError) {
    const es = new EventSource(`/api${path}`, { withCredentials: true });
    es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
    es.onerror = (e) => { onError?.(e); };
    return () => es.close();
  },
};

export function queryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
