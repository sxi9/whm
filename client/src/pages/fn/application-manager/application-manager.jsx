import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw, ExternalLink, Info } from 'lucide-react';
import { queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Select, Button } from '../../../components/Form.jsx';
import { RequestError, useJobRunner, JobPanel } from '../../software/Shared.jsx';
import { CreateAppModal } from '../../apps/AppForm.jsx';
import { AppDetailModal, RemoveAppModal, useAppActions } from '../../apps/AppDetail.jsx';
import { KindBadge, AppStatusPill, CapabilitySummary, runtimeLabel, KIND_LABELS } from '../../apps/Shared.jsx';

const STATUSES = ['created', 'deploying', 'running', 'stopped', 'failed', 'built'];
export const RESELLERS_FORBIDDEN = 'Resellers may not manage applications on this server';

// The server's apps.allow_resellers policy (GET /apps/runtimes → policy) gates
// every mutation for resellers; root is never gated.
export const mayManageApps = (user, runtimes) => user?.role === 'root' || runtimes?.policy?.allowResellers !== false;

export function appRowActions(a, { allowed = true, actions, onOpen, onLogs, onEdit, onRemove } = {}) {
  const process = a.kind !== 'static' && a.unit;
  const running = a.status === 'running';
  const deploying = a.status === 'deploying';
  const view = [
    { label: 'Details', primary: true, onClick: () => onOpen?.(a) },
    { label: 'Open', onClick: () => window.open(a.url, '_blank', 'noopener') },
    { label: 'Logs', onClick: () => onLogs?.(a) },
  ];
  if (!allowed) return view;
  return [
    ...view,
    process && !running && { label: 'Start', onClick: () => actions?.control(a, 'start'), disabled: deploying },
    process && running && { label: 'Stop', onClick: () => actions?.control(a, 'stop'), disabled: deploying },
    process && running && { label: 'Restart', onClick: () => actions?.control(a, 'restart'), disabled: deploying },
    { label: 'Rebuild', onClick: () => actions?.rebuild(a), disabled: deploying },
    a.source?.type === 'git' && { label: 'Deploy (git pull)', onClick: () => actions?.deploy(a), disabled: deploying },
    { label: 'Edit', onClick: () => onEdit?.(a) },
    { label: 'Remove', danger: true, onClick: () => onRemove?.(a), disabled: deploying },
  ].filter(Boolean);
}

export function AppsTable({ rows, loading, error, table, meta, filters, onFilters, onOpen, onLogs, onEdit, onRemove, actions, allowed = true, emptyText }) {
  const columns = [
    { key: 'name', label: 'Application', sortable: true, render: (a) => <><button className="link-button" onClick={() => onOpen?.(a)}><strong>{a.name}</strong></button>{a.preset && <div className="muted small">{a.preset}</div>}</> },
    { key: 'kind', label: 'Kind', sortable: true, render: (a) => <KindBadge kind={a.kind} /> },
    { key: 'username', label: 'Account', sortable: true },
    { key: 'domain', label: 'URL', sortable: true, render: (a) => <a href={a.url} target="_blank" rel="noreferrer noopener" className="small">{a.domain}{a.basePath} <ExternalLink size={12} /></a> },
    { key: 'runtime', label: 'Runtime', render: (a) => runtimeLabel(a) || <span className="muted">—</span> },
    { key: 'status', label: 'Status', sortable: true, render: (a) => <AppStatusPill app={a} live={a.live} /> },
    { key: 'port', label: 'Port', render: (a) => (a.port ? <code className="small">{a.port}</code> : <span className="muted">—</span>) },
  ];
  const rowActions = (a) => appRowActions(a, { allowed, actions, onOpen, onLogs, onEdit, onRemove });
  const toolbar = onFilters && (
    <>
      <Select value={filters?.kind || ''} onChange={(kind) => onFilters({ ...filters, kind })} options={[{ value: '', label: 'All kinds' }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))]} />
      <Select value={filters?.status || ''} onChange={(status) => onFilters({ ...filters, status })} options={[{ value: '', label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s, label: s }))]} />
    </>
  );
  return (
    <DataTable dense columns={columns} rows={rows || []} loading={loading} error={error} rowKey={(a) => a.id} rowActions={rowActions}
      searchable={Boolean(table)} q={table?.state.q} onSearch={table?.setSearch} searchPlaceholder="Filter by name, domain or account" toolbar={toolbar}
      total={meta?.total ?? null} page={table?.state.page} pageSize={table?.state.pageSize} onPageChange={table?.setPage} sort={table?.state.sort} dir={table?.state.dir} onSortChange={table?.setSort}
      emptyText={emptyText || 'No applications yet. Create one to deploy a Node.js, Python or static frontend project on a domain.'} />
  );
}

