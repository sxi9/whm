import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

// Ops report problems with stable codes; validation-style failures (a bad
// certificate, a key that does not match, an invalid config) are the caller's
// fault and surface as 422 with the op's message rather than a 500.
const CLIENT_FAULT_CODES = new Set(['config_invalid', 'refused', 'validation_failed', 'acme_failed', 'unsupported', 'in_use', 'conflict', 'build_failed', 'git_failed', 'download_failed']);
export function agentErrorStatus(code = '') {
  if (code === 'capability_missing' || code === 'binary_not_found') return 501;
  if (code === 'invalid_args') return 422;
  if (code === 'not_found') return 404;
  if (code === 'exists') return 409;
  if (code === 'path_not_allowed' || code === 'unknown_op') return 403;
  if (code === 'agent_unavailable' || code === 'timeout') return 503;
  if (code.startsWith('invalid_') || code.endsWith('_mismatch') || CLIENT_FAULT_CODES.has(code)) return 422;
  return 500;
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'No such API endpoint' } });
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.fields) body.error.fields = err.fields;
      if (err.capability) body.error.capability = err.capability;
      return res.status(err.status).json(body);
    }
    if (err instanceof ZodError) {
      const fields = {};
      for (const issue of err.issues) (fields[issue.path.join('.') || '_'] ||= []).push(issue.message);
      return res.status(422).json({ error: { code: 'validation_failed', message: 'Validation failed', fields } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON' } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large' } });
    }
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ error: { code: 'conflict', message: 'A record with that identifier already exists' } });
    }
    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(409).json({ error: { code: 'conflict', message: 'The record is referenced by other data and cannot be changed this way' } });
    }
    // Agent op failures carry a stable code; surface them without the stack.
    if (err?.agentError) {
      return res.status(agentErrorStatus(err.code)).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    logger.error({ err, requestId: req.id, path: req.originalUrl }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error', requestId: req.id } });
  };
}
