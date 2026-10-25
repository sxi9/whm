import net from 'node:net';
import crypto from 'node:crypto';

export class AgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.agentError = true;
  }
}

// The only way the API process performs a privileged operation. In monolithic
// mode the op catalog runs in-process; in split mode requests go to whm-agentd
// over its Unix socket. Callers never see the difference.
export function createAgentClient({ config, logger }) {
  if (config.mode === 'monolithic') return monolithicClient({ logger });
  return socketClient({ socketPath: config.agentSocket, logger });
}

function principalOf(req) {
  if (!req) return null;
  return { username: req.user?.username ?? null, role: req.user?.role ?? null, ip: req.ip ?? null, requestId: req.id ?? null };
}

function monolithicClient({ logger }) {
  let lib = null;
  const load = async () => (lib ||= await import('@whm/agent'));
  return {
    mode: 'monolithic',
    async op(name, args = {}, { req } = {}) {
      const { executeOp, OpError } = await load();
      const started = Date.now();
      try {
        const result = await executeOp(name, args, { principal: principalOf(req), log: (level, msg, fields) => logger[level]?.({ op: name, ...fields }, msg) });
        logger.debug({ op: name, ms: Date.now() - started }, 'agent op ok');
        return result;
      } catch (err) {
        if (err instanceof OpError) {
          logger.warn({ op: name, code: err.code, ms: Date.now() - started }, err.message);
          throw new AgentError(err.code, err.message, err.details);
        }
        throw new AgentError('internal', err.message);
      }
    },
    async ping() { const { listOps } = await load(); return { pong: true, ops: listOps().length, mode: 'monolithic' }; },
    async catalog() { const { listOps } = await load(); return listOps(); },
  };
}

function socketClient({ socketPath, logger, timeoutMs = 600_000 }) {
  let socket = null;
  let buffer = '';
  const pending = new Map();

  function connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.setEncoding('utf8');
      s.once('connect', () => { socket = s; resolve(s); });
      s.once('error', (err) => { if (socket !== s) reject(err); });
      s.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          const entry = pending.get(msg.id);
          if (!entry) continue;
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(new AgentError(msg.error?.code || 'internal', msg.error?.message || 'agent error', msg.error?.details));
        }
      });
      s.on('close', () => {
        if (socket === s) socket = null;
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new AgentError('agent_unavailable', 'Lost connection to whm-agentd'));
          pending.delete(id);
        }
      });
    });
  }

  async function send(op, args, principal) {
    if (!socket) {
      try { await connect(); } catch (err) {
        throw new AgentError('agent_unavailable', `Cannot reach whm-agentd at ${socketPath}: ${err.message}`);
      }
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new AgentError('timeout', `Agent op "${op}" timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, op, args, principal }) + '\n');
    });
  }

  return {
    mode: 'split',
    async op(name, args = {}, { req } = {}) {
      const started = Date.now();
      try {
        const result = await send(name, args, principalOf(req));
        logger.debug({ op: name, ms: Date.now() - started }, 'agent op ok');
        return result;
      } catch (err) {
        logger.warn({ op: name, code: err.code, ms: Date.now() - started }, err.message);
        throw err;
      }
    },
    ping: () => send('agent.ping', {}, null),
    catalog: () => send('agent.catalog', {}, null),
  };
}
