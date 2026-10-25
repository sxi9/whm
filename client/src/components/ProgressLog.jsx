import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { StatusPill } from './Common.jsx';

// Live view of a background job via the SSE stream.
export function ProgressLog({ jobId, onFinished }) {
  const [job, setJob] = useState(null);
  const [lines, setLines] = useState([]);
  const [progress, setProgress] = useState({ pct: 0, message: null });
  const endRef = useRef(null);

  useEffect(() => {
    if (!jobId) return undefined;
    setLines([]);
    const close = api.stream(`/system/jobs/${jobId}/stream`, (event) => {
      if (event.type === 'snapshot') {
        setJob(event.job);
        setProgress({ pct: event.job.progress, message: event.job.message });
        setLines((event.job.logs || []).map((l) => `${l.ts}  ${l.level.toUpperCase().padEnd(5)}  ${l.line}`));
      } else if (event.type === 'log') {
        setLines((l) => [...l, `${new Date().toISOString().slice(11, 19)}  ${event.level.toUpperCase().padEnd(5)}  ${event.line}`]);
      } else if (event.type === 'progress') {
        setProgress({ pct: event.progress, message: event.message });
      } else if (['done', 'failed', 'cancelled', 'started'].includes(event.type)) {
        setJob((j) => ({ ...(j || {}), status: event.type === 'started' ? 'running' : event.type, result: event.result, error: event.error }));
        if (event.type !== 'started') onFinished?.(event);
      }
    });
    return close;
  }, [jobId, onFinished]);

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
