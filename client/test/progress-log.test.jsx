import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// A stand-in for the browser's EventSource: the test feeds it server events
// and records close() calls. The real one reconnects on its own after the
// server ends the response, which is exactly what followJob must prevent.
class FakeEventSource {
  static instances = [];
  constructor(url) { this.url = url; this.closed = 0; this.onmessage = null; this.onerror = null; FakeEventSource.instances.push(this); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() { this.closed += 1; }
}

const { followJob, ProgressLog, TERMINAL_JOB_STATUSES } = await import('../src/components/ProgressLog.jsx');

beforeEach(() => { FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource); });
afterEach(() => { vi.unstubAllGlobals(); });

const last = () => FakeEventSource.instances.at(-1);

describe('followJob', () => {
  it('reports an already-finished job once from its snapshot and closes the source', () => {
    const onFinished = vi.fn();
    const onSnapshot = vi.fn();
    followJob(42, { onSnapshot, onFinished });
    const es = last();
    expect(es.url).toBe('/api/system/jobs/42/stream');
    const job = { id: 42, status: 'done', progress: 100, message: null, result: { installed: ['php'] }, error: null, logs: [{ ts: '2026-10-30 10:00:00', level: 'info', line: 'ok' }] };
    es.emit({ type: 'snapshot', job });
    expect(onSnapshot).toHaveBeenCalledWith(job);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith({ type: 'done', result: { installed: ['php'] }, error: null });
    expect(es.closed).toBe(1);
    // What the browser would deliver after an automatic reconnect must be ignored.
    es.emit({ type: 'snapshot', job });
    es.emit({ type: 'done', result: null });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('carries the stored error and code of a job that failed before the subscription', () => {
    const onFinished = vi.fn();
    followJob(7, { onFinished });
    last().emit({ type: 'snapshot', job: { id: 7, status: 'failed', progress: 30, error: 'apt failed', error_code: 'APT_FAILED', result: null, logs: [] } });
    expect(onFinished).toHaveBeenCalledWith({ type: 'failed', result: null, error: 'apt failed', code: 'APT_FAILED' });
    expect(last().closed).toBe(1);
  });

  it('streams a running job, then closes on the terminal event and reports it once', () => {
    const calls = { log: [], progress: [], status: [] };
    const onFinished = vi.fn();
    const close = followJob(9, {
      onLog: (e) => calls.log.push(e.line),
      onProgress: (e) => calls.progress.push(e.progress),
      onStatus: (s) => calls.status.push(s),
      onFinished,
    });
    const es = last();
    es.emit({ type: 'snapshot', job: { id: 9, status: 'queued', progress: 0, message: null, logs: [] } });
    es.emit({ type: 'started' });
    es.emit({ type: 'log', level: 'info', line: 'installing' });
    es.emit({ type: 'progress', progress: 50, message: 'half' });
    expect(es.closed).toBe(0);
    expect(onFinished).not.toHaveBeenCalled();
    es.emit({ type: 'done', result: { ok: true } });
    expect(calls).toEqual({ log: ['installing'], progress: [50], status: ['running', 'done'] });
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith({ type: 'done', result: { ok: true } });
    expect(es.closed).toBe(1);
    es.emit({ type: 'done', result: { ok: true } });
    expect(onFinished).toHaveBeenCalledTimes(1);
    close();
    expect(es.closed).toBe(2);
  });

  it('closes on failed and cancelled events too, and an early close silences later events', () => {
    for (const type of ['failed', 'cancelled']) {
      const onFinished = vi.fn();
      followJob(3, { onFinished });
      last().emit({ type, error: type === 'failed' ? 'boom' : undefined });
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(onFinished.mock.calls[0][0].type).toBe(type);
      expect(last().closed).toBe(1);
    }
    expect(TERMINAL_JOB_STATUSES).toEqual(['done', 'failed', 'cancelled']);
    const onFinished = vi.fn();
    const close = followJob(4, { onFinished });
    close();
    last().emit({ type: 'done', result: null });
    expect(onFinished).not.toHaveBeenCalled();
  });
});

describe('ProgressLog', () => {
  it('renders the queued state before the stream delivers anything', () => {
    const html = renderToStaticMarkup(<ProgressLog jobId={5} onFinished={() => {}} />);
    expect(html).toContain('progress-log');
    expect(html).toContain('0%');
    expect(renderToStaticMarkup(<ProgressLog jobId={null} />)).toBe('');
  });
});
