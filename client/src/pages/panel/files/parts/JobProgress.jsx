import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../api/client.js';
import { StatusPill } from '../../../../components/Common.jsx';

// The shared ProgressLog streams the reseller-only system job route; a
// customer follows the account's archive jobs on the panel's own stream.
export const jobStreamPath = (id) => `/panel/files/jobs/${id}/stream`;

export function JobProgress({ jobId, onFinished }) {
  const [job, setJob] = useState(null);
  const [lines, setLines] = useState([]);
  const [progress, setProgress] = useState({ pct: 0, message: null });
  const endRef = useRef(null);
  const finishedRef = useRef(onFinished);
  useEffect(() => { finishedRef.current = onFinished; }, [onFinished]);

  useEffect(() => {
    if (!jobId) return undefined;
    setLines([]);
    const close = api.stream(jobStreamPath(jobId), (event) => {
      if (event.type === 'snapshot') {
        setJob(event.job);
        setProgress({ pct: event.job.progress || 0, message: event.job.message });
        setLines((event.job.logs || []).map((l) => `${l.ts}  ${String(l.level || 'info').toUpperCase().padEnd(5)}  ${l.line}`));
        if (['done', 'failed', 'cancelled'].includes(event.job.status)) finishedRef.current?.({ type: event.job.status, result: event.job.result, error: event.job.error });
      } else if (event.type === 'log') {
        setLines((l) => [...l, `${new Date().toISOString().slice(11, 19)}  ${String(event.level || 'info').toUpperCase().padEnd(5)}  ${event.line}`]);
      } else if (event.type === 'progress') {
        setProgress({ pct: event.progress, message: event.message });
      } else if (['done', 'failed', 'cancelled', 'started'].includes(event.type)) {
        setJob((j) => ({ ...(j || {}), status: event.type === 'started' ? 'running' : event.type, result: event.result, error: event.error }));
        if (event.type !== 'started') finishedRef.current?.(event);
      }
    });
    return close;
  }, [jobId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [lines]);

  if (!jobId) return null;
  return (
    <div className="progress-log" data-job={jobId}>
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
