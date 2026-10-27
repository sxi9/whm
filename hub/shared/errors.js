export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message, fields) => new HttpError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);
export const unprocessable = (message, fields) => new HttpError(422, 'validation_failed', message, fields);

// Errors that carry extra top-level fields in the envelope (e.g. the
// activations list of `activation_limit`) attach them as `extra`.
export function withExtra(err, extra) {
  err.extra = extra;
  return err;
}
