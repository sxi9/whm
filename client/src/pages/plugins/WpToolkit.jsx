import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, TextInput, Field, Select, PasswordInput, Toggle, FormActions } from '../../components/Form.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { InstallSteps, PluginCapabilityNotice } from './BundledPlugin.jsx';

const when = (v) => (v == null ? '—' : formatDate(new Date(v).toISOString()));

function SiteDetail({ base, site, onClose, onChanged, install }) {
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useApi(`${base}/sites/${site.id}`);
  const harden = useApi(`${base}/sites/${site.id}/harden`);
  const [jobId, setJobId] = useState(null);
  const d = detail.data;
  const insp = d?.inspection;
  const update = useMutation(useCallback(async (kind, name, all) => {
    const what = kind === 'core' ? 'WordPress core' : all ? `all ${kind}s` : `${kind} ${name}`;
    const ok = await confirm({ title: 'Update', message: `Update ${what} on ${site.path} now? WP-CLI runs as ${site.username}; put the site in maintenance mode first if visitors should not see it mid-update.`, confirmLabel: 'Update' });
    if (!ok) return null;
    const res = await api.post(`${base}/sites/${site.id}/update`, { kind, name, all });
    setJobId(res.data.jobId);
    return res.data;
  }, [base, confirm, site]));
  const maintenance = useMutation(useCallback(async (enabled) => {
    await api.post(`${base}/sites/${site.id}/maintenance`, { enabled });
    toast.success(enabled ? 'Maintenance mode on' : 'Maintenance mode off');
    detail.refetch();
    return enabled;
  }, [base, site, toast, detail]));
  const fix = useMutation(useCallback(async (fixes) => {
    const res = await api.post(`${base}/sites/${site.id}/harden`, { fixes });
    toast.success(`Applied: ${res.data.applied.join(', ') || 'nothing'}`);
    harden.refetch();
    return res.data;
  }, [base, site, toast, harden]));
  const fixable = (harden.data?.checks || []).filter((c) => c.ok === false && c.fix).map((c) => c.fix);
  const listColumns = (kind) => [
    { key: 'name', label: 'Name' }, { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status === 'active' ? 'active' : 'inactive'}>{r.status}</StatusPill> }, { key: 'version', label: 'Version' },
    { key: 'update', label: 'Update', render: (r) => (r.update === 'available' ? <Button size="sm" loading={update.loading} onClick={() => update.mutate(kind, r.name, false).catch((e) => toast.error(e))}>Update to {r.update_version}</Button> : <span className="muted">current</span>) },
  ];
  return (
    <Card title={`${site.username} · ${site.relative || site.path}`} subtitle={d?.siteUrl || site.path} actions={<><Button size="sm" onClick={() => { detail.refetch(); harden.refetch(); }}>Re-inspect</Button><Button size="sm" onClick={onClose}>Close</Button></>}>
      {detail.loading && !d && <Loading text="Running WP-CLI…" />}
      <PluginCapabilityNotice error={detail.error} install={install} onRetry={detail.refetch} />
      {d && (
        <>
          <KeyValue items={[
            ['WordPress', insp?.version || site.version], ['Site URL', insp?.siteUrl], ['Core update', insp?.coreUpdates?.length ? `${insp.coreUpdates[0].version} available` : 'current'],
            ['Maintenance mode', insp?.maintenance == null ? 'unknown' : insp.maintenance ? 'on' : 'off'], ['Administrators', insp?.admins?.map((a) => a.user_login).join(', ') || '—'], ['Database', site.dbName], ['Inspected', when(insp?.inspectedAt)],
          ]} />
          {insp?.errors && Object.keys(insp.errors).length > 0 && <div className="banner banner-warning"><div><strong>WP-CLI reported problems</strong><ul>{Object.entries(insp.errors).map(([k, v]) => <li key={k}><code>{k}</code>: {v}</li>)}</ul></div></div>}
          <div className="action-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={!insp?.coreUpdates?.length} loading={update.loading} onClick={() => update.mutate('core', null, false).catch((e) => toast.error(e))}>Update core</Button>
            <Button loading={update.loading} onClick={() => update.mutate('plugin', null, true).catch((e) => toast.error(e))}>Update all plugins</Button>
            <Button loading={update.loading} onClick={() => update.mutate('theme', null, true).catch((e) => toast.error(e))}>Update all themes</Button>
            <Toggle checked={Boolean(insp?.maintenance)} disabled={maintenance.loading} onChange={(v) => maintenance.mutate(v).catch((e) => toast.error(e))} label="Maintenance mode" />
          </div>
          <ErrorBanner error={update.error || maintenance.error} />
          {jobId && <ProgressLog jobId={jobId} onFinished={(ev) => { if (ev.type === 'done') { toast.success('Update finished'); detail.refetch(); onChanged?.(); } else toast.error(ev.error || 'Update failed'); }} />}
          <h3>Plugins</h3>
          <DataTable dense columns={listColumns('plugin')} rows={insp?.plugins || []} rowKey={(r) => r.name} emptyText="No plugins listed" />
          <h3>Themes</h3>
          <DataTable dense columns={listColumns('theme')} rows={insp?.themes || []} rowKey={(r) => r.name} emptyText="No themes listed" />
          <h3>Hardening {harden.data && <span className="muted">({harden.data.score}/{harden.data.total} checks pass)</span>}</h3>
          <PluginCapabilityNotice error={harden.error} install={install} onRetry={harden.refetch} />
          <DataTable dense columns={[
            { key: 'ok', label: 'Result', render: (r) => <StatusPill status={r.ok === true ? 'ok' : r.ok === false ? 'warning' : 'unknown'}>{r.ok === true ? 'pass' : r.ok === false ? 'fix' : 'unknown'}</StatusPill> },
            { key: 'label', label: 'Check' }, { key: 'detail', label: 'Detail', render: (r) => <code>{r.detail}</code> },
            { key: 'fix', label: '', render: (r) => (r.ok === false && r.fix ? <Button size="sm" loading={fix.loading} onClick={() => fix.mutate([r.fix]).catch((e) => toast.error(e))}>Fix</Button> : null) },
          ]} rows={harden.data?.checks || []} loading={harden.loading} rowKey={(r) => r.id} emptyText="No checks" />
          {fixable.length > 1 && <div className="action-row"><Button loading={fix.loading} onClick={() => fix.mutate(fixable).catch((e) => toast.error(e))}>Apply all {fixable.length} fixes</Button></div>}
          <ErrorBanner error={fix.error} />
        </>
      )}
    </Card>
  );
}

