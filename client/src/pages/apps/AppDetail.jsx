import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Loading, KeyValue, StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Button, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { RequestError, Tabs } from '../security/Shared.jsx';
import { EnvEditor, envToRows, rowsToEnv, envErrors } from './EnvEditor.jsx';
import { StartFields, BuildFields, LimitsFields, RuntimeSelect, cleanStart, cleanBuild, cleanLimits } from './AppForm.jsx';
import { KindBadge, AppStatusPill, runtimeLabel, sourceLabel, startLabel, formatMemory } from './Shared.jsx';

// Start/stop/restart inline, rebuild/deploy as jobs; shared by the table and the drawer.
export function useAppActions({ runner, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);
  const control = useCallback(async (app, verb) => {
    if (verb !== 'start' && !(await confirm({ title: `${verb === 'stop' ? 'Stop' : 'Restart'} ${app.name}?`, message: `${app.unit || `whm-app-${app.id}`} on 127.0.0.1:${app.port} is ${verb === 'stop' ? 'stopped; visitors get a 503 from Apache until it is started again' : 'restarted; requests fail for a few seconds'}.`, confirmLabel: verb === 'stop' ? 'Stop' : 'Restart', danger: verb === 'stop' }))) return null;
    setBusy(`${app.id}:${verb}`);
    try {
      const { data } = await api.post(`/apps/${app.id}/${verb}`);
      toast.success(`${app.name}: ${data.status}${data.live?.pid ? ` (pid ${data.live.pid})` : ''}`);
      onChanged?.(data);
      return data;
    } catch (err) { toast.error(err); return null; } finally { setBusy(null); }
  }, [confirm, toast, onChanged]);
  const rebuild = useCallback((app) => runner.start(() => api.post(`/apps/${app.id}/rebuild`), `Rebuild ${app.name}`), [runner]);
  const deploy = useCallback((app) => runner.start(() => api.post(`/apps/${app.id}/deploy`), `Deploy ${app.name} (git pull)`), [runner]);
  return { control, rebuild, deploy, busy };
}

export function LiveState({ live, app }) {
  if (app?.kind === 'static') return <span className="muted">Served by Apache (no process)</span>;
  if (!live) return <span className="muted">{app?.unit ? 'systemd did not answer' : 'Not deployed yet'}</span>;
  if (live.installed === false) return <StatusPill status="unknown">unit not installed</StatusPill>;
  return (
    <span>
      <StatusPill status={live.active ? 'active' : 'inactive'}>{live.state}{live.subState ? ` (${live.subState})` : ''}</StatusPill>
      {live.pid ? <span className="small muted"> · pid {live.pid}</span> : null}
      {live.memoryBytes != null && <span className="small muted"> · {formatMemory(live.memoryBytes)}</span>}
      {live.restarts ? <span className="small muted"> · {live.restarts} restart{live.restarts === 1 ? '' : 's'}</span> : null}
      {live.startedAt && <span className="small muted"> · since {live.startedAt}</span>}
    </span>
  );
}

