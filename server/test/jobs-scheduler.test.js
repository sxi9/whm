import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createJobs } from '../src/lib/jobs.js';
import { createScheduler } from '../src/lib/scheduler.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function waitForEvent(jobs, id, types) {
  return new Promise((resolve) => {
    const off = jobs.subscribe(id, (event) => {
      if (types.includes(event.type)) { off(); resolve(event); }
    });
  });
}

// The scheduler dedupes by UTC minute, so a pair of ticks straddling :00 would
// legitimately enqueue twice. Wait out the last seconds of a minute if needed.
async function awayFromMinuteBoundary() {
  const into = Date.now() % 60_000;
  if (into > 56_000) await new Promise((r) => setTimeout(r, 60_000 - into + 250));
}

let tmp;
let db;
let jobs;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whm-jobs-'));
  db = openDatabase(path.join(tmp, 'jobs.db'));
  jobs = createJobs({ db, logger: silent, agent: { mode: 'mock' }, concurrency: 2 });
  jobs.register('ok.job', async (c) => {
    c.progress(10, 'starting');
    c.log('working');
    c.progress(150, 'clamped');
    expect(c.agent.mode).toBe('mock');
    return { sum: (c.params.a ?? 0) + (c.params.b ?? 0) };
  });
  jobs.register('fail.job', async (c) => {
    c.progress(40);
    throw new Error('boom');
  });
});

