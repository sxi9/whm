import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, waitForJob } from './support/app.js';

// A handler that throws before its first await used to release its worker
// slot before the worker had recorded it, leaking one slot per such job until
// the queue stalled.
let app;
beforeAll(async () => {
  app = await createTestApp();
  app.ctx.jobs.register('test.boom', () => { throw new Error('boom'); });
  app.ctx.jobs.register('test.fine', async () => ({ ok: true }));
  app.ctx.jobs.start();
});
afterAll(async () => { await app.close(); });

describe('job worker slots', () => {
  it('survive handlers that throw synchronously', async () => {
    const boom = [];
    for (let i = 0; i < 5; i++) boom.push(app.ctx.jobs.enqueue('test.boom', { i }));
    for (const j of boom) expect((await waitForJob(app.ctx, j.id)).status).toBe('failed');
    expect(app.ctx.jobs.runningCount()).toBe(0);
    const fine = app.ctx.jobs.enqueue('test.fine');
    const done = await waitForJob(app.ctx, fine.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ ok: true });
  });
});