export function AppOverview({ app }) {
  const live = app.live;
  return (
    <>
      {app.lastError && <div className="banner banner-error"><div><strong>Last error</strong><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{app.lastError}</p></div></div>}
      <div className="form-grid" style={{ gap: '0 32px' }}>
        <KeyValue items={[
          ['URL', <a key="u" href={app.url} target="_blank" rel="noreferrer noopener">{app.url} <ExternalLink size={12} /></a>],
          ['Account', app.username],
          ['Domain / base path', `${app.domain} ${app.basePath}`],
          ['Root', <code key="r" className="small">{app.root}</code>],
          ['Kind / preset', <span key="k"><KindBadge kind={app.kind} />{app.preset ? <span className="muted small"> · {app.preset}</span> : null}</span>],
          ['Runtime', app.runtime?.kind ? <span key="rt">{runtimeLabel(app)}{app.runtime.bin ? <code className="small" style={{ marginLeft: 6 }}>{app.runtime.bin}</code> : null}</span> : 'none'],
          app.kind !== 'static' && ['Port', app.port ? <code key="p">127.0.0.1:{app.port}</code> : '—'],
          ['Mode', app.mode],
        ]} />
        <KeyValue items={[
          ['Status', <AppStatusPill key="s" app={app} live={live} />],
          ['Process', <LiveState key="l" live={live} app={app} />],
          app.kind !== 'static' && ['Service unit', app.unit ? <code key="un">{app.unit}</code> : 'not written yet'],
          ['Source', sourceLabel(app.source)],
          ['Install / build', `${app.build?.install ? `${app.build.install} install` : 'no install'}${app.build?.script ? ` · npm run ${app.build.script}${app.build.optional ? ' (optional)' : ''}` : ''}${app.kind === 'static' ? ` · serves ${app.build?.resolvedOutputDir || app.build?.outputDir || '.'}` : ''}`],
          app.kind !== 'static' && ['Start', startLabel(app.start, app.kind) || '—'],
          app.kind !== 'static' ? ['Websockets', app.websockets ? 'passed through' : 'off'] : ['SPA fallback', app.spaFallback ? 'index.html' : 'off'],
          app.kind !== 'static' && ['Limits', `${app.limits.memoryMaxMb} MB · ${app.limits.tasksMax} tasks · ${app.limits.cpuQuotaPercent}% CPU`],
          ['Apache include', app.proxyPath ? <code key="pp" className="small">{app.proxyPath}</code> : 'not published yet'],
          ['Last job', app.lastJobId ? <Link key="j" to="/server-status/task-queue-monitor">#{app.lastJobId}</Link> : '—'],
          ['Created / updated', `${formatDate(app.createdAt)} · ${formatDate(app.updatedAt)}`],
        ]} />
      </div>
    </>
  );
}

export function AppLogs({ app }) {
  const [lines, setLines] = useState(200);
  const logs = useApi(`/apps/${app.id}/logs?lines=${lines}`);
  return (
    <>
      <div className="row-actions" style={{ justifyContent: 'flex-start', marginBottom: 10 }}>
        <Select value={String(lines)} onChange={(v) => setLines(Number(v))} options={['100', '200', '500', '1000', '2000'].map((v) => ({ value: v, label: `last ${v} lines` }))} style={{ width: 170 }} />
        <Button size="sm" icon={RefreshCw} onClick={() => logs.refetch()} loading={logs.loading}>Refresh</Button>
        {app.unit && <span className="muted small">journalctl -u {app.unit}</span>}
      </div>
      <RequestError error={logs.error} onRetry={logs.refetch} />
      {logs.loading && !logs.data && <Loading text="Reading the journal…" />}
      {logs.data && (logs.data.note ? <p className="muted">{logs.data.note}</p> : <pre className="log">{logs.data.lines?.length ? logs.data.lines.join('\n') : 'The journal has no lines for this unit yet.'}</pre>)}
    </>
  );
}

export function AppEnv({ app, onSaved }) {
  const toast = useToast();
  const [rows, setRows] = useState(() => envToRows(app.env));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const errors = envErrors(rows);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const { data } = await api.put(`/apps/${app.id}`, { env: rowsToEnv(rows) });
      toast.success(`Environment saved${data.applied?.restarted ? ' and the service restarted' : data.applied?.unit ? ' (unit rewritten)' : ''}`);
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <>
      <EnvEditor rows={rows} onChange={setRows} disabled={saving} />
      <ErrorBanner error={error} />
      <div className="form-actions"><Button variant="primary" onClick={save} loading={saving} disabled={errors.length > 0}>Save environment</Button><Button onClick={() => setRows(envToRows(app.env))} disabled={saving}>Reset</Button></div>
    </>
  );
}

function settingsForm(app) {
  return {
    name: app.name, mode: app.mode, runtimeVersion: app.runtime?.version || 'system',
    start: { mode: app.start?.mode || 'file', entry: app.start?.entry || '', script: app.start?.script || '', module: app.start?.module || '', workers: app.start?.workers || 2 },
    build: { install: app.build?.install || '', script: app.build?.script || '', optional: Boolean(app.build?.optional), outputDir: app.build?.outputDir || '', extraPackages: (app.build?.extraPackages || []).join(' ') },
    websockets: Boolean(app.websockets), spaFallback: Boolean(app.spaFallback),
    limits: { ...app.limits },
  };
}

