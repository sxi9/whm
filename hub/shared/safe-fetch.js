import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import { HttpError } from './errors.js';

// SSRF policy for every connection the hub makes to a host somebody else
// chose (namespace evidence, webhooks, OAuth callbacks): resolve first, refuse
// loopback/private/link-local/ULA/multicast/unspecified and the hub's own
// addresses, connect to the resolved address with the original Host/SNI,
// never follow redirects, send no credentials, cap time and body size, TLS on.

function refused(reason, detail) {
  return new HttpError(422, 'evidence_target_refused', detail ? `${reason}: ${detail}` : reason, { reason });
}

function ipv4Octets(ip) {
  return ip.split('.').map(Number);
}

function expandIpv6(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return { v4: mapped[1] };
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = Array(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
  return { groups };
}

export function classifyAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ipv4Octets(ip);
    if (a === 0) return 'unspecified';
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a >= 224 && a <= 239) return 'multicast';
    if (a >= 240) return 'reserved';
    return 'public';
  }
  if (net.isIPv6(ip)) {
    const e = expandIpv6(ip.replace(/%.*$/, ''));
    if (e.v4) return classifyAddress(e.v4);
    const g = e.groups;
    if (g.every((x) => x === 0)) return 'unspecified';
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
    if ((g[0] & 0xfe00) === 0xfc00) return 'ula';
    if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((g[0] & 0xff00) === 0xff00) return 'multicast';
    if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved';
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff) return classifyAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    return 'public';
  }
  return 'invalid';
}

export function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) out.add(i.address.replace(/%.*$/, ''));
  return [...out];
}

export function isForbiddenAddress(ip, { own = [] } = {}) {
  const cls = classifyAddress(ip);
  if (cls !== 'public') return cls;
  if (own.includes(ip)) return 'own-address';
  return null;
}

export function createSafeFetch({ lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true }), request = https.request, own = ownAddresses, resolver } = {}) {
  async function resolveTarget(hostname) {
    if (net.isIP(hostname)) {
      const why = isForbiddenAddress(hostname, { own: own() });
      if (why) throw refused(why, hostname);
      return { address: hostname, family: net.isIPv6(hostname) ? 6 : 4 };
    }
    let answers;
    try { answers = await lookup(hostname); } catch (err) { throw refused('dns-failure', err?.code || err?.message); }
    if (!Array.isArray(answers) || !answers.length) throw refused('dns-empty', hostname);
    const ownList = own();
    for (const a of answers) {
      const why = isForbiddenAddress(a.address, { own: ownList });
      if (why) throw refused(why, a.address);
    }
    return { address: answers[0].address, family: answers[0].family || (net.isIPv6(answers[0].address) ? 6 : 4) };
  }

  async function safeFetch(url, { timeoutMs = 5000, maxBytes = 4096, allowPorts = [443], method = 'GET', headers = {}, body } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { throw refused('invalid-url'); }
    if (u.protocol !== 'https:') throw refused('scheme', u.protocol);
    if (u.username || u.password) throw refused('credentials-in-url');
    const port = Number(u.port || 443);
    if (!allowPorts.includes(port)) throw refused('port', String(port));
    const target = await resolveTarget(u.hostname.replace(/^\[|\]$/g, ''));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); reject(refused('timeout', `${timeoutMs} ms`)); }, timeoutMs);
      timer.unref?.();
      let req;
      try {
        req = request({
          host: target.address, family: target.family, port, method, path: `${u.pathname}${u.search}`,
          servername: u.hostname, rejectUnauthorized: true, signal: controller.signal,
          headers: { host: u.host, accept: 'text/plain, application/json;q=0.9, */*;q=0.1', 'user-agent': 'whm-hub-verifier/1', ...headers },
          // The connection goes to the address that was checked: no second lookup.
          lookup: (_h, _o, cb) => cb(null, target.address, target.family),
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400) { clearTimeout(timer); res.resume(); return reject(refused('redirect', String(res.statusCode))); }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { clearTimeout(timer); res.destroy(); reject(refused('body-too-large', `> ${maxBytes} bytes`)); return; }
            chunks.push(c);
          });
          res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString('utf8'), address: target.address }); });
          res.on('error', (err) => { clearTimeout(timer); reject(refused('response-error', err.message)); });
        });
      } catch (err) {
        clearTimeout(timer);
        return reject(refused('request-error', err.message));
      }
      req.on('error', (err) => { clearTimeout(timer); reject(refused('connect-error', err.code || err.message)); });
      if (body != null) req.write(body);
      req.end();
    });
  }

  async function safeResolveTxt(name, { timeoutMs = 5000, maxRecords = 10 } = {}) {
    if (!/^[a-z0-9._-]{1,253}$/i.test(String(name))) throw refused('invalid-name');
    const r = resolver || new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
    let records;
    try {
      records = await Promise.race([
        r.resolveTxt(name),
        new Promise((_, rej) => setTimeout(() => rej(refused('dns-timeout')), timeoutMs).unref?.()),
      ]);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (['ENOTFOUND', 'ENODATA'].includes(err?.code)) return [];
      throw refused('dns-failure', err?.code || err?.message);
    }
    return records.slice(0, maxRecords).map((parts) => parts.join(''));
  }

  return Object.assign(safeFetch, { safeResolveTxt, resolveTarget });
}

const defaultFetch = createSafeFetch();
export const safeFetch = defaultFetch;
export const safeResolveTxt = defaultFetch.safeResolveTxt;
