// Access-log verdicts for pino-http. A 501 is CapabilityError (a daemon this
// host lacks) and most 4xx are the caller's own outcome, so neither is a panel
// failure; only 5xx proper and transport errors are. pino-http fabricates an
// Error for every >= 500 response, so the 501 line's message and object are
// shaped here as well.
const CLIENT_OUTCOMES = new Set([400, 404, 409, 413, 422]);

export function requestLogLevel(res, err) {
  const status = res.statusCode;
  if (err) return 'error';
  if (status === 501) return 'warn';
  if (status >= 500) return 'error';
  if (status >= 400) return CLIENT_OUTCOMES.has(status) ? 'info' : 'warn';
  return 'info';
}

// pino-http hands customErrorObject the real error when the response errored
// and otherwise its own `new Error('failed with status code N')`.
export const isSyntheticError = (res, err) => err?.message === `failed with status code ${res.statusCode}`;

export const requestLogMessage = (res, err) => (res.statusCode === 501 && isSyntheticError(res, err) ? 'request completed (capability missing)' : 'request errored');

export function requestLogObject(res, err, obj) {
  if (res.statusCode !== 501 || !isSyntheticError(res, err)) return obj;
  const { err: _synthetic, ...rest } = obj;
  return rest;
}
