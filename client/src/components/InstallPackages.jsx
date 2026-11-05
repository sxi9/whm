import { useCallback, useState } from 'react';
import { api } from '../api/client.js';
import { Button, ErrorBanner } from './Form.jsx';
import { ProgressLog } from './ProgressLog.jsx';
import { useToast } from './Toast.jsx';

export function normalizePackages(packages) {
  const list = Array.isArray(packages) ? packages : typeof packages === 'string' ? packages.split(/\s+/) : [];
  return [...new Set(list.map((p) => String(p).trim()).filter(Boolean))];
}

export function installPackagesBody(packages) {
  return { packages: normalizePackages(packages) };
}

// One-click install of known distro packages: queues the package job in
// place and follows its log right under the button, so a page that finds a
// tool missing never has to send the operator to the package search.
export function InstallPackages({ packages, label, size = 'sm', variant = 'primary', onFinished, children }) {
  const toast = useToast();
  const names = normalizePackages(packages);
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const text = children || label || `Install ${names.join(', ')}`;

  const start = async () => {
    if (!names.length) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post('/software/pkg/install', installPackagesBody(names));
      setJobId(data.job.id);
      toast.info(`Install ${names.join(', ')} queued (job #${data.job.id})`);
    } catch (err) {
      setError(err);
      toast.error(err);
      setBusy(false);
    }
  };
  const finished = useCallback((event) => {
    setBusy(false);
    onFinished?.(event);
  }, [onFinished]);

  if (!names.length) return null;
  return (
    <div className="install-packages" style={{ display: 'inline-block', maxWidth: '100%' }}>
      <Button size={size} variant={variant} loading={busy} onClick={start} title={`apt/dnf install ${names.join(' ')}`}>{text}</Button>
      <ErrorBanner error={error} />
      {jobId && (
        <div className="card" style={{ marginTop: 10 }}>
          <header className="card-header"><div><h2>Installing {names.join(', ')}</h2><p className="muted">Job #{jobId} · also visible under Server Status › Task Queue Monitor</p></div></header>
          <div className="card-body"><ProgressLog jobId={jobId} onFinished={finished} /></div>
        </div>
      )}
    </div>
  );
}