// Only the sections that changed are sent: a build change flags a rebuild.
export function settingsPayload(app, form) {
  const body = {};
  if (form.name.trim() !== app.name) body.name = form.name.trim();
  if (form.mode !== app.mode) body.mode = form.mode;
  if (app.kind !== 'static' && JSON.stringify(cleanStart(form.start)) !== JSON.stringify(cleanStart(settingsForm(app).start))) body.start = cleanStart(form.start);
  if (JSON.stringify(cleanBuild(form.build, app.kind)) !== JSON.stringify(cleanBuild(settingsForm(app).build, app.kind))) body.build = cleanBuild(form.build, app.kind);
  if (app.runtime?.kind && form.runtimeVersion !== (app.runtime.version || 'system')) body.runtimeVersion = form.runtimeVersion;
  if (app.kind !== 'static' && form.websockets !== Boolean(app.websockets)) body.websockets = form.websockets;
  if (app.kind === 'static' && form.spaFallback !== Boolean(app.spaFallback)) body.spaFallback = form.spaFallback;
  const limits = cleanLimits(form.limits);
  if (app.kind !== 'static' && JSON.stringify(limits) !== JSON.stringify(cleanLimits(app.limits))) body.limits = limits;
  return body;
}

export function AppSettings({ app, runtimes, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(() => settingsForm(app));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const body = settingsPayload(app, form);
  const dirty = Object.keys(body).length > 0;
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const { data } = await api.put(`/apps/${app.id}`, body);
      const a = data.applied || {};
      toast[a.rebuildRequired ? 'warning' : 'success'](a.rebuildRequired ? 'Saved; run Rebuild to apply the build or runtime change' : `Saved${a.restarted ? ', service restarted' : a.unit ? ', unit rewritten' : ''}${a.proxy ? ', Apache include rewritten' : ''}`);
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <>
      <div className="form-grid">
        <Field label="Name"><TextInput value={form.name} onChange={(name) => set({ name })} maxLength={64} /></Field>
        <Field label="Mode"><Select value={form.mode} onChange={(mode) => set({ mode })} options={[{ value: 'production', label: 'production' }, { value: 'development', label: 'development' }]} /></Field>
      </div>
      <p className="muted small">Domain, base path and root are fixed; remove the application and create it again to move it.</p>
      <h3 style={{ margin: '12px 0 8px' }}>Build</h3>
      <BuildFields kind={app.kind} value={form.build} onChange={(build) => set({ build })} />
      {app.kind !== 'static' && (<><h3 style={{ margin: '6px 0 8px' }}>Start</h3><StartFields kind={app.kind} value={form.start} onChange={(start) => set({ start })} /></>)}
      {(app.kind !== 'static' || form.build.install === 'npm') && <RuntimeSelect kind={app.kind} runtimes={runtimes} value={form.runtimeVersion} onChange={(runtimeVersion) => set({ runtimeVersion })} />}
      <div className="field">
        {app.kind !== 'static' && <Toggle checked={form.websockets} onChange={(websockets) => set({ websockets })} label="Websockets" description="Forward Upgrade requests to the application" />}
        {app.kind === 'static' && <Toggle checked={form.spaFallback} onChange={(spaFallback) => set({ spaFallback })} label="SPA fallback" description="Serve index.html for unknown paths" />}
      </div>
      {app.kind !== 'static' && (<><h3 style={{ margin: '6px 0 8px' }}>Limits</h3><LimitsFields value={form.limits} onChange={(limits) => set({ limits })} /></>)}
      <ErrorBanner error={error} />
      <div className="form-actions"><Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save changes</Button><Button onClick={() => setForm(settingsForm(app))} disabled={saving || !dirty}>Reset</Button></div>
    </>
  );
}

