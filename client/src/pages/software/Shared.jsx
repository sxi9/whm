import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, KeyValue, Loading, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

import { RequestError, Tabs, isCapabilityError } from '../security/Shared.jsx';

export { RequestError, Tabs, isCapabilityError };
export { InstallPackages, installPackagesBody, normalizePackages } from '../../components/InstallPackages.jsx';

export function runtimeInstallBody(runtime, version) {
  return version == null || version === '' ? { runtime } : { runtime, version: String(version) };
}

export function toolInstallBody(tool) {
  return { tool };
}

const RUNTIME_SUBTITLES = {
  php: 'Each version installs side by side with PHP-FPM and the common extensions; the CLI default stays as it is.',
  nodejs: 'Official nodejs.org builds under /opt/keel/node/<major>; the panel\'s own Node is never touched.',
  python: 'Interpreter, venv and headers for the version; the distro\'s python3 stays the default.',
};

// The catalog's row label already carries the runtime name ('PHP 8.4'); only fall back to composing one.
const rowLabel = (runtime, row) => row.label || `${runtime.label} ${row.id}`;

function RuntimeRow({ runtime, row, busy, onInstall, onRemove }) {
  const isNode = runtime.key === 'nodejs';
  return (
    <tr>
      <td><strong>{runtime.single ? runtime.label : rowLabel(runtime, row)}</strong>{isNode && <><br /><code className="small">/usr/local/bin/node{row.id}</code></>}</td>
      <td>{row.installed ? <StatusPill status="installed">{row.version ? `installed · ${row.version}` : 'installed'}</StatusPill> : <StatusPill status="not-installed">not installed</StatusPill>}</td>
      <td className="muted small">{row.note || (row.packages?.length ? <CodeList names={row.packages.slice(0, 4).concat(row.packages.length > 4 ? [`+${row.packages.length - 4} more`] : [])} /> : '—')}</td>
      <td className="actions-col">
        {!row.installed && <Button size="sm" variant="primary" loading={busy} onClick={() => onInstall(runtime, row)}>Install</Button>}
        {row.installed && !isNode && <StatusPill status="installed">Installed</StatusPill>}
        {row.installed && isNode && <Button size="sm" variant="danger" loading={busy} onClick={() => onRemove(runtime, row)}>Remove</Button>}
      </td>
    </tr>
  );
}

