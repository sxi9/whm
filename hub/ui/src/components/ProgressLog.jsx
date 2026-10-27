import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { StatusPill } from './Common.jsx';

// Hub copy: the hub has no SSE job stream; a job is polled at `jobPath`
// (GET /v1/admin/jobs/:id or /v1/reseller/jobs/:id) until it is done or failed.
export function ProgressLog({ jobPath, intervalMs = 1500, onFinished, renderResult }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!jobPath) return undefined;
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const { data } = await api.get(jobPath);
        if (!alive) return;
        setJob(data);
        if (data.status === 'done' || data.status === 'failed') { onFinished?.(data); return; }
      } catch (err) {
        if (!alive) return;
        setError(err);
        return;
      }
      timer = setTimeout(poll, intervalMs);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [jobPath, intervalMs, onFinished]);

  if (!jobPath) return null;
  const finished = job?.status === 'done' || job?.status === 'failed';
  return (
    <div className="progress-log">
      <div className="progress-head">
        <StatusPill status={job?.status || 'queued'} />
        <div className="progress-bar"><span style={{ width: `${finished ? 100 : job ? 50 : 5}%` }} /></div>
        <span className="muted">{job?.type || ''} {job?.id ? `· ${job.id}` : ''}</span>
      </div>
      {error && <div className="banner banner-error">{error.message}</div>}
      {job?.error && <div className="banner banner-error">{job.error}</div>}
      {job?.status === 'done' && (renderResult ? renderResult(job) : <pre className="log">{JSON.stringify(job.result, null, 2)}</pre>)}
    </div>
  );
}
