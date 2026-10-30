import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, Loading, CapabilityNotice } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toggle, Button, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useServiceActions } from './ServiceStatus.jsx';

export default function ServiceManager({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const { data, loading, error, refetch, setData } = useApi('/system/services');
  const stack = useApi('/system/stack', { enabled: isRoot });
  const run = useServiceActions(refetch);
  const [jobId, setJobId] = useState(null);
  const [jobTitle, setJobTitle] = useState('');
  const [repair, setRepair] = useState(null);
  const [busy, setBusy] = useState(null);
  const installable = useMemo(() => new Set((stack.data?.components || []).filter((c) => c.service).map((c) => c.service)), [stack.data]);
  // One package installation at a time: a job started from the setup wizard
  // (or Software) is shown here with its log, and the install buttons wait.
  const installing = Boolean(stack.data?.installing);
  const activeJob = stack.data?.activeJob || null;
  useEffect(() => {
    if (activeJob && jobId !== activeJob.id) { setJobTitle(activeJob.type === 'stack.install' ? 'Installation in progress' : `Package job in progress (${activeJob.type})`); setJobId(activeJob.id); }
  }, [activeJob?.id]);

  const configure = async (s, patch) => {
    setData((rows) => rows.map((r) => (r.name === s.name ? { ...r, ...patch } : r)));
    try { await api.patch(`/system/services/${s.name}`, patch); } catch (err) { toast.error(err); refetch(); }
  };
  const unit = async (s, enable) => {
    try { await api.post(`/system/services/${s.name}/${enable ? 'enable' : 'disable'}`); toast.success(`${s.displayName} ${enable ? 'enabled' : 'disabled'} at boot`); refetch(); } catch (err) { toast.error(err); }
  };
  const startJob = async (title, request) => {
    setBusy(title);
    try { const { data: d } = await request(); setJobTitle(title); setJobId(d.job.id); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const installService = (s) => startJob(`Installing ${s.displayName}`, () => api.post(`/system/services/${s.name}/install`));
  const repairService = async (s) => {
    setBusy(s.name);
    try {
      const { data: d } = await api.post(`/system/services/${s.name}/repair`);
      setRepair(d);
      if (d.repaired) toast.success(`${s.displayName} is running again`); else toast.warning(`${s.displayName} is still ${d.status?.state || 'down'}; see the journal below`);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const finished = () => { refetch(); stack.refetch(); };

  return (
    <>
      <PageHeader fn={fn} description="Install the services a hosting server needs, repair the ones that stopped, and choose which start at boot and which the panel monitors and restarts automatically when they fail." />
      {isRoot && <StackCard stack={stack} busy={busy} onInstall={(title, body) => startJob(title, () => api.post('/system/stack/install', body))} />}
      {jobId && <Card title={jobTitle || 'Installation'}><ProgressLog jobId={jobId} onFinished={finished} /></Card>}
      {repair && <RepairResult result={repair} onClose={() => setRepair(null)} />}
      <Card padded={false} title="Services">
        <DataTable
          columns={[
            { key: 'displayName', label: 'Service', render: (s) => <><div>{s.displayName}</div><small className="muted">{s.unit ? <code>{s.unit}</code> : `looks for: ${s.candidates.join(', ')}`}</small></> },
            { key: 'state', label: 'Status', render: (s) => <StatusPill status={s.active ? 'active' : s.installed ? 'down' : 'not-installed'}>{s.active ? 'Up' : s.installed ? (s.state === 'failed' ? 'Failed' : 'Down') : 'Not installed'}</StatusPill> },
            { key: 'unitEnabled', label: 'Start at boot', render: (s) => <Toggle checked={Boolean(s.unitEnabled)} disabled={!s.installed} onChange={(v) => unit(s, v)} /> },
            { key: 'monitored', label: 'Monitor', render: (s) => <Toggle checked={s.monitored} onChange={(v) => configure(s, { monitored: v })} /> },
            { key: 'restartOnFailure', label: 'Auto-restart', render: (s) => <Toggle checked={s.restartOnFailure} onChange={(v) => configure(s, { restartOnFailure: v })} /> },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(s) => s.name}
          rowActions={(s) => {
            if (!isRoot) return [];
            if (!s.installed) return installable.has(s.name) ? [{ label: 'Install', primary: true, disabled: Boolean(busy) || installing || !stack.data?.pkgAvailable, onClick: () => installService(s) }] : [];
            if (!s.active) return [{ label: 'Start', primary: true, onClick: () => run(s, 'start') }, { label: 'Repair', primary: true, disabled: busy === s.name, onClick: () => repairService(s) }, { label: 'Restart', onClick: () => run(s, 'restart') }];
            return [{ label: 'Restart', primary: true, onClick: () => run(s, 'restart') }, { label: 'Stop', danger: true, onClick: () => run(s, 'stop') }];
          }}
        />
      </Card>
    </>
  );
}

export function StackCard({ stack, busy, onInstall }) {
  const [selected, setSelected] = useState([]);
  const d = stack.data;
  const components = d?.components || [];
  const installed = components.filter((c) => c.installed);
  const missing = components.filter((c) => !c.installed);
  const toggle = (key, on) => setSelected((s) => (on ? [...new Set([...s, key])] : s.filter((k) => k !== key)));
  const profile = (key) => d?.profiles?.find((p) => p.key === key) ?? null;
  const missingIn = (p) => (p ? p.components.filter((k) => missing.some((c) => c.key === k)) : []);
  const full = profile('full'); const web = profile('web');
  const active = d?.activeJob || null;
  const canInstall = Boolean(d?.pkgAvailable) && !busy && !active;
  return (
    <Card title="Server stack" subtitle={d ? `${installed.length} of ${components.length} components installed · package manager: ${d.packageManager || 'none detected'}` : undefined}
      actions={d && (
        <div className="row-actions" style={{ flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm" disabled={!canInstall || !missingIn(full).length} loading={busy === full?.label} onClick={() => onInstall(full.label, { profile: 'full' })} title={full?.description}>Install full hosting stack (recommended)</Button>
          <Button size="sm" disabled={!canInstall || !missingIn(web).length} loading={busy === web?.label} onClick={() => onInstall(web.label, { profile: 'web' })} title={web?.description}>Web + database only</Button>
        </div>
      )}>
      {stack.loading && !d && <Loading />}
      {stack.error && <ErrorBanner error={stack.error} onRetry={stack.refetch} />}
      {d && !d.pkgAvailable && <CapabilityNotice error={{ code: 'capability_missing', message: 'No supported package manager (apt-get, dnf or yum) was found on this server, so the panel cannot install software here. Install the services by hand; detection picks them up on the next refresh.' }} onRetry={stack.refetch} />}
      {active && <p className="banner banner-info stack-installing" role="status">An installation is already running (job #{active.id}, {active.type}, {active.status}{active.message ? `: ${active.message}` : ''}); the install buttons return once it finishes.</p>}
      {d && (
        <div className="form-grid">
          <section>
            <h4 style={{ margin: '0 0 8px' }}>Missing <span className="pill pill-muted">{missing.length}</span></h4>
            {missing.length === 0 && <p className="muted">Everything in the catalog is installed.</p>}
            <ul className="stack-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {missing.map((c) => (
                <li key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
                  <input type="checkbox" id={`stack-${c.key}`} checked={selected.includes(c.key)} onChange={(e) => toggle(c.key, e.target.checked)} disabled={!d.pkgAvailable} />
                  <label htmlFor={`stack-${c.key}`} style={{ flex: 1 }}>
                    <strong>{c.label}</strong>{c.recommended && <span className="pill pill-info" style={{ marginLeft: 6 }}>recommended</span>}
                    <div className="muted" style={{ fontSize: 12 }}>{c.description}{c.packages?.length ? <> · packages: {c.packages.map((p) => <code key={p} style={{ marginRight: 4 }}>{p}</code>)}</> : null}{c.requires && <div className="field-message">{c.requires}</div>}</div>
                  </label>
                </li>
              ))}
            </ul>
            {missing.length > 0 && (
              <div className="form-actions">
                <Button variant="primary" size="sm" disabled={!canInstall || !selected.length} loading={busy === 'Installing selected components'} onClick={() => onInstall('Installing selected components', { components: selected })}>Install selected ({selected.length})</Button>
                <Button size="sm" disabled={!missing.length} onClick={() => setSelected(missing.map((c) => c.key))}>Select all</Button>
                <Button size="sm" disabled={!selected.length} onClick={() => setSelected([])}>Clear</Button>
              </div>
            )}
          </section>
          <section>
            <h4 style={{ margin: '0 0 8px' }}>Installed <span className="pill pill-muted">{installed.length}</span></h4>
            {installed.length === 0 && <p className="muted">Nothing from the catalog is installed yet.</p>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {installed.map((c) => (
                <li key={c.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
                  <StatusPill status={c.active === false ? 'down' : 'installed'}>{c.active === true ? 'running' : c.active === false ? (c.state || 'down') : 'installed'}</StatusPill>
                  <span style={{ flex: 1 }}>{c.label}{c.unit && <small className="muted"> · <code>{c.unit}</code></small>}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Card>
  );
}

export function RepairResult({ result, onClose }) {
  return (
    <Card title={`Repair: ${result.displayName || result.name}`} actions={<button className="btn btn-sm" onClick={onClose}>Close</button>}>
      <p>
        <StatusPill status={result.repaired ? 'active' : 'down'}>{result.repaired ? 'running' : result.status?.state || 'down'}</StatusPill>{' '}
        <code>{result.unit}</code> · {result.steps.map((s) => `${s.step}: ${s.ok ? 'ok' : s.error || 'failed'}`).join(' → ')}
      </p>
      <pre className="log">{(result.journal || []).join('\n') || 'no journal output'}</pre>
    </Card>
  );
}
