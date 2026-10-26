import { describe, it, expect } from 'vitest';
import { runOp, createContext, OpError, catalog } from '../src/lib.js';
import { parseWorkerTable, parseStatusPage, decodeEntities } from '../src/ops/modstatus.js';

const ctx = createContext();

async function opError(promise) {
  try { await promise; } catch (err) { expect(err).toBeInstanceOf(OpError); return err; }
  throw new Error('expected the op to reject');
}

// Shape of Apache 2.4's HTML report with ExtendedStatus On: bold Srv cell,
// newline inside the M and CPU cells, nowrap VHost/Request, escaped request.
const PAGE = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
<html><head><title>Apache Status</title></head><body>
<h1>Apache Server Status for localhost (via 127.0.0.1)</h1>
<dl><dt>Server Version: Apache/2.4.58 (Ubuntu)</dt><dt>Server MPM: event</dt></dl>
<pre>WW__K.....R_
</pre>
<p>Scoreboard Key:<br />
"<b><code>_</code></b>" Waiting for Connection, "<b><code>W</code></b>" Sending Reply</p>

<table border="0"><tr><th>Srv</th><th>PID</th><th>Acc</th><th>M</th><th>CPU
</th><th>SS</th><th>Req</th><th>Dur</th><th>Conn</th><th>Child</th><th>Slot</th><th>Client</th><th>Protocol</th><th>VHost</th><th>Request</th></tr>

<tr><td><b>0-2</b></td><td>31337</td><td>0/12/345</td><td>W
</td><td>0.53</td><td>0</td><td>125</td><td>14450</td><td>3.4</td><td>1.25</td><td>40.11
</td><td>203.0.113.9</td><td>http/1.1</td><td nowrap>example.com:80</td><td nowrap>GET /wp-admin/index.php?x=1&amp;y=&lt;b&gt; HTTP/1.1</td></tr>

<tr><td><b>1-2</b></td><td>31338</td><td>2/7/90</td><td>K
</td><td>0.10</td><td>3</td><td>4</td><td>900</td><td>0.0</td><td>0.30</td><td>9.00
</td><td>198.51.100.4</td><td>h2</td><td nowrap>shop.example.net:443</td><td nowrap>GET /index.html HTTP/2.0</td></tr>