function InstallForm({ status, onQueued }) {
  const toast = useToast();
  const accounts = useApi('/bundled-plugins/wp-toolkit/accounts');
  const [v, setV] = useState({ username: '', directory: '', url: '', title: '', adminUser: 'admin', adminEmail: '', adminPassword: '', dbName: 'wp', locale: 'en_US' });
  const set = (k) => (val) => setV((s) => ({ ...s, [k]: val }));
  useEffect(() => { if (!v.username && accounts.data?.length) setV((s) => ({ ...s, username: accounts.data[0].username })); }, [accounts.data, v.username]);
  const submit = useMutation(useCallback(async () => {
    const body = Object.fromEntries(Object.entries(v).filter(([, val]) => val !== ''));
    const res = await api.post('/bundled-plugins/wp-toolkit/install', body);
    toast.success(`WordPress install queued for ${res.data.path}`);
    onQueued?.(res.data);
    return res.data;
  }, [v, toast, onQueued]));
  const account = accounts.data?.find((a) => a.username === v.username);
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit.mutate().catch(() => {}); }}>
      <div className="form-grid">
        <Field label="Account" required htmlFor="wp-account" error={submit.fieldErrors?.username}><Select id="wp-account" value={v.username} onChange={set('username')} options={(accounts.data || []).map((a) => ({ value: a.username, label: `${a.username} (${a.domain})` }))} placeholder="Choose an account" /></Field>
        <Field label="Directory below public_html" help={account ? `${account.home}/public_html/${v.directory || ''}` : 'Leave empty for the document root'} htmlFor="wp-dir" error={submit.fieldErrors?.directory}><TextInput id="wp-dir" value={v.directory} onChange={set('directory')} placeholder="blog" className="input mono" /></Field>
        <Field label="Site URL" help={account ? `Default https://${account.domain}${v.directory ? `/${v.directory}` : ''}` : undefined} htmlFor="wp-url" error={submit.fieldErrors?.url}><TextInput id="wp-url" value={v.url} onChange={set('url')} placeholder="https://" /></Field>
        <Field label="Site title" required htmlFor="wp-title" error={submit.fieldErrors?.title}><TextInput id="wp-title" value={v.title} onChange={set('title')} /></Field>
        <Field label="Admin user" required htmlFor="wp-admin" error={submit.fieldErrors?.adminUser}><TextInput id="wp-admin" value={v.adminUser} onChange={set('adminUser')} /></Field>
        <Field label="Admin email" help="Defaults to the account's contact address" htmlFor="wp-email" error={submit.fieldErrors?.adminEmail}><TextInput id="wp-email" type="email" value={v.adminEmail} onChange={set('adminEmail')} /></Field>
        <Field label="Admin password" required htmlFor="wp-pass" error={submit.fieldErrors?.adminPassword}><PasswordInput id="wp-pass" value={v.adminPassword} onChange={set('adminPassword')} /></Field>
        <Field label="Database name" required help="Prefixed with the account name; a user with the same name is created" htmlFor="wp-db" error={submit.fieldErrors?.dbName}><TextInput id="wp-db" value={v.dbName} onChange={set('dbName')} className="input mono" /></Field>
        <Field label="Locale" htmlFor="wp-locale" error={submit.fieldErrors?.locale}><TextInput id="wp-locale" value={v.locale} onChange={set('locale')} className="input mono" /></Field>
      </div>
      <PluginCapabilityNotice error={submit.error && !submit.fieldErrors ? submit.error : null} install={status?.install} />
      <FormActions><Button type="submit" variant="primary" loading={submit.loading} disabled={!status?.wpcli?.installed}>Install WordPress</Button>{!status?.wpcli?.installed && <span className="muted">Install WP-CLI first.</span>}</FormActions>
    </form>
  );
}