// Curated one-click installs for PHP, Node.js, Python and common tools; the
// raw package search stays available for everything else.
export function RuntimeInstaller({ only, title, subtitle, onFinished, tools }) {
  const confirm = useConfirm();
  const catalog = useApi('/software/runtimes');
  const runner = useJobRunner({ onFinished: (event) => { catalog.refetch(); onFinished?.(event); } });
  const data = catalog.data;
  const runtimes = (data?.runtimes || []).filter((r) => !only || only.includes(r.key));
  const showTools = tools == null ? !only : Boolean(tools);
  const cardTitle = (runtime) => (title && only?.length === 1 ? title : runtime.label);

  const install = (runtime, row) => runner.start(() => api.post('/software/runtimes/install', runtimeInstallBody(runtime.key, runtime.single ? undefined : row.id)), `Install ${runtime.single ? runtime.label : rowLabel(runtime, row)}`);
  const remove = async (runtime, row) => {
    if (!(await confirm({ title: `Remove ${rowLabel(runtime, row)}?`, message: `Deletes /opt/keel/node/${row.id} and the node${row.id}, npm${row.id} and npx${row.id} links in /usr/local/bin. Sites started with this Node stop working until it is installed again.`, confirmLabel: 'Remove', danger: true }))) return;
    runner.start(() => api.post('/software/runtimes/remove', runtimeInstallBody(runtime.key, row.id)), `Remove ${rowLabel(runtime, row)}`);
  };
  const installTool = (tool) => runner.start(() => api.post('/software/runtimes/install', toolInstallBody(tool.key)), `Install ${tool.label}`);

  return (
    <>
      <RequestError error={catalog.error} onRetry={catalog.refetch} />
      {catalog.loading && !data && <Loading text="Detecting installed runtimes…" />}
      {data && runtimes.map((runtime) => (
        <Card key={runtime.key} title={cardTitle(runtime)} subtitle={subtitle || RUNTIME_SUBTITLES[runtime.key]} padded={false}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Version</th><th>State</th><th>Packages / note</th><th /></tr></thead>
              <tbody>
                {runtime.versions.map((row) => <RuntimeRow key={row.id} runtime={runtime} row={row} busy={runner.busy} onInstall={install} onRemove={remove} />)}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {data && showTools && data.tools?.length > 0 && (
        <Card title="Tools" subtitle={`Common server tools as ${data.manager === 'apt' ? 'APT' : 'DNF'} packages for this ${data.family === 'rhel' ? 'RHEL-family' : 'Debian-family'} host.`}>
          <div className="stat-grid runtime-tools">
            {data.tools.map((tool) => (
              <div className="stat" key={tool.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="label">{tool.label}</div>
                <div className="small"><CodeList names={tool.packages} /></div>
                <div>{tool.installed ? <StatusPill status="installed">Installed</StatusPill> : <Button size="sm" variant="primary" loading={runner.busy} onClick={() => installTool(tool)}>Install</Button>}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <ErrorBanner error={runner.error} />
      <JobPanel runner={runner} title="Install progress" />
    </>
  );
}

// Starts a background job from an API call and shows its live log until it
// finishes; the caller is told when it did so lists can refresh.
export function useJobRunner({ onFinished } = {}) {
  const toast = useToast();
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = useCallback(async (fn, label = 'Job') => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await fn();
      setJobId(data.job.id);
      toast.info(`${label} queued (job #${data.job.id})`);
      return data;
    } catch (err) {
      setError(err);
      toast.error(err);
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  const finished = useCallback((event) => {
    setBusy(false);
    onFinished?.(event);
  }, [onFinished]);
  return { jobId, busy, error, start, setJobId, finished };
}

export function JobPanel({ runner, title = 'Progress' }) {
  if (!runner.jobId) return null;
  return (
    <Card title={title} subtitle={`Job #${runner.jobId} · also visible under Server Status › Task Queue Monitor`}>
      <ProgressLog jobId={runner.jobId} onFinished={runner.finished} />
    </Card>
  );
}

// Which package manager this host uses; most Software pages show it in the header.
export function ManagerBadge({ detect }) {
  if (!detect) return null;
  if (!detect.manager) return <StatusPill status="not-installed">no package manager</StatusPill>;
  return <StatusPill status="ok">{detect.manager === 'apt' ? 'APT (Debian/Ubuntu)' : `${detect.manager.toUpperCase()} (RHEL family)`}</StatusPill>;
}

export function RebootBanner({ required }) {
  if (!required) return null;
  return (
    <div className="banner banner-warning">
      <AlertTriangle size={18} />
      <div>
        <strong>Reboot required</strong>
        <p>The kernel or a core library was updated. Schedule a <Link to="/system-reboot/graceful-server-reboot">graceful reboot</Link> to finish applying it.</p>
      </div>
    </div>
  );
}

// Wrapping list of package or file names; a name never breaks across lines.
export function CodeList({ names }) {
  if (!names?.length) return null;
  return (
    <span className="code-list" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, verticalAlign: 'middle' }}>
      {names.map((n) => <code key={n} style={{ whiteSpace: 'nowrap' }}>{n}</code>)}
    </span>
  );
}

// Left-aligned, labelled package list for rows too long for a KeyValue value.
export function CodeListRow({ label, names }) {
  if (!names?.length) return null;
  return <Field label={label}><CodeList names={names} /></Field>;
}

export function countPackages(n) {
  return `${n} package${n === 1 ? '' : 's'}`;
}

export function PhpVersionPill({ version, inherited }) {
  if (!version) return <span className="muted">—</span>;
  return <StatusPill status={inherited ? 'inactive' : 'ok'}>{version}{inherited ? ' (inherited)' : ''}</StatusPill>;
}

// Renders the recent jobs of some type(s) as a compact history table.
export function JobHistory({ jobs, emptyText = 'No runs yet; each run appears here with its status and log', onSelect }) {
  if (!jobs?.length) return <p className="muted">{emptyText}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Started</th><th>Message</th>{onSelect && <th />}</tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>#{j.id}</td>
              <td><code>{j.type}</code></td>
              <td><StatusPill status={j.status} /></td>
              <td>{formatDate(j.started_at || j.created_at)}</td>
              <td className="muted">{j.error || j.message || (j.result ? summarizeResult(j.result) : '—')}</td>
              {onSelect && <td className="actions-col"><Button size="sm" onClick={() => onSelect(j.id)}>Log</Button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '—');
  if (Array.isArray(result.packages)) return `${result.packages.length} package(s)`;
  if (result.upgraded != null) return `${result.upgraded} upgraded${result.rebootRequired ? ', reboot required' : ''}`;
  if (result.installed && Array.isArray(result.installed)) return `${result.installed.length} installed, ${result.removed?.length ?? 0} removed`;
  return 'done';
}

// One installer card: list of what is installed + an install form that queues a job.
export function InstallerCard({ title, subtitle, kind, listPath, installPath, nameLabel = 'Name', namePlaceholder, allowVersion = true, present, installHint, runner, disabledReason }) {
  const { data, loading, error, refetch } = useApi(listPath, { enabled: Boolean(present) });
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [q, setQ] = useState('');
  const items = (data?.items || []).filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));
  const install = () => runner.start(() => api.post(installPath, { name: name.trim(), ...(allowVersion && version.trim() ? { version: version.trim() } : {}) }), `${title}: install ${name.trim()}`).then((d) => { if (d) { setName(''); setVersion(''); } });

  return (
    <Card title={title} subtitle={subtitle} actions={<StatusPill status={present ? 'installed' : 'not-installed'}>{present ? 'available' : 'not installed'}</StatusPill>}>
      {!present && <p className="muted">{disabledReason || installHint}</p>}
      {present && (
        <>
          <div className="form-grid">
            <Field label={nameLabel}><TextInput value={name} onChange={setName} placeholder={namePlaceholder} /></Field>
            {allowVersion && <Field label="Version (optional)"><TextInput value={version} onChange={setVersion} placeholder="latest" /></Field>}
          </div>
          <div className="action-row"><Button variant="primary" loading={runner.busy} disabled={!name.trim()} onClick={install}>Install with {kind}</Button> <Button onClick={() => refetch()}>Refresh list</Button></div>
          <ErrorBanner error={error} onRetry={refetch} />
          {loading && !data && <p className="muted">Loading installed {kind} items…</p>}
          {data && (
            <>
              <TextInput placeholder={`Filter ${items.length ? `${data.items.length} installed` : 'installed'}…`} value={q} onChange={setQ} style={{ marginBottom: 8 }} />
              <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                <table>
                  <thead><tr><th>Name</th><th>Version</th></tr></thead>
                  <tbody>
                    {items.length === 0 && <tr><td colSpan={2} className="table-state">{q ? 'Nothing installed matches the filter' : `Nothing installed yet; items installed with ${kind} appear here`}</td></tr>}
                    {items.slice(0, 500).map((i) => <tr key={i.name}><td><code>{i.name}</code></td><td>{i.version || i.state || '—'}</td></tr>)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}

export function SettingsSummary({ items }) {
  return <KeyValue items={items} />;
}
