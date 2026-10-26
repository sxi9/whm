import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ShieldAlert, Puzzle } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { usePluginNav } from '../../../hooks/usePluginNav.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle, TextInput, Field, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';

const REQUIRE_SIGNATURE = 'plugins.require_signature';

// In-process plugins share the panel process, so the permission list is a
// record of what a plugin declares and uses, not a boundary the host can
// enforce against hostile code. The same wording ships in the install response
// (warnings: ['in-process']) and the design of record.
export function TrustNotice() {
  return (
    <div className="banner banner-info">
      <ShieldAlert size={18} />
      <div>
        <strong>Plugins run inside the panel process</strong>
        <p>An enabled plugin executes with the panel's own privileges (root in monolithic mode). Declared permissions are checked and recorded for review, but they are not a security boundary against malicious code: install only plugins you trust, and prefer signed packages. Process isolation arrives with the marketplace.</p>
      </div>
    </div>
  );
}

export function SignaturePolicy({ required, onChange, busy }) {
  return (
    <>
      {!required && (
        <div className="banner banner-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Unsigned packages are accepted</strong>
            <p>Any <code>.whmplugin</code> file installs, whether or not a trusted key signed it. Turn on the switch below to refuse unsigned or unverifiable packages (trusted keys live in <code>plugin-keys/</code> under the data directory).</p>
          </div>
        </div>
      )}
      <Toggle checked={Boolean(required)} disabled={busy} onChange={onChange} label="Require signed packages" description="Refuse packages without a valid Ed25519 signature from a trusted key." />
    </>
  );
}

