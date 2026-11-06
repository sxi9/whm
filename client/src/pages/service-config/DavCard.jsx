import { useState } from 'react';
import { Card, KeyValue, StatusPill, Loading, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../api/client.js';
import { JobCard } from './Shared.jsx';

// What the Calendars (Radicale) card says about GET /service-config/dav.
export function davState(s) {
  if (!s) return null;
  if (!s.installed) return { status: 'not-installed', label: 'Not installed', detail: `Radicale is not installed. Install it here (packages ${(s.packages || []).join(', ')}); the panel then writes its configuration, enables the unit and publishes it as /dav/ under the server hostname.` };
  if (s.unit && s.unit.present === false) return { status: 'warning', label: 'No unit', detail: 'The radicale package is present but no systemd unit was found; run Install again to configure it.' };
  if (!s.config?.managed) return { status: 'pending', label: 'Not configured', detail: 'Radicale is installed but still runs the distribution configuration. Install writes the panel\'s configuration (loopback only, htpasswd with bcrypt, one tree per login) and restarts it.' };
  if (s.unit && s.unit.active === false) return { status: 'failed', label: 'Stopped', detail: 'The radicale unit is not running; check its journal and run Install again.' };
  if (!s.apache) return { status: 'warning', label: 'Apache missing', detail: 'Apache is not installed, so the calendar server cannot be published under the server hostname.' };
  if (!s.fqdn) return { status: 'warning', label: 'No hostname', detail: 'Set a fully qualified server hostname (Basic Setup) so the calendar server has a public address.' };
  if (!s.published?.managed) return { status: 'pending', label: 'Not published', detail: `Radicale ${s.version || ''} is running on ${s.listen?.host}:${s.listen?.port}. Publish it to make https://${s.hostname}/dav/ answer with the hostname certificate.` };
  if (s.modules?.missing?.length) return { status: 'warning', label: 'Apache modules missing', detail: `Published, but Apache does not load ${s.modules.missing.join(', ')}; publish again to enable them (a2enmod).` };
  if (s.http && s.http.ok === false) return { status: 'failed', label: `Published but answering ${s.http.status ?? 'nothing'}`, detail: s.warning || `https://${s.hostname}/dav/ does not answer.` };
  if (s.bcrypt === false) return { status: 'warning', label: 'Published, bcrypt missing', detail: 'Python\'s bcrypt module is missing, so logins fail; install python3-bcrypt and restart radicale.' };
  return { status: 'ok', label: 'Published', detail: null };
}

export function DavCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/service-config/dav');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [jobId, setJobId] = useState(null);
  const state = davState(data);
  const run = async (fn, done) => {
    setBusy(true);
    setActionError(null);
    try { const r = await fn(); toast.success(done(r.data)); if (r.data?.job?.id) setJobId(r.data.job.id); else refetch(); } catch (err) { setActionError(err); toast.error(err); } finally { setBusy(false); }
  };
  const install = () => run(() => api.post('/service-config/dav/install', {}), (d) => `Installing Radicale (job ${d.job?.id ?? '?'})`);
  const publish = () => run(() => api.post('/service-config/dav/publish', {}), (d) => (d.warning ? `Calendar server published at ${d.url} — ${d.warning}` : `Calendar server published at ${d.url}`));
  const unpublish = async () => {
    if (!(await confirm({ title: 'Unpublish the calendar server?', message: `${data?.url || 'The /dav/ URL'} stops answering; Radicale keeps running on loopback and the DAV passwords stay.`, confirmLabel: 'Unpublish', danger: true }))) return;
    return run(() => api.delete('/service-config/dav'), () => 'Calendar server unpublished');
  };
  const canPublish = Boolean(data?.installed && data?.apache && data?.fqdn);
  const pending = (data?.recentJobs || []).some((j) => j.status === 'queued' || j.status === 'running');
  return (
    <Card title="Calendars (Radicale)" subtitle="CalDAV/CardDAV for every account: Radicale from the distribution on 127.0.0.1:5232, htpasswd logins the account panel manages, published as /dav/ under the server hostname site with its certificate"
      actions={data && (
        <div className="action-row">
          {data.published?.managed && <Button variant="danger" disabled={busy} onClick={unpublish}>Unpublish</Button>}
          {data.installed && <Button variant="primary" loading={busy} disabled={!canPublish || pending} onClick={publish}>{data.published?.managed ? 'Publish again' : 'Publish'}</Button>}
          <Button variant={data.installed ? 'default' : 'primary'} loading={busy} disabled={!data.pkgAvailable || pending} onClick={install} title={data.pkgAvailable ? undefined : 'The Software category is not loaded, so packages cannot be installed from here'}>{data.installed ? 'Reconfigure' : 'Install'}</Button>
        </div>
      )}>
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && state && (
        <>
          <KeyValue items={[
            ['Status', <StatusPill key="s" status={state.status}>{state.label}</StatusPill>],
            ['Server', data.installed ? `radicale ${data.version || ''} on ${data.listen?.host}:${data.listen?.port}${data.unit ? ` · unit ${data.unit.name} ${data.unit.active ? 'active' : 'inactive'}` : ''}` : '—'],
            ['Address', data.url ? <a key="u" href={data.url} target="_blank" rel="noopener noreferrer">{data.url}</a> : (data.serverUrl ? `${data.serverUrl} (after publish)` : '—')],
            data.published && ['Apache', <code key="f">{data.published.file}</code>],
            data.http && ['Answers', data.http.status == null ? <StatusPill key="h" status="unknown">not probed: {data.http.error || 'no answer'}</StatusPill> : <StatusPill key="h" status={data.http.ok ? 'ok' : 'failed'}>HTTP {data.http.status}</StatusPill>],
            data.config && ['Configuration', data.config.exists ? (data.config.managed ? `${data.config.path}${data.config.inSync ? '' : ' (differs from the template; Reconfigure rewrites it)'}` : `${data.config.path} (distribution file)`) : 'absent'],
            data.users && ['DAV logins', data.users.exists ? `${data.users.count} in ${data.users.path}` : 'none yet'],
            data.lastApply && ['Last apply', `${formatDate(data.lastApply.at)}${data.lastApply.ok ? '' : ` — failed: ${data.lastApply.error}`}`],
          ]} />
          {state.detail && <p className="muted">{state.detail}</p>}
          {data.installed && data.bcrypt === false && state.status !== 'warning' && <p className="muted">Python's bcrypt module is missing (python3-bcrypt); logins fail until it is installed.</p>}
        </>
      )}
      {jobId && <JobCard jobId={jobId} title="Radicale installation" onFinished={() => { setJobId(null); refetch(); }} />}
      <ErrorBanner error={actionError} />
    </Card>
  );
}
