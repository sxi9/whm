import { EventEmitter } from 'node:events';
import { badRequest } from './errors.js';

export const EVENT_NAME_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){1,5}$/;

// The panel-wide event bus (ctx.events): categories emit lifecycle events, the
// Development category's Manage Hooks and the plugin host subscribe. Created by
// core at bootstrap so every category sees the same instance.
export class PanelEvents extends EventEmitter {
  constructor(logger) {
    super();
    this.setMaxListeners(0);
    this.logger = logger;
    this.anyListeners = new Set();
    this.recent = [];
  }

  // on() returns an unsubscribe function instead of the emitter so services can
  // drop their listeners without keeping a reference to the handler.
  on(event, fn) { super.on(event, fn); return () => this.off(event, fn); }

  onAny(fn) { this.anyListeners.add(fn); return () => this.anyListeners.delete(fn); }

  // Unlike EventEmitter.emit this awaits every listener. For a 'pre' stage a
  // listener may throw to veto the operation; 'post' listener errors are logged.
  async emit(event, payload = {}, { stage = 'post', req = null } = {}) {
    if (typeof event !== 'string' || !EVENT_NAME_RE.test(event)) throw badRequest(`Invalid event name "${event}"`);
    const envelope = { event, stage, payload, at: new Date().toISOString(), principal: req?.user?.username ?? null, role: req?.user?.role ?? null, ip: req?.ip ?? null };
    const listeners = [...this.listeners(event), ...this.anyListeners];
    const results = [];
    for (const fn of listeners) {
      try {
        results.push(await fn(envelope));
      } catch (err) {
        if (stage === 'pre') throw err;
        this.logger?.warn({ err, event }, 'event listener failed');
        results.push({ error: err.message });
      }
    }
    this.recent.unshift({ event, stage, at: envelope.at, principal: envelope.principal, listeners: listeners.length });
    if (this.recent.length > 50) this.recent.length = 50;
    return { event, stage, listeners: listeners.length, results };
  }

  emitPre(event, payload, opts = {}) { return this.emit(event, payload, { ...opts, stage: 'pre' }); }
}