export default function ApplicationManager({ fn }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const table = useTableState({ pageSize: 25, sort: 'name', dir: 'asc' });
  const [filters, setFilters] = useState({ kind: '', status: '' });
  const apps = useApi(`/apps${queryString({ ...table.state, ...filters })}`, { refreshMs: 30000 });
  const presets = useApi('/apps/presets');
  const runtimes = useApi('/apps/runtimes');
  const runner = useJobRunner({ onFinished: () => { apps.refetch(); runtimes.refetch(); } });
  const actions = useAppActions({ runner, onChanged: () => apps.refetch() });
  const [create, setCreate] = useState(null);
  const [detail, setDetail] = useState(null);
  const [removing, setRemoving] = useState(null);

  useEffect(() => {
    const preset = params.get('preset');
    if (!preset) return;
    setCreate({ preset, username: params.get('username') || '' });
    setParams({}, { replace: true });
  }, [params, setParams]);

  const onCreated = (data) => {
    runner.setJobId(data.job.id);
    apps.refetch();
  };
  const capabilities = runtimes.data?.capabilities;
  const allowed = mayManageApps(user, runtimes.data);
  const canCreate = (!capabilities || (capabilities.apache !== false)) && allowed;

  return (
    <>
      <PageHeader fn={fn} actions={(
        <>
          <Button onClick={() => { apps.refetch(); runtimes.refetch(); }} icon={RefreshCw}>Refresh</Button>
          <Button variant="primary" icon={Plus} onClick={() => setCreate({})} disabled={!canCreate} title={canCreate ? undefined : !allowed ? RESELLERS_FORBIDDEN : 'Apache is not installed'}>Create application</Button>
        </>
      )} />
      <CapabilitySummary capabilities={capabilities} />
      {!allowed && (
        <div className="banner banner-info">
          <Info size={18} />
          <div><strong>{RESELLERS_FORBIDDEN}</strong><p className="muted">The root user turned off "Resellers may manage applications" under Runtime Versions › Policy. You can still open your accounts' applications, their details and logs.</p></div>
        </div>
      )}
      <RequestError error={apps.error} onRetry={apps.refetch} />
      <RequestError error={runtimes.error} onRetry={runtimes.refetch} />
      <Card title="Applications" subtitle={apps.meta ? `${apps.meta.total} application${apps.meta.total === 1 ? '' : 's'} · each runs as its own systemd service bound to 127.0.0.1 and is published through the domain's Apache vhost` : 'Node.js and Python services, and built frontends served by Apache'} padded={false}>
        <AppsTable rows={apps.data} loading={apps.loading} error={null} table={table} meta={apps.meta} filters={filters} onFilters={(f) => { setFilters(f); table.setPage(1); }}
          onOpen={(a) => setDetail({ id: a.id, tab: 'overview' })} onLogs={(a) => setDetail({ id: a.id, tab: 'logs' })} onEdit={(a) => setDetail({ id: a.id, tab: 'settings' })} onRemove={setRemoving} actions={actions} allowed={allowed} />
      </Card>
      <JobPanel runner={runner} title="Deployment" />
      <CreateAppModal open={Boolean(create) && allowed} onClose={() => setCreate(null)} onCreated={onCreated} presets={presets.data} presetsLoading={presets.loading} runtimes={runtimes.data} initialPreset={create?.preset} initialUsername={create?.username} />
      {detail && <AppDetailModal id={detail.id} initialTab={detail.tab} onClose={() => setDetail(null)} onChanged={() => apps.refetch()} runner={runner} runtimes={runtimes.data} readOnly={!allowed} onRemove={(a) => { setDetail(null); setRemoving(a); }} />}
      <RemoveAppModal app={removing} onClose={() => setRemoving(null)} onRemoved={() => apps.refetch()} />
    </>
  );
}
