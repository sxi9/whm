import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, Puzzle, KeyRound } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { usePluginNav } from '../../../hooks/usePluginNav.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle, TextInput, Field, ErrorBanner, FormActions } from '../../../components/Form.jsx';
import { PluginFields, fieldDefault } from '../../plugins/PluginPage.jsx';
import { describePermission } from '../../cpanel/pluginPermissions.js';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Tabs } from '../../security/Shared.jsx';
import { TrustNotice } from '../../cpanel/ConsentModal.jsx';
import { MarketplaceTab } from '../../cpanel/MarketplaceTab.jsx';

export { TrustNotice };

const REQUIRE_SIGNATURE = 'plugins.require_signature';
const DEVELOPER_MODE = 'plugins.developer_mode';
const SETTINGS_PREFIX = 'plugins.';
export const TABS = [{ value: 'installed', label: 'Installed' }, { value: 'marketplace', label: 'Marketplace' }];

export function sourceLabel(source) {
  if (source === 'marketplace') return 'Marketplace';
  if (source === 'bundled') return 'Bundled';
  return 'Sideloaded';
}

// Sideloading (upload / path installs) while the hub is enabled needs the
// developer-mode switch: without it the host answers 422 unsigned_package for
// anything a marketplace signing key did not sign (§18.6).
export function DeveloperMode({ enabled, marketplaceEnabled, onChange, busy }) {
  return (
    <>
      {enabled && (
        <div className="banner banner-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Developer mode is on</strong>
            <p>Unsigned packages can be sideloaded while the marketplace hub is enabled, and a revoked plugin can be re-enabled without acknowledging the revocation. Turn it off on production servers.</p>
          </div>
        </div>
      )}
      <Toggle checked={Boolean(enabled)} disabled={busy} onChange={onChange} label="Developer mode (sideloading)" description={marketplaceEnabled ? 'Allow unsigned uploads and path installs while the marketplace hub is enabled.' : 'Only matters once the marketplace hub is enabled: sideloads then need this switch.'} />
    </>
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

// The plugin's own settings (manifest `settings`), edited through the manage
// endpoints: GET/PUT /plugins/manage/:id/settings. Password values come back
// masked and stay untouched unless retyped.
function PluginSettingsForm({ id, settings }) {
  const toast = useToast();
  const [values, setValues] = useState(() => Object.fromEntries(settings.fields.map((f) => [f.key, settings.values?.[f.key] ?? fieldDefault(f)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.put(`/plugins/manage/${id}/settings`, values);
      setValues((v) => ({ ...v, ...res.data }));
      toast.success('Plugin settings saved');
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <>
      <h3>Settings</h3>
      <form onSubmit={save}>
        <PluginFields fields={settings.fields} groups={settings.groups || []} values={values} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} errors={error?.fields} />
        <ErrorBanner error={error && !error.fields ? error : null} />
        <FormActions><Button type="submit" variant="primary" loading={saving}>Save settings</Button></FormActions>
      </form>
    </>
  );
}

// Restore tokens let a plugin with backups:restore run a restore the operator
// confirmed: POST /plugins/manage/:id/restore-token → a short-lived token the
// plugin's restore page or route needs.
export function RestoreTokenForm({ id }) {
  const toast = useToast();
  const [artefactId, setArtefactId] = useState('');
  const [account, setAccount] = useState('');
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const issue = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/plugins/manage/${id}/restore-token`, { artefactId: artefactId.trim(), account: account.trim() });
      setIssued(res.data);
      toast.success('Restore token issued');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <>
      <h3>Issue restore token</h3>
      <p className="muted small">A plugin that restores backups needs a token you issue here for one artefact and one account; it expires after a few minutes.</p>
      <form onSubmit={issue}>
        <div className="form-grid">
          <Field label="Backup artefact id" htmlFor={`rt-art-${id}`}><TextInput id={`rt-art-${id}`} value={artefactId} onChange={setArtefactId} placeholder="42" className="input mono" /></Field>
          <Field label="Account" htmlFor={`rt-acct-${id}`}><TextInput id={`rt-acct-${id}`} value={account} onChange={setAccount} placeholder="username" className="input mono" /></Field>
        </div>
        <ErrorBanner error={error} />
        {issued && <div className="banner banner-success"><KeyRound size={18} /><div><strong>Token</strong><p><code>{issued.token}</code></p><small>Expires {formatDate(issued.expiresAt)}</small></div></div>}
        <FormActions><Button type="submit" icon={KeyRound} loading={busy} disabled={!artefactId.trim() || !account.trim()}>Issue restore token</Button></FormActions>
      </form>
    </>
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
        ['Package', `${data.signed ? `signed by ${data.signer}` : 'unsigned'} · ${sourceLabel(data.source)}`],
        ['Isolation', `${data.isolation} (runs inside the panel process)`],
        ['Host API', `${data.hostVersion}${data.compatible === false ? ' — incompatible' : ''}`],
        ['Installed', `${formatDate(data.installedAt)} from ${data.source}`],
        ['Code / data', <span key="d" className="mono small">{data.dir} · {data.dataDir}</span>],
      ]} />

      <h3>Permissions</h3>
      <p className="muted small">Declared in plugin.json. Checked on every ctx call and recorded below, but an in-process plugin could bypass them: treat the list as a statement of intent from code you trust.</p>
      {data.permissions.length === 0 ? <p className="muted">None declared.</p> : (
        <ul className="permission-list">
          {data.permissions.map((p) => {
            const d = describePermission(p);
            return (
              <li key={p}>
                <code>{p}</code>
                {data.permissionsUsed.includes(p) ? <span className="pill pill-ok" style={{ marginLeft: 8 }}>used</span> : null}
                {d.sensitive ? <span className="pill pill-warn" style={{ marginLeft: 8 }}>reaches outside the plugin</span> : null}
                <div className="muted small">{d.text}</div>
              </li>
            );
          })}
        </ul>
      )}

      {data.settings?.fields?.length > 0 && <PluginSettingsForm id={data.id} settings={data.settings} />}
      <RestoreTokenForm id={data.id} />
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
  const location = useLocation();
  const list = useApi('/plugins/manage');
  const settings = useApi(`/system/settings?prefix=${SETTINGS_PREFIX}`);
  const marketplace = useApi('/marketplace/status');
  const [tab, setTab] = useState(() => (location.hash === '#marketplace' ? 'marketplace' : 'installed'));
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const required = settings.data?.[REQUIRE_SIGNATURE] === true;
  const developerMode = settings.data?.[DEVELOPER_MODE] === true;
  useEffect(() => { if (location.hash === '#marketplace') setTab('marketplace'); }, [location.hash]);

  const refreshAll = () => { list.refetch(); nav.reload(); };
  const act = async (id, label, run) => {
    setBusy(id);
    try { await run(); toast.success(`${label}: ${id}`); refreshAll(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const setRequired = async (value) => {
    if (!value && !(await confirm({ title: 'Accept unsigned plugin packages?', message: 'Anyone with root access to the panel will be able to install packages that no trusted key has verified.', confirmLabel: 'Accept unsigned', danger: true }))) return;
    try { await api.put('/system/settings', { [REQUIRE_SIGNATURE]: value }); toast.success(value ? 'Only signed packages are accepted now' : 'Unsigned packages are accepted'); settings.refetch(); } catch (err) { toast.error(err); }
  };
  const setDeveloperMode = async (value) => {
    if (value && !(await confirm({ title: 'Turn developer mode on?', message: 'Unsigned packages can then be sideloaded while the marketplace hub is enabled, and revoked plugins can be re-enabled without acknowledging the revocation.', confirmLabel: 'Turn on', danger: true }))) return;
    try { await api.put('/system/settings', { [DEVELOPER_MODE]: value }); toast.success(value ? 'Developer mode is on' : 'Developer mode is off'); settings.refetch(); marketplace.refetch(); } catch (err) { toast.error(err); }
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
    { key: 'signed', label: 'Package', render: (p) => <>{p.signed ? <span className="pill pill-ok">signed · {p.signer}</span> : <span className="pill pill-warn">unsigned</span>} <span className={`pill ${p.source === 'marketplace' ? 'pill-info' : p.source === 'bundled' ? 'pill-muted' : 'pill-warn'}`}>{sourceLabel(p.source)}</span></> },
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

  const marketplaceEnabled = marketplace.data?.enabled === true;
  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={refreshAll}>Refresh</Button>} />
      <TrustNotice />
      <Tabs tabs={TABS.map((t) => (t.value === 'installed' ? { ...t, count: list.data?.length } : t))} value={tab} onChange={setTab} />
      {tab === 'marketplace' ? <MarketplaceTab manage status={marketplace.data} /> : (
        <>
          <Card title="Signature policy" subtitle="Who may ship code into this panel">
            <ErrorBanner error={settings.error} onRetry={settings.refetch} />
            <SignaturePolicy required={required} busy={!settings.data} onChange={setRequired} />
            <DeveloperMode enabled={developerMode} marketplaceEnabled={marketplaceEnabled} busy={!settings.data} onChange={setDeveloperMode} />
          </Card>
          <InstallCard onInstalled={refreshAll} />
          <Card title="Installed plugins" padded={false}>
            <DataTable columns={columns} rows={list.data || []} loading={list.loading} error={list.error} rowActions={rowActions} emptyText="No plugins are installed" />
            {!list.loading && !list.error && (list.data || []).length === 0 && (
              <div className="card-body"><EmptyState icon={Puzzle} title="No plugins yet"><p>Install a package above, browse the <button className="btn btn-sm btn-ghost" onClick={() => setTab('marketplace')}>Marketplace</button>, or scaffold one with the <Link to="/development/cpanel-plugin-file-generator">plugin file generator</Link>.</p></EmptyState></div>
            )}
          </Card>
          {selected && <PluginDetail id={selected} onClose={() => setSelected(null)} />}
        </>
      )}
    </>
  );
}