function InstallCard({ onInstalled }) {
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const install = async (send) => {
    setBusy(true);
    setError(null);
    try {
      const res = await send();
      setWarnings(res.data.warnings || []);
      toast.success(`${res.data.plugin.name} ${res.data.plugin.version} installed`);
      setFile(null);
      setPath('');
      onInstalled?.(res.data.plugin);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Install a plugin" subtitle="Upload a .whmplugin package or install one already on this server">
      <div className="form-grid">
        <Field label="Package file" help="A gzip'ed tar with plugin.json and main.js at its root (max 20 MB)." htmlFor="plugin-file">
          <input id="plugin-file" className="input" type="file" accept=".whmplugin,application/gzip" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Field>
        <Field label="Or a package path on this server" help="Under the data directory, /root, /home, /tmp or /opt." htmlFor="plugin-path">
          <TextInput id="plugin-path" value={path} onChange={setPath} placeholder="/root/net.example.hello-1.0.0.whmplugin" className="input mono" />
        </Field>
      </div>
      <div className="action-row">
        <Button variant="primary" loading={busy} disabled={!file && !path.trim()} onClick={() => install(() => (file ? api.postRaw('/plugins/manage/install', file, 'application/gzip') : api.post('/plugins/manage/install', { path: path.trim() })))}>Install</Button>
      </div>
      <ErrorBanner error={error} />
      {warnings.length > 0 && (
        <div className="banner banner-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Installed with warnings</strong>
            <ul>{warnings.map((w) => <li key={w}>{w === 'unsigned' ? 'The package is not signed by a trusted key.' : w === 'in-process' ? 'The plugin runs inside the panel process with its privileges.' : w}</li>)}</ul>
          </div>
        </div>
      )}
    </Card>
  );
}

function PluginDetail({ id, onClose }) {
  const { data, loading, error, refetch } = useApi(`/plugins/manage/${id}`);
  if (loading && !data) return <Card title={id}><Loading /></Card>;
  if (error) return <Card title={id}><ErrorBanner error={error} onRetry={refetch} /></Card>;
  if (!data) return null;
  const sidebar = data.sidebar || [];
  return (
    <Card title={`${data.name} ${data.version}`} subtitle={data.description || id} actions={<><Button onClick={refetch}>Refresh</Button><Button onClick={onClose}>Close</Button></>}>
      <KeyValue items={[
        ['Plugin id', <code key="id">{data.id}</code>],
        ['State', <span key="s"><StatusPill status={data.state} />{data.lastError ? <span className="muted"> {data.lastError.code}: {data.lastError.message}</span> : null}</span>],
        ['Author', data.author ? `${data.author.name || ''}${data.author.email ? ` <${data.author.email}>` : ''}` : '—'],
        ['Package', data.signed ? `signed by ${data.signer}` : 'unsigned'],
        ['Isolation', `${data.isolation} (runs inside the panel process)`],
        ['Host API', `${data.hostVersion}${data.compatible === false ? ' — incompatible' : ''}`],
        ['Installed', `${formatDate(data.installedAt)} from ${data.source}`],
        ['Code / data', <span key="d" className="mono small">{data.dir} · {data.dataDir}</span>],
      ]} />

      <h3>Permissions</h3>
      <p className="muted small">Declared in plugin.json. Checked on every ctx call and recorded below, but an in-process plugin could bypass them: treat the list as a statement of intent from code you trust.</p>
      {data.permissions.length === 0 ? <p className="muted">None declared.</p> : (
        <ul>
          {data.permissions.map((p) => (
            <li key={p}><code>{p}</code>{data.permissionsUsed.includes(p) ? <span className="pill pill-ok" style={{ marginLeft: 8 }}>used</span> : null}</li>
          ))}
        </ul>
      )}
      {data.permissionDenials.length > 0 && (
        <div className="banner banner-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Denied calls</strong>
            <ul>{data.permissionDenials.slice(-10).map((d, i) => <li key={i}><code>{d.method}</code> needed <code>{d.scope}</code> at {formatDate(d.ts)}</li>)}</ul>
            {data.permissionDenialCounts && Object.keys(data.permissionDenialCounts).length > 0 && (
              <p className="muted">Totals: {Object.entries(data.permissionDenialCounts).map(([scope, n]) => `${scope} ×${n}`).join(', ')}</p>
            )}
          </div>
        </div>
      )}
      {data.hookTimeouts?.length > 0 && (
        <div className="banner banner-error">
          <AlertTriangle size={18} />
          <div>
            <strong>Hook handlers timed out</strong>
            <ul>{data.hookTimeouts.slice(-10).map((h, i) => <li key={i}><code>{h.handler}</code> on {h.stage}:{h.event} after {h.timeoutMs} ms at {formatDate(h.ts)}</li>)}</ul>
          </div>
        </div>
      )}

      {sidebar.length > 0 && (
        <>
          <h3>Pages</h3>
          <ul>{sidebar.map((s) => <li key={s.route}>{data.state === 'enabled' ? <Link to={`/plugins/${data.id}${s.route === '/' ? '' : s.route}`}>{s.label}</Link> : s.label} <span className="muted small">({s.category})</span></li>)}</ul>
        </>
      )}

      {data.schedules.length > 0 && (
        <>
          <h3>Schedules</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Job</th><th>Cron</th><th>Source</th><th>Next run</th></tr></thead>
              <tbody>{data.schedules.map((s) => <tr key={s.id}><td>{s.name}</td><td><code>{s.jobName}</code></td><td><code>{s.expr}</code></td><td>{s.source}</td><td>{s.nextRunAt ? formatDate(s.nextRunAt) : '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}

      {data.jobs.length > 0 && (
        <>
          <h3>Recent jobs</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Status</th><th>Trigger</th><th>Started</th><th>Error</th></tr></thead>
              <tbody>{data.jobs.map((j) => <tr key={j.id}><td><code>{j.name}</code> #{j.id}</td><td><StatusPill status={j.status} /></td><td>{j.trigger}</td><td>{j.startedAt ? formatDate(j.startedAt) : '—'}</td><td className="small">{j.error ? `${j.error.code}: ${j.error.message}` : '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}

      <h3>Log</h3>
      {data.logs.length === 0 ? <p className="muted">No log lines yet.</p> : (
        <pre className="log">{data.logs.slice(0, 40).map((l) => `${l.ts} [${l.level}] ${l.msg}${l.fields ? ' ' + JSON.stringify(l.fields) : ''}`).join('\n')}</pre>
      )}
    </Card>
  );
}

export default function ManagePlugins({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const nav = usePluginNav();
  const list = useApi('/plugins/manage');
  const settings = useApi(`/system/settings?prefix=${REQUIRE_SIGNATURE}`);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const required = settings.data?.[REQUIRE_SIGNATURE] === true;

  const refreshAll = () => { list.refetch(); nav.reload(); };
  const act = async (id, label, run) => {
    setBusy(id);
    try { await run(); toast.success(`${label}: ${id}`); refreshAll(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const setRequired = async (value) => {
    if (!value && !(await confirm({ title: 'Accept unsigned plugin packages?', message: 'Anyone with root access to the panel will be able to install packages that no trusted key has verified.', confirmLabel: 'Accept unsigned', danger: true }))) return;
    try { await api.put('/system/settings', { [REQUIRE_SIGNATURE]: value }); toast.success(value ? 'Only signed packages are accepted now' : 'Unsigned packages are accepted'); settings.refetch(); } catch (err) { toast.error(err); }
  };
  const uninstall = async (p, purge) => {
    const ok = await confirm({
      title: purge ? `Uninstall and purge ${p.name}?` : `Uninstall ${p.name}?`,
      message: purge ? 'Removes the plugin code and deletes its settings, stored data, logs and data directory. This cannot be undone.' : 'Removes the plugin code; its settings, stored data and logs are kept for a later re-install.',
      confirmLabel: purge ? 'Uninstall and purge' : 'Uninstall', danger: true,
    });
    if (!ok) return;
    await act(p.id, purge ? 'Uninstalled and purged' : 'Uninstalled', () => api.delete(`/plugins/manage/${p.id}?purge=${purge ? 'true' : 'false'}`));
    if (selected === p.id) setSelected(null);
  };

  const columns = [
    { key: 'name', label: 'Plugin', render: (p) => <><strong>{p.name}</strong> <span className="muted small">{p.version}</span><br /><code className="small">{p.id}</code></> },
    { key: 'state', label: 'State', render: (p) => <><StatusPill status={p.state} />{p.lastError ? <span className="muted small"> {p.lastError.message}</span> : null}</> },
    { key: 'signed', label: 'Package', render: (p) => (p.signed ? <span className="pill pill-ok">signed · {p.signer}</span> : <span className="pill pill-warn">unsigned</span>) },
    { key: 'permissions', label: 'Permissions', render: (p) => <span title={p.permissions.join('\n')}>{p.permissions.length}</span> },
    { key: 'installedAt', label: 'Installed', render: (p) => formatDate(p.installedAt) },
  ];
  const rowActions = (p) => [
    p.state === 'enabled'
      ? { label: 'Disable', primary: true, disabled: busy === p.id, onClick: () => act(p.id, 'Disabled', () => api.post(`/plugins/manage/${p.id}/disable`)) }
      : { label: 'Enable', primary: true, disabled: busy === p.id || p.compatible === false, onClick: () => act(p.id, 'Enabled', () => api.post(`/plugins/manage/${p.id}/enable`)) },
    { label: selected === p.id ? 'Hide details' : 'Details', primary: true, onClick: () => setSelected(selected === p.id ? null : p.id) },
    { label: 'Uninstall (keep data)', danger: true, disabled: busy === p.id, onClick: () => uninstall(p, false) },
    { label: 'Uninstall and purge', danger: true, disabled: busy === p.id, onClick: () => uninstall(p, true) },
  ];

  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={refreshAll}>Refresh</Button>} />
      <TrustNotice />
      <Card title="Signature policy" subtitle="Who may ship code into this panel">
        <ErrorBanner error={settings.error} onRetry={settings.refetch} />
        <SignaturePolicy required={required} busy={!settings.data} onChange={setRequired} />
      </Card>
      <InstallCard onInstalled={refreshAll} />
      <Card title="Installed plugins" padded={false}>
        <DataTable columns={columns} rows={list.data || []} loading={list.loading} error={list.error} rowActions={rowActions} emptyText="No plugins are installed" />
        {!list.loading && !list.error && (list.data || []).length === 0 && (
          <div className="card-body"><EmptyState icon={Puzzle} title="No plugins yet"><p>Install a package above, or scaffold one with the <Link to="/development/cpanel-plugin-file-generator">plugin file generator</Link>.</p></EmptyState></div>
        )}
      </Card>
      {selected && <PluginDetail id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
