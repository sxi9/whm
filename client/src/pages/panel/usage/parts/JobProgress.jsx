import { useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';
import { ProgressLog } from '../../../../components/ProgressLog.jsx';
import { useT } from '../../../../i18n/useT.js';
import { usePanelMe } from '../../../../panel/hooks/usePanel.js';

// The job stream (/api/system/jobs/:id/stream) answers 403 for role `user`, so a
// customer gets a notice and periodic refetches instead of the live log.
export function canStreamJobs(me) {
  const role = me?.user?.role;
  return role === 'root' || role === 'reseller';
}

export function JobProgress({ jobId, onFinished, message, pollMs = 5000, polls = 12 }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const streaming = canStreamJobs(me);
  const finishedRef = useRef(onFinished);
  useEffect(() => { finishedRef.current = onFinished; }, [onFinished]);
  useEffect(() => {
    if (!jobId || streaming) return undefined;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      finishedRef.current?.();
      if (n >= polls) clearInterval(timer);
    }, pollMs);
    return () => clearInterval(timer);
  }, [jobId, streaming, pollMs, polls]);
  if (!jobId) return null;
  if (streaming) return <ProgressLog jobId={jobId} onFinished={onFinished} />;
  return (
    <div className="banner banner-info" data-job={jobId}>
      <Clock size={18} />
      <div>
        <strong>{message ?? t('panel.usage.job_started', 'Started; this screen updates in a minute.')}</strong>
        <p className="muted">{t('panel.usage.job_background', 'The server is working on it in the background; there is nothing else to do here.')}</p>
      </div>
    </div>
  );
}