<tr><td><b>2-0</b></td><td>-</td><td>0/0/0</td><td>.
</td><td>0.00</td><td>0</td><td>0</td><td>0</td><td>0.0</td><td>0.00</td><td>0.00
</td><td></td><td></td><td nowrap></td><td nowrap></td></tr>
</table>
<hr /> <table>
<tr><th>Srv</th><td>Child Server number - generation</td></tr>
<tr><th>PID</th><td>OS process ID</td></tr>
</table>
<table border="0"><tr><th>Cache Type</th><th>Shared Memory</th></tr><tr><td>shmcb</td><td>512000</td></tr></table>
</body></html>`;

// Older release without the Protocol and Dur columns.
const OLD_PAGE = `<html><body><h1>Apache Server Status for localhost</h1>
<table border="0"><tr><th>Srv</th><th>PID</th><th>Acc</th><th>M</th><th>CPU
</th><th>SS</th><th>Req</th><th>Conn</th><th>Child</th><th>Slot</th><th>Client</th><th>VHost</th><th>Request</th></tr>
<tr><td><b>0-0</b></td><td>1000</td><td>1/2/3</td><td>_
</td><td>0.01</td><td>9</td><td>1</td><td>0.0</td><td>0.01</td><td>0.02
</td><td>127.0.0.1</td><td nowrap>localhost:80</td><td nowrap>GET /server-status HTTP/1.1</td></tr>
</table></body></html>`;

// ExtendedStatus Off: scoreboard only, no worker table.
const BASIC_PAGE = `<html><head><title>Apache Status</title></head><body><h1>Apache Server Status for localhost</h1>
<pre>__W.
</pre><p>Scoreboard Key:<br /></p>
<table><tr><th>Srv</th><td>Child Server number - generation</td></tr></table></body></html>`;

describe('mod_status HTML worker table parser', () => {
  it('maps every column by header and decodes the request line', () => {
    const { columns, workers } = parseWorkerTable(PAGE);
    expect(columns.map((c) => c.header)).toEqual(['Srv', 'PID', 'Acc', 'M', 'CPU', 'SS', 'Req', 'Dur', 'Conn', 'Child', 'Slot', 'Client', 'Protocol', 'VHost', 'Request']);
    expect(columns.every((c) => c.key)).toBe(true);
    expect(workers).toHaveLength(3);
    expect(workers[0]).toMatchObject({
      srv: '0-2', slot: 0, generation: 2, pid: 31337, acc: { connection: 0, child: 12, slot: 345 }, mode: 'W', cpuSeconds: 0.53, secondsSinceRequest: 0, requestMs: 125, durationMs: 14450,
      connKBytes: 3.4, childMBytes: 1.25, slotMBytes: 40.11, client: '203.0.113.9', protocol: 'http/1.1', vhost: 'example.com:80', request: 'GET /wp-admin/index.php?x=1&y=<b> HTTP/1.1',
    });
    expect(workers[1]).toMatchObject({ srv: '1-2', pid: 31338, mode: 'K', protocol: 'h2', vhost: 'shop.example.net:443' });
  });

  it('keeps open slots with no process and empty cells as nulls', () => {
    const { workers } = parseWorkerTable(PAGE);
    expect(workers[2]).toMatchObject({ srv: '2-0', slot: 2, generation: 0, pid: null, mode: '.', acc: { connection: 0, child: 0, slot: 0 }, client: null, protocol: null, vhost: null, request: null });
  });

  it('handles older column sets without Protocol or Dur', () => {
    const { columns, workers } = parseWorkerTable(OLD_PAGE);
    expect(columns.map((c) => c.key)).not.toContain('protocol');
    expect(workers[0]).toMatchObject({ pid: 1000, mode: '_', durationMs: null, protocol: null, connKBytes: 0, childMBytes: 0.01, slotMBytes: 0.02, vhost: 'localhost:80', request: 'GET /server-status HTTP/1.1' });
  });

  it('ignores the legend and TLS cache tables and reports no table when ExtendedStatus is Off', () => {
    expect(parseWorkerTable(BASIC_PAGE)).toBeNull();
    expect(parseWorkerTable('')).toBeNull();
    expect(parseWorkerTable('<table><tr><th>Cache Type</th><th>Shared Memory</th></tr><tr><td>shmcb</td><td>1</td></tr></table>')).toBeNull();
    expect(parseStatusPage(BASIC_PAGE)).toEqual({ statusPage: true, extended: false, table: null });
    expect(parseStatusPage(PAGE).extended).toBe(true);
    expect(parseStatusPage('<html><body>It works!</body></html>')).toEqual({ statusPage: false, extended: null, table: null });
  });

  it('never leaks markup from a crafted request line', () => {
    const { workers } = parseWorkerTable(PAGE.replace('GET /index.html HTTP/2.0', 'GET /&lt;script&gt;alert(1)&lt;/script&gt;?a=%27 HTTP/1.1'));
    expect(workers[1].request).toBe('GET /<script>alert(1)</script>?a=%27 HTTP/1.1');
    expect(workers[1].request).not.toContain('<td');
    expect(decodeEntities('a&amp;b&#39;c&#x41;&unknown;')).toBe("a&b'cA&unknown;");
  });
});

describe('modstatus op schemas', () => {
  it('is registered and not destructive', () => {
    expect(catalog.get('modstatus.workers')).toMatchObject({ destructive: false });
  });

  it('rejects unknown ops and injected arguments before anything runs', async () => {
    expect((await opError(runOp('modstatus.nope', {}, ctx))).code).toBe('unknown_op');
    expect((await opError(runOp('modstatus.workers', { port: 0 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { port: 70000 }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { port: '80; id' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { bind: 'localhost' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { bind: '127.0.0.1; id' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { bind: '-r' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { bind: '../etc' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { host: '127.0.0.1' }, ctx))).code).toBe('invalid_args');
    expect((await opError(runOp('modstatus.workers', { path: '/server-status' }, ctx))).code).toBe('invalid_args');
  });

  it('answers reachable: false when nothing listens on the probe address', async () => {
    const out = await runOp('modstatus.workers', { port: 1, bind: '127.0.0.1' }, ctx);
    expect(out).toMatchObject({ probe: { host: '127.0.0.1', port: 1 }, reachable: false, statusPage: false, workers: [] });
  });
});
