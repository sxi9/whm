#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createContext, runOp, listOps, OpError, DEFAULT_ALLOWED_ROOTS } from './lib.js';

// whm-agentd: listens on a Unix socket for newline-delimited JSON requests
//   { id, op, args, principal: { username, role, ip, requestId } }
// and answers
//   { id, ok: true, result }  |  { id, ok: false, error: { code, message, details } }
// Only the op catalog is reachable; there is deliberately no "run this command" op.

const SOCKET = process.env.WHM_AGENT_SOCKET || '/run/whm-agent.sock';
const GROUP = process.env.WHM_AGENT_GROUP || 'whmpanel';
const CONFIG_FILE = process.env.WHM_AGENT_CONFIG || '/etc/whm/agent.conf';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    log('error', 'invalid agent config, using defaults', { file: CONFIG_FILE, error: err.message });
  }
  return {};
}

function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}

const config = loadConfig();
const allowedRoots = [...DEFAULT_ALLOWED_ROOTS, ...(config.extraAllowedRoots || [])];

function groupId(name) {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
    return line ? Number(line.split(':')[2]) : null;
  } catch { return null; }
}

function handleConnection(socket) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 64 * 1024 * 1024) { socket.destroy(); return; }
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) handleRequest(socket, line);
    }
  });
  socket.on('error', (err) => log('warn', 'socket error', { error: err.message }));
}

async function handleRequest(socket, line) {
  let req;
  try { req = JSON.parse(line); } catch { return reply(socket, { id: null, ok: false, error: { code: 'bad_request', message: 'invalid JSON' } }); }
  const { id, op, args, principal } = req || {};
  const started = Date.now();
  if (op === 'agent.ping') return reply(socket, { id, ok: true, result: { pong: true, pid: process.pid, ops: listOps().length } });
  if (op === 'agent.catalog') return reply(socket, { id, ok: true, result: listOps() });
  try {
    const ctx = createContext({ allowedRoots, principal, log: (lvl, msg, f) => log(lvl, msg, { op, ...f }) });
    const result = await runOp(op, args, ctx);
    log('info', 'op ok', { op, principal: principal?.username, requestId: principal?.requestId, ms: Date.now() - started });
    reply(socket, { id, ok: true, result });
  } catch (err) {
    const error = err instanceof OpError ? { code: err.code, message: err.message, details: err.details } : { code: 'internal', message: err.message };
    log('warn', 'op failed', { op, principal: principal?.username, requestId: principal?.requestId, code: error.code, message: error.message, ms: Date.now() - started });
    reply(socket, { id, ok: false, error });
  }
}

function reply(socket, msg) {
  if (!socket.destroyed) socket.write(JSON.stringify(msg) + '\n');
}

function start() {
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);
  const server = net.createServer(handleConnection);
  server.on('error', (err) => { log('error', 'server error', { error: err.message }); process.exit(1); });
  server.listen(SOCKET, () => {
    const gid = groupId(GROUP);
    try {
      if (gid != null) fs.chownSync(SOCKET, 0, gid);
      fs.chmodSync(SOCKET, 0o660);
    } catch (err) { log('warn', 'could not set socket ownership', { error: err.message }); }
    log('info', 'whm-agentd listening', { socket: SOCKET, group: GROUP, ops: listOps().length, uid: process.getuid?.() });
  });
  const shutdown = () => { server.close(() => { try { fs.unlinkSync(SOCKET); } catch { /* gone */ } process.exit(0); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