afterAll(() => {
  jobs?.stop();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('createJobs', () => {
  it('rejects unknown job types at enqueue time', () => {
    expect(() => jobs.enqueue('nope.job')).toThrow(/Unknown job type/);
    expect(jobs.types()).toEqual(expect.arrayContaining(['ok.job', 'fail.job']));
  });

  it('cancels a queued job before the worker starts', async () => {
    const job = jobs.enqueue('ok.job', { a: 1 });
    expect(job.status).toBe('queued');
    expect(job.params).toEqual({ a: 1 });
    await new Promise((r) => setImmediate(r));
    expect(jobs.get(job.id).status).toBe('queued');
    jobs.cancel(job.id);
    const after = jobs.get(job.id);
    expect(after.status).toBe('cancelled');
    expect(after.finished_at).toBeTruthy();
    expect(() => jobs.cancel(job.id)).toThrow(/Only queued jobs/);
  });

  it('runs a handler to completion with progress, logs and result', async () => {
    jobs.start();
    const job = jobs.enqueue('ok.job', { a: 1, b: 2 }, { userId: null });
    const done = await waitForEvent(jobs, job.id, ['done', 'failed']);
    expect(done).toEqual({ type: 'done', result: { sum: 3 } });
    const row = jobs.get(job.id);
    expect(row.status).toBe('done');
    expect(row.progress).toBe(100);
    expect(row.result).toEqual({ sum: 3 });
    expect(row.error).toBeNull();
    expect(row.started_at).toBeTruthy();
    expect(row.finished_at).toBeTruthy();
    expect(row.logs.map((l) => l.line)).toEqual(['working']);
    expect(row.params_json).toBeUndefined();
    expect(jobs.runningCount()).toBe(0);
  });

  it('marks a throwing handler as failed and records the error', async () => {
    const seen = [];
    const job = jobs.enqueue('fail.job');
    const offAny = jobs.onAny((e) => { if (e.jobId === job.id) seen.push(e.type); });
    const failed = await waitForEvent(jobs, job.id, ['done', 'failed']);
    offAny();
    expect(failed).toEqual({ type: 'failed', error: 'boom' });
    const row = jobs.get(job.id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('boom');
    expect(row.progress).toBe(40);
    expect(row.result).toBeNull();
    expect(row.logs).toEqual([expect.objectContaining({ level: 'error', line: 'boom' })]);
    expect(seen).toContain('started');
    expect(seen).toContain('failed');
  });

  it('lists and filters jobs and 404s unknown ids', () => {
    expect(jobs.list({ status: 'failed' }).map((j) => j.type)).toEqual(['fail.job']);
    expect(jobs.list({ type: 'ok.job' }).length).toBe(2);
    expect(jobs.list({ limit: 1 })).toHaveLength(1);
    expect(jobs.list().length).toBeGreaterThanOrEqual(3);
    expect(() => jobs.get(999_999)).toThrow(/Job not found/);
  });

  it('fails stale "running" jobs when the worker (re)starts and stays idle while stopped', async () => {
    const { lastInsertRowid } = db.prepare(`INSERT INTO jobs (type, status, params_json) VALUES ('ok.job', 'running', '{}')`).run();
    jobs.stop();
    const parked = jobs.enqueue('ok.job', { a: 1, b: 1 });
    await new Promise((r) => setImmediate(r));
    expect(jobs.get(parked.id).status).toBe('queued');

    jobs.start();
    const stale = jobs.get(lastInsertRowid);
    expect(stale.status).toBe('failed');
    expect(stale.error).toMatch(/restarted/);
    expect(['running', 'done']).toContain(jobs.get(parked.id).status);
    expect((await waitForEvent(jobs, parked.id, ['done', 'failed'])).type).toBe('done');
  });
});

describe('createScheduler', () => {
  let scheduler;

  beforeAll(() => {
    scheduler = createScheduler({ db, jobs, logger: silent });
  });

  afterAll(() => scheduler?.stop());

  it('ensure() creates or updates a schedule row and validates the cron', () => {
    scheduler.ensure('nightly.test', '0 2 * * *', 'ok.job', { a: 5 });
    let row = scheduler.list().find((r) => r.name === 'nightly.test');
    expect(row).toMatchObject({ cron: '0 2 * * *', job_type: 'ok.job', enabled: 1, params: { a: 5 } });
    expect(row.params_json).toBeUndefined();
    expect(() => new Date(row.next_run_at).toISOString()).not.toThrow();

    scheduler.ensure('nightly.test', '0 3 * * *', 'fail.job');
    row = scheduler.list().find((r) => r.name === 'nightly.test');
    expect(row.job_type).toBe('fail.job');
    expect(row.cron).toBe('0 2 * * *');

    expect(() => scheduler.ensure('bad.test', 'not a cron', 'ok.job')).toThrow(/invalid cron/);
    expect(scheduler.list().some((r) => r.name === 'bad.test')).toBe(false);
  });

  it('update() changes cron, enabled and params', () => {
    const updated = scheduler.update('nightly.test', { cron: '*/5 * * * *', enabled: false });
    expect(updated).toMatchObject({ name: 'nightly.test', cron: '*/5 * * * *', enabled: 0 });
    expect(JSON.parse(updated.params_json)).toEqual({ a: 5 });

    const again = scheduler.update('nightly.test', { params: { b: 1 } });
    expect(again.cron).toBe('*/5 * * * *');
    expect(again.enabled).toBe(0);
    expect(JSON.parse(again.params_json)).toEqual({ b: 1 });

    // The route passes these through: a missing name is a 404, an out-of-range
    // cron a 422 with a field message, never a plain Error (500 + error log).
    expect(() => scheduler.update('does.not.exist', { enabled: true })).toThrow(expect.objectContaining({ status: 404, message: 'Schedule not found' }));
    for (const bad of ['nope', '0 0 * * 8', '60 * * * *', '0 25 * * *']) {
      expect(() => scheduler.update('nightly.test', { cron: bad }), bad).toThrow(expect.objectContaining({ status: 422, code: 'validation_failed', fields: { cron: [expect.stringMatching(/cron/)] } }));
    }
    expect(scheduler.list().find((r) => r.name === 'nightly.test').cron).toBe('*/5 * * * *');
  });

  it('tick() enqueues due schedules once per minute', async () => {
    scheduler.ensure('every.minute', '* * * * *', 'ok.job', { a: 2, b: 2 });
    scheduler.ensure('disabled.minute', '* * * * *', 'ok.job');
    scheduler.update('disabled.minute', { enabled: false });
    scheduler.ensure('ghost.minute', '* * * * *', 'ghost.job');
    const before = jobs.list({ type: 'ok.job' }).length;

    await awayFromMinuteBoundary();
    scheduler.tick();
    const afterFirst = jobs.list({ type: 'ok.job' });
    expect(afterFirst.length).toBe(before + 1);
    expect(afterFirst[0].params).toEqual({ a: 2, b: 2 });
    expect(jobs.list().some((j) => j.type === 'ghost.job')).toBe(false);

    const row = scheduler.list().find((r) => r.name === 'every.minute');
    expect(row.last_run_at).toBeTruthy();
    expect(row.next_run_at).toBeTruthy();

    scheduler.tick();
    scheduler.tick();
    expect(jobs.list({ type: 'ok.job' }).length).toBe(before + 1);
    expect(scheduler.list().find((r) => r.name === 'disabled.minute').last_run_at).toBeNull();

    await waitForEvent(jobs, afterFirst[0].id, ['done', 'failed']).then((e) => expect(e.type).toBe('done'));
  }, 15_000);

  it('tick() does not enqueue a schedule whose previous job is still queued or running', async () => {
    scheduler.remove('every.minute');
    scheduler.remove('disabled.minute');
    scheduler.remove('ghost.minute');
    const parked = (c) => jobs.list({ type: 'ok.job', status: 'queued' }).filter((j) => j.params.c === c);
    const rewind = db.prepare('UPDATE schedules SET last_run_at = NULL WHERE name = ?');

    // Worker stopped: the first run stays queued, as when both slots hold long jobs.
    jobs.stop();
    scheduler.ensure('coalesce.minute', '* * * * *', 'ok.job', { c: 1 });
    scheduler.ensure('sibling.minute', '* * * * *', 'ok.job', { c: 2 });
    await awayFromMinuteBoundary();
    scheduler.tick();
    expect(parked(1)).toHaveLength(1);
    expect(parked(2)).toHaveLength(1);

    rewind.run('coalesce.minute');
    scheduler.tick();
    expect(parked(1)).toHaveLength(1);
    const row = scheduler.list().find((r) => r.name === 'coalesce.minute');
    expect(row.last_run_at).toBeTruthy();
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());

    // A running job of the same type and params also blocks a new one, while a
    // job of the same type with other params (an operator's run) does not.
    const releases = [];
    jobs.register('slow.job', () => new Promise((resolve) => { releases.push(resolve); }));
    scheduler.ensure('slow.minute', '* * * * *', 'slow.job', { c: 3 });
    scheduler.remove('coalesce.minute');
    scheduler.remove('sibling.minute');
    jobs.start();
    const slowJobs = () => jobs.list({ type: 'slow.job' });
    const startedBefore = slowJobs().length;
    scheduler.tick();
    expect(slowJobs().length).toBe(startedBefore + 1);
    const [slow] = slowJobs();
    for (let i = 0; i < 100 && jobs.get(slow.id).status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(jobs.get(slow.id).status).toBe('running');

    rewind.run('slow.minute');
    scheduler.tick();
    expect(slowJobs().length).toBe(startedBefore + 1);

    jobs.enqueue('slow.job', { c: 4, by: 'operator' });
    scheduler.ensure('slow.other', '* * * * *', 'slow.job', { c: 5 });
    scheduler.tick();
    expect(slowJobs().length).toBe(startedBefore + 3);
    expect(slowJobs().map((j) => j.params.c).sort()).toEqual([3, 4, 5]);

    scheduler.remove('slow.minute');
    scheduler.remove('slow.other');
    for (const j of jobs.list({ type: 'slow.job', status: 'queued' })) jobs.cancel(j.id);
    for (const release of releases) release();
    for (let i = 0; i < 100 && jobs.list({ type: 'slow.job', status: 'running' }).length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(jobs.list({ type: 'slow.job', status: 'running' })).toHaveLength(0);
  }, 15_000);

  it('start() re-arms each tick for the next minute boundary instead of a drifting interval', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T10:00:12.000Z'));
      const fired = [];
      const mockJobs = { types: () => ['anchor.job'], list: () => [], enqueue: () => { fired.push(new Date().toISOString()); return {}; } };
      const anchored = createScheduler({ db, jobs: mockJobs, logger: silent });
      anchored.ensure('anchor.minute', '* * * * *', 'anchor.job');
      try {
        anchored.start();
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(48_000);
        expect(fired).toEqual(['2030-01-01T10:01:00.000Z']);

        // The event loop was busy: the 10:02 tick fires 1.9 s late. The next
        // one must still land on 10:03:00, not 60 s after the late tick.
        vi.advanceTimersByTime(59_000);
        vi.setSystemTime(new Date('2030-01-01T10:02:00.900Z'));
        vi.advanceTimersByTime(1_000);
        expect(fired[1]).toBe('2030-01-01T10:02:01.900Z');
        vi.advanceTimersByTime(58_099);
        expect(fired).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(fired[2]).toBe('2030-01-01T10:03:00.000Z');

        anchored.stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(120_000);
        expect(fired).toHaveLength(3);
      } finally {
        anchored.stop();
        anchored.remove('anchor.minute');
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
