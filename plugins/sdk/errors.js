'use strict';

/**
 * WHM Plugin SDK — error classes.
 *
 * Every error the host throws into a plugin, and every error a plugin is expected
 * to throw back, is a PluginError (or subclass) with a stable UPPER_SNAKE `code`,
 * an HTTP-ish `status` and an optional `details` object. The host maps these onto
 * the panel's standard error envelope `{ error: { code, message, details? } }`
 * (BLUEPRINT.md §12) when they escape a plugin route handler.
 *
 * Zero dependencies — Node built-ins only.
 */

class PluginError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, details?: any}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = new.target.name;
    this.code = opts.code || 'PLUGIN_ERROR';
    this.status = Number.isInteger(opts.status) ? opts.status : 500;
    if (opts.details !== undefined) this.details = opts.details;
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** A ctx call was made without the required permission scope being declared/granted. */
class PermissionError extends PluginError {
  /**
   * @param {string} scope   the scope that was required, e.g. "backups:write"
   * @param {string} method  the ctx method that was called, e.g. "ctx.api.backups.create"
   * @param {string} [pluginId]
   */
  constructor(scope, method, pluginId) {
    super(
      `Plugin "${pluginId || 'unknown'}" called ${method} without permission "${scope}"`,
      { code: 'PERMISSION_DENIED', status: 403, details: { scope, method, pluginId } },
    );
    this.scope = scope;
    this.method = method;
    this.pluginId = pluginId;
  }
}

/** Bad input (arguments, manifest, settings value, event name...). */
class ValidationError extends PluginError {
  /**
   * @param {string} message
   * @param {Array<{path?: string, code?: string, message: string}>|object} [fields]
   */
  constructor(message, fields) {
    super(message, {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: fields !== undefined ? { fields } : undefined,
    });
    this.fields = fields;
  }
}

/** A referenced resource (account, artefact, job, key…) does not exist. */
class NotFoundError extends PluginError {
  constructor(resource, id) {
    super(`${resource} not found: ${String(id)}`, {
      code: 'NOT_FOUND',
      status: 404,
      details: { resource, id },
    });
    this.resource = resource;
    this.id = id;
  }
}

/** The operation conflicts with current state (duplicate key, already running…). */
class ConflictError extends PluginError {
  constructor(message, details) {
    super(message, { code: 'CONFLICT', status: 409, details });
  }
}

/** A sandboxed path (ctx.fs) was rejected: absolute, traversal, symlink escape, NUL byte. */
class PathError extends PluginError {
  constructor(message, path) {
    super(message, { code: 'PATH_REJECTED', status: 400, details: { path } });
    this.path = path;
  }
}

/** Thrown by evt.cancel(reason) inside a cancellable pre-stage hook. */
class HookCancelled extends PluginError {
  constructor(reason, event) {
    super(`Hook cancelled ${event}: ${reason}`, {
      code: 'HOOK_CANCELLED',
      status: 409,
      details: { event, reason },
    });
    this.reason = reason;
    this.event = event;
  }
}

/** The plugin's engines.whm range does not include the running host version. */
class IncompatibleError extends PluginError {
  constructor(pluginId, range, hostVersion) {
    super(`Plugin "${pluginId}" requires WHM ${range} but host is ${hostVersion}`, {
      code: 'INCOMPATIBLE_HOST',
      status: 422,
      details: { pluginId, range, hostVersion },
    });
  }
}

/** Cron expression could not be parsed. */
class CronError extends ValidationError {
  constructor(message, expr) {
    super(message, [{ path: 'schedule', code: 'INVALID_CRON', message }]);
    this.code = 'INVALID_CRON';
    this.expr = expr;
  }
}

/** Something the plugin tried is not allowed in its current lifecycle state. */
class LifecycleError extends PluginError {
  constructor(message, details) {
    super(message, { code: 'LIFECYCLE', status: 409, details });
  }
}

module.exports = {
  PluginError,
  PermissionError,
  ValidationError,
  NotFoundError,
  ConflictError,
  PathError,
  HookCancelled,
  IncompatibleError,
  CronError,
  LifecycleError,
};
