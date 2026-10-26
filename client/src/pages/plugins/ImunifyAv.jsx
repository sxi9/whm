import { useCallback, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, EmptyState, formatDate, formatDuration } from '../../components/Common.jsx';
import { Button, ErrorBanner, TextInput, Field } from '../../components/Form.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { InstallSteps, PluginCapabilityNotice } from './BundledPlugin.jsx';

const when = (v) => (v == null ? '—' : formatDate(typeof v === 'number' ? new Date(v).toISOString() : String(v)));

export function ImunifyAvOverview({ base }) {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useApi(`${base}/status`, { refreshMs: 30_000 });
  const results = useApi(`${base}/results?limit=100`);
  const quarantine = useApi(`${base}/quarantine`);
  const [path, setPath] = useState('/home');
  const [jobId, setJobId] = useState(null);
  const s = status.data;
  const scan = useMutation(useCallback(async (scanner) => {
    const ok = await confirm({ title: 'Start a malware scan', message: scanner === 'clamav' ? 'Scan every account home directory with ClamAV now? This can take a long time on a busy server.' : `Start an ImunifyAV on-demand scan of ${path}?`, confirmLabel: 'Start scan' });
    if (!ok) return null;
    const res = await api.post(`${base}/scan`, scanner === 'clamav' ? { scanner: 'clamav' } : { path });
    if (res.data.jobId) setJobId(res.data.jobId);
    toast.success(res.data.scanner === 'imunifyav' ? 'ImunifyAV scan started' : 'ClamAV scan queued');
    status.refetch();
    return res.data;
  }, [base, confirm, path, status, toast]));
  const clear = useMutation(useCallback(async () => {
    const ok = await confirm({ title: 'Clear findings', message: 'Remove every recorded finding from the plugin store? Files on disk are not touched.', danger: true, confirmLabel: 'Clear' });
    if (!ok) return null;
    await api.delete(`${base}/findings`);
    results.refetch();
    status.refetch();
    return true;
  }, [base, confirm, results, status]));
  const findingColumns = [
    { key: 'detected', label: 'Detected', render: (r) => when(r.detected) },
    { key: 'username', label: 'Account', render: (r) => r.username || <span className="muted">—</span> },
    { key: 'file', label: 'File', render: (r) => <code>{r.file}</code> },
    { key: 'signature', label: 'Signature' },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.quarantined ? 'ok' : r.cleaned ? 'ok' : 'warning'}>{r.quarantined ? 'quarantined' : r.cleaned ? 'cleaned' : r.status || 'found'}</StatusPill> },
  ];
  return (
    <>
      <Card title="Scanner" actions={<Button size="sm" onClick={() => { status.refetch(); results.refetch(); quarantine.refetch(); }}>Refresh</Button>}>
        {status.loading && !s && <Loading />}
        <ErrorBanner error={status.error} onRetry={status.refetch} />
        {s && (
          <div className="stat-grid">
            <div className="stat">
              <div className="label">ImunifyAV</div>
              <div className="value"><StatusPill status={s.imunify?.installed ? 'installed' : 'not-installed'}>{s.imunify?.installed ? `installed ${s.imunify.version || ''}` : 'not installed'}</StatusPill></div>
              {s.imunifyStatus && <div className="muted" style={{ fontSize: 12 }}>on-demand scanner: {s.imunifyStatus.status}{s.imunifyStatus.path ? ` (${s.imunifyStatus.path})` : ''}</div>}
            </div>
            <div className="stat">
              <div className="label">ClamAV fallback</div>
              <div className="value"><StatusPill status={s.clamav?.installed ? 'installed' : 'not-installed'}>{s.clamav?.installed ? `clamscan ${s.clamav.version || ''}` : 'not installed'}</StatusPill></div>
              {s.clamav?.installed && <div className="muted" style={{ fontSize: 12 }}>{s.clamav.signatures ? `${s.clamav.signatures} signatures · ` : ''}database {s.clamav.databaseAgeSec == null ? 'missing (run freshclam)' : `updated ${formatDuration(s.clamav.databaseAgeSec)} ago`}</div>}
            </div>
            <div className="stat">
              <div className="label">Active scanner</div>
              <div className="value">{s.scanner === 'imunifyav' ? 'ImunifyAV' : s.scanner === 'clamav' ? 'ClamAV' : 'none'}</div>
              <div className="muted" style={{ fontSize: 12 }}>{s.lastScan ? `last scan ${when(s.lastScan.at)}${s.lastScan.infected != null ? ` · ${s.lastScan.infected} infected` : ''}` : 'no scan recorded'}</div>
            </div>
            <div className="stat">
              <div className="label">Recorded findings</div>
              <div className="value">{s.findings}</div>
              {s.running && <div className="muted" style={{ fontSize: 12 }}>a ClamAV scan is running</div>}
            </div>
          </div>
        )}
        {s && !s.imunify?.installed && (
          <div className="banner banner-info" style={{ marginTop: 14 }}>
            {s.clamav?.installed ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
            <div>
              <strong>{s.clamav?.installed ? 'ImunifyAV is not installed; ClamAV runs the fallback scans' : 'No malware scanner is installed on this server'}</strong>
              <p>ImunifyAV is a free product of CloudLinux; the panel drives its CLI once it is installed. Until then the plugin can scan account home directories with ClamAV on the schedule in its settings.</p>
              <InstallSteps title="Install ImunifyAV (as root)" steps={s.install?.steps || []} url={s.install?.url} />
              {!s.clamav?.installed && <InstallSteps title="Or install ClamAV for the fallback scan" steps={s.install?.clamav || []} />}
            </div>
          </div>
        )}
        {s && (
          <div style={{ marginTop: 14 }}>
            {s.imunify?.installed && (
              <div className="form-grid">
                <Field label="Directory to scan" htmlFor="imav-path"><TextInput id="imav-path" value={path} onChange={setPath} className="input mono" /></Field>
              </div>
            )}
            <div className="action-row" style={{ display: 'flex', gap: 8 }}>
              {s.imunify?.installed && <Button variant="primary" loading={scan.loading} onClick={() => scan.mutate('imunifyav').catch((e) => toast.error(e))}>Start ImunifyAV scan</Button>}
              <Button variant={s.imunify?.installed ? 'default' : 'primary'} loading={scan.loading} disabled={!s.clamav?.installed} onClick={() => scan.mutate('clamav').catch((e) => toast.error(e))}>Scan all accounts with ClamAV</Button>
            </div>
            <PluginCapabilityNotice error={scan.error} install={s.install} />
            {jobId && <ProgressLog jobId={jobId} onFinished={(ev) => { if (ev.type === 'done') toast.success('ClamAV scan finished'); else toast.error(ev.error || 'Scan failed'); results.refetch(); status.refetch(); }} />}
          </div>
        )}
      </Card>
      <Card title="Malicious files" subtitle={results.data ? `${results.data.total} recorded by ${results.data.scanner === 'imunifyav' ? 'ImunifyAV' : 'ClamAV'}` : undefined} padded={false}
        actions={results.data?.scanner === 'clamav' && results.data.total > 0 ? <Button size="sm" variant="danger" loading={clear.loading} onClick={() => clear.mutate().catch((e) => toast.error(e))}>Clear findings</Button> : null}>
        <DataTable columns={findingColumns} rows={results.data?.items || []} loading={results.loading} error={results.error} rowKey={(r, i) => r.id ?? `${r.file}-${i}`} emptyText="No infected files have been found" />
      </Card>
      <Card title="Quarantine" subtitle={quarantine.data?.note} padded={false}>
        {quarantine.data?.items?.length === 0 && quarantine.data.scanner !== 'imunifyav' ? <div className="card-body"><EmptyState title="Quarantine needs ImunifyAV">ClamAV only reports infected files; clean them up by hand or install ImunifyAV.</EmptyState></div>
          : <DataTable columns={findingColumns} rows={quarantine.data?.items || []} loading={quarantine.loading} error={quarantine.error} rowKey={(r, i) => r.id ?? `${r.file}-${i}`} emptyText="Nothing is quarantined" />}
      </Card>
    </>
  );
}
