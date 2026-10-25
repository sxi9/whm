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
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message) => new HttpError(409, 'conflict', message);
export const unprocessable = (message, fields) => new HttpError(422, 'validation_failed', message, fields);
export const serviceUnavailable = (message) => new HttpError(503, 'service_unavailable', message);

// Thrown by services when a subsystem (BIND, Exim, MySQL...) is not present on
// this host. The UI turns it into an "install this service" prompt.
export class CapabilityError extends HttpError {
  constructor(capability, detail) {
    super(501, 'capability_missing', detail || `The "${capability}" service is not installed on this server`);
    this.capability = capability;
  }
}