export function WpToolkitOverview({ base }) {
  const toast = useToast();
  const status = useApi(`${base}/status`);
  const sites = useApi(`${base}/sites`);
  const installs = useApi('/bundled-plugins/wp-toolkit/installs');
  const [selected, setSelected] = useState(null);
  const [installJob, setInstallJob] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  const discover = useMutation(useCallback(async () => {
    const res = await api.post(`${base}/discover`, {});
    toast.success(`${res.data.sites} site(s) across ${res.data.accounts} account(s): ${res.data.added} new`);
    sites.refetch();
    status.refetch();
    return res.data;
  }, [base, sites, status, toast]));
  const s = status.data;
  const site = selected && sites.data?.find((x) => x.id === selected);
  return (
    <>
      <Card title="WP-CLI" actions={<><Button size="sm" variant="primary" loading={discover.loading} onClick={() => discover.mutate().catch((e) => toast.error(e))}>Discover sites</Button><Button size="sm" onClick={() => setShowInstall((x) => !x)}>{showInstall ? 'Hide install form' : 'Install WordPress'}</Button></>}>
        {status.loading && !s && <Loading />}
        <ErrorBanner error={status.error} onRetry={status.refetch} />
        {s && (
          <div className="stat-grid">
            <div className="stat"><div className="label">WP-CLI</div><div className="value"><StatusPill status={s.wpcli?.installed ? 'installed' : 'not-installed'}>{s.wpcli?.installed ? `wp ${s.wpcli.version || ''}` : 'not installed'}</StatusPill></div></div>
            <div className="stat"><div className="label">WordPress sites</div><div className="value">{s.sites}</div><div className="muted" style={{ fontSize: 12 }}>{s.lastDiscovery ? `discovered ${when(s.lastDiscovery.at)}` : 'not discovered yet'}</div></div>
            <div className="stat"><div className="label">Core updates pending</div><div className="value">{s.outdated}</div></div>
            <div className="stat"><div className="label">Accounts</div><div className="value">{s.accounts?.length ?? 0}</div></div>
          </div>
        )}
        {s && !s.wpcli?.installed && (
          <div className="banner banner-warning" style={{ marginTop: 14 }}>
            <div>
              <strong>WP-CLI is not installed</strong>
              <p>Sites are still discovered from wp-config.php, but versions, updates, maintenance mode, hardening and one-click installs need WP-CLI. {s.errors?.wpcli}</p>
              <InstallSteps steps={s.install?.steps || []} url={s.install?.url} />
            </div>
          </div>
        )}
        <ErrorBanner error={discover.error} />
      </Card>
      {showInstall && (
        <Card title="Install WordPress" subtitle="Creates the database and database user, checks the virtual host and runs the WP-CLI installer as the account user">
          <InstallForm status={s} onQueued={(r) => { setInstallJob(r.job.id); installs.refetch(); }} />
          {installJob && <ProgressLog jobId={installJob} onFinished={(ev) => { if (ev.type === 'done') { toast.success('WordPress installed'); sites.refetch(); } else toast.error(ev.error || 'Install failed'); installs.refetch(); }} />}
        </Card>
      )}
      {site && <SiteDetail base={base} site={site} install={s?.install} onClose={() => setSelected(null)} onChanged={() => sites.refetch()} />}
      <Card title="WordPress sites" padded={false}>
        <DataTable columns={[
          { key: 'username', label: 'Account' },
          { key: 'relative', label: 'Path', render: (r) => <code>{r.relative || r.path}</code> },
          { key: 'version', label: 'WordPress', render: (r) => r.version || <span className="muted">?</span> },
          { key: 'coreUpdate', label: 'Updates', render: (r) => (r.inspectedAt ? <>{r.coreUpdate ? <StatusPill status="warning">core {r.coreUpdate}</StatusPill> : <StatusPill status="ok">core current</StatusPill>} {r.pluginUpdates ? `${r.pluginUpdates} plugin(s)` : ''} {r.themeUpdates ? `${r.themeUpdates} theme(s)` : ''}</> : <span className="muted">not inspected</span>) },
          { key: 'maintenance', label: 'Maintenance', render: (r) => (r.maintenance == null ? <span className="muted">—</span> : r.maintenance ? <StatusPill status="warning">on</StatusPill> : 'off') },
          { key: 'id', label: '', render: (r) => <Button size="sm" onClick={() => setSelected(r.id)}>Manage</Button> },
        ]} rows={sites.data || []} loading={sites.loading} error={sites.error} rowKey={(r) => r.id} emptyText="No WordPress installation found yet. Click Discover sites." />
      </Card>
      {installs.data?.length > 0 && (
        <Card title="Recent installs" padded={false}>
          <DataTable dense columns={[{ key: 'created_at', label: 'Requested', render: (r) => formatDate(r.created_at) }, { key: 'username', label: 'Account' }, { key: 'url', label: 'URL' }, { key: 'db_name', label: 'Database' }, { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status === 'done' ? 'ok' : r.status} /> }, { key: 'error', label: 'Error', render: (r) => (r.error ? `${r.error}${r.cleanup ? ` (${r.cleanup})` : ''}` : '') }]} rows={installs.data} rowKey={(r) => r.id} />
        </Card>
      )}
    </>
  );
}