const TABS = [{ value: 'overview', label: 'Overview' }, { value: 'logs', label: 'Logs' }, { value: 'env', label: 'Environment' }, { value: 'settings', label: 'Settings' }];

export function AppDetailModal({ id, initialTab = 'overview', onClose, onChanged, runner, runtimes, onRemove }) {
  const detail = useApi(`/apps/${id}`, { refreshMs: 15000 });
  const [tab, setTab] = useState(initialTab);
  const actions = useAppActions({ runner, onChanged: () => { detail.refetch(); onChanged?.(); } });
  const app = detail.data;
  const saved = () => { detail.refetch(); onChanged?.(); };
  const running = app?.status === 'running';
  return (
    <Modal open title={app ? app.name : `Application #${id}`} onClose={onClose} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <RequestError error={detail.error} onRetry={detail.refetch} />
      {detail.loading && !app && <Loading text="Loading the application…" />}
      {app && (
        <>
          <div className="row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <KindBadge kind={app.kind} />
            <AppStatusPill app={app} live={app.live} />
            <a className="small" href={app.url} target="_blank" rel="noreferrer noopener">{app.url} <ExternalLink size={12} /></a>
            <span style={{ flex: 1 }} />
            {app.kind !== 'static' && app.unit && !running && <Button size="sm" onClick={() => actions.control(app, 'start')} loading={actions.busy === `${app.id}:start`}>Start</Button>}
            {app.kind !== 'static' && app.unit && running && <Button size="sm" onClick={() => actions.control(app, 'restart')} loading={actions.busy === `${app.id}:restart`}>Restart</Button>}
            {app.kind !== 'static' && app.unit && running && <Button size="sm" variant="danger" onClick={() => actions.control(app, 'stop')} loading={actions.busy === `${app.id}:stop`}>Stop</Button>}
            <Button size="sm" onClick={() => actions.rebuild(app)} loading={runner?.busy} disabled={app.status === 'deploying'}>Rebuild</Button>
            {app.source?.type === 'git' && <Button size="sm" onClick={() => actions.deploy(app)} loading={runner?.busy} disabled={app.status === 'deploying'}>Deploy (git pull)</Button>}
            {onRemove && <Button size="sm" variant="danger" onClick={() => onRemove(app)}>Remove</Button>}
          </div>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />
          {tab === 'overview' && <AppOverview app={app} />}
          {tab === 'logs' && <AppLogs app={app} />}
          {tab === 'env' && <AppEnv key={app.updatedAt} app={app} onSaved={saved} />}
          {tab === 'settings' && <AppSettings key={app.updatedAt} app={app} runtimes={runtimes} onSaved={saved} />}
        </>
      )}
    </Modal>
  );
}

export function RemoveAppModal({ app, onClose, onRemoved }) {
  const toast = useToast();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!app) return null;
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await api.delete(`/apps/${app.id}?deleteFiles=${deleteFiles ? 'true' : 'false'}`);
      const failed = Object.entries(data.cleanup || {}).filter(([, v]) => v?.error || v?.skipped);
      if (failed.length) toast.warning(`${app.name} removed; ${failed.map(([k, v]) => `${k}: ${v.error || v.skipped}`).join('; ')}`);
      else toast.success(`${app.name} removed`);
      onRemoved?.(data);
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Remove ${app.name}?`} onClose={onClose} size="sm" footer={(
      <>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={remove} loading={busy} disabled={deleteFiles && typed !== app.name}>Remove application</Button>
      </>
    )}>
      <p>The service is stopped and its unit removed, and <code>{app.domain}{app.basePath}</code> is unpublished from Apache. Other applications on the domain stay.</p>
      <div className="field" style={{ marginTop: 12 }}>
        <Toggle checked={deleteFiles} onChange={setDeleteFiles} label="Also delete the application directory" description={app.root} />
      </div>
      {deleteFiles && (
        <label className="field">
          <span className="field-label">Type <code>{app.name}</code> to confirm deleting the files</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
      )}
      <ErrorBanner error={error} />
    </Modal>
  );
}
