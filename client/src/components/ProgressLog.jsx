import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { StatusPill } from './Common.jsx';

export const TERMINAL_JOB_STATUSES = ['done', 'failed', 'cancelled'];

const formatLine = (ts, level, line) => `${ts}  ${String(level).toUpperCase().padEnd(5)}  ${line}`;

// Follows a job over its SSE stream. The server ends the response right after
// the terminal event, and right after the snapshot of a job that already
// finished; the browser treats that as a dropped connection and reconnects
// every few seconds, so the source is closed here as soon as the job is
// terminal. `onFinished` fires at most once per subscription, also for a job
// that finished before (or between) subscriptions. Returns a close function.
export function followJob(jobId, { onSnapshot, onLog, onProgress, onStatus, onFinished } = {}) {
  let finished = false;
  let close = null;
  const finish = (event) => {
    if (finished) return;
    finished = true;
    close?.();
    onFinished?.(event);
  };
  close = api.stream(`/system/jobs/${jobId}/stream`, (event) => {
    if (finished) return;
    if (event.type === 'snapshot') {
      const job = event.job || {};
      onSnapshot?.(job);
      if (TERMINAL_JOB_STATUSES.includes(job.status)) finish({ type: job.status, result: job.result ?? null, error: job.error ?? null, ...(job.error_code ? { code: job.error_code } : {}) });
    } else if (event.type === 'log') {
      onLog?.(event);
    } else if (event.type === 'progress') {
      onProgress?.(event);
    } else if (event.type === 'started') {
      onStatus?.('running', event);
    } else if (TERMINAL_JOB_STATUSES.includes(event.type)) {
      onStatus?.(event.type, event);
      finish(event);
    }
  });
  if (finished) close();
  return () => { finished = true; close(); };
}

// Live view of a background job via the SSE stream.
export function ProgressLog({ jobId, onFinished }) {
  const [job, setJob] = useState(null);
  const [lines, setLines] = useState([]);
  const [progress, setProgress] = useState({ pct: 0, message: null });
  const endRef = useRef(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (!jobId) return undefined;
    setLines([]);
    return followJob(jobId, {
      onSnapshot: (j) => {
        setJob(j);
        setProgress({ pct: j.progress, message: j.message });
        setLines((j.logs || []).map((l) => formatLine(l.ts, l.level, l.line)));
      },
      onLog: (e) => setLines((l) => [...l, formatLine(new Date().toISOString().slice(11, 19), e.level, e.line)]),
      onProgress: (e) => setProgress({ pct: e.progress, message: e.message }),
      onStatus: (status, e) => setJob((j) => ({ ...(j || {}), status, result: e.result, error: e.error })),
      onFinished: (e) => finishedRef.current?.(e),
    });
  }, [jobId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [lines]);

  if (!jobId) return null;
  return (
    <div className="progress-log">
      <div className="progress-head">
        <StatusPill status={job?.status || 'queued'} />
        <div className="progress-bar"><span style={{ width: `${progress.pct}%` }} /></div>
        <span className="muted">{progress.pct}% {progress.message ? `· ${progress.message}` : ''}</span>
      </div>
      <pre className="log">{lines.join('\n')}<div ref={endRef} /></pre>
      {job?.error && <div className="banner banner-error">{job.error}</div>}
    </div>
  );
}
