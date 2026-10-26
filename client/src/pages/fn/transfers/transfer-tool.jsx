import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice, KeyValue, formatDate, formatBytes } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Textarea, Button, FormActions, ErrorBanner, RadioGroup } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ToolingNotice, Options, Warnings, Totals, Steps, RunPanel, RunHistory, PackageSelect } from '../../transfers/Shared.jsx';

const OPTION_FIELDS = [
  { key: 'skipHome', label: 'Skip home directories', description: 'Create the accounts without copying files (rsync)' },
  { key: 'skipDatabases', label: 'Skip databases', description: 'Do not dump and import MySQL databases and users' },
  { key: 'skipDns', label: 'Skip DNS zones', description: 'Create standard zones instead of importing the source zone files' },
  { key: 'overwrite', label: 'Overwrite existing accounts', description: 'Merge into a local account that already has the same username' },
];
const EMPTY_CONN = { host: '', port: 22, user: 'root', authType: 'key', password: '', privateKey: '' };

function ConnectStep({ caps, onConnected }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: sessions, refetch } = useApi('/transfers/sessions');
  const [form, setForm] = useState(EMPTY_CONN);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { host: form.host.trim(), port: Number(form.port) || 22, user: form.user.trim() || 'root', authType: form.authType };
      if (form.authType === 'password') body.password = form.password; else body.privateKey = form.privateKey;
      const { data } = await api.post('/transfers/sessions', body);
      toast.success(`Connected to ${data.probe?.hostname || data.host}`);
      onConnected(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async (s) => {
    if (!(await confirm({ title: `Forget ${s.user}@${s.host}?`, message: 'The stored credential is deleted. Running transfers keep working.', confirmLabel: 'Forget', danger: true }))) return;
    await api.delete(`/transfers/sessions/${s.id}`);
    refetch();
  };

  return (
    <>
      <ToolingNotice caps={caps} needs={['ssh', 'rsync']} />
      {form.authType === 'password' && <ToolingNotice caps={caps} needs={['sshpass']} />}
      <form onSubmit={connect}>
        <Card title="Connect to the source server" subtitle="Credentials are tested over SSH and kept encrypted for the duration of the transfer session.">
          <CapabilityNotice error={error} />
          {error && error.status !== 501 && <ErrorBanner error={error} />}
          <div className="form-grid">
            <Field label="Remote server" required help="Hostname or IP address"><TextInput value={form.host} onChange={set('host')} placeholder="old-server.example.com" required /></Field>
            <Field label="SSH port"><NumberInput value={form.port} onChange={set('port')} nullable={false} min={1} max={65535} /></Field>
            <Field label="SSH user" help="root is needed to read every account's files and the MySQL credentials"><TextInput value={form.user} onChange={set('user')} /></Field>
          </div>
          <Field label="Authentication">
            <RadioGroup name="authType" value={form.authType} onChange={set('authType')} options={[{ value: 'key', label: 'Private key', description: 'Paste an OpenSSH or PEM private key authorised on the source server' }, { value: 'password', label: 'Password', description: 'Needs sshpass on this server' }]} />
          </Field>
          {form.authType === 'key'
            ? <Field label="Private key" required><Textarea value={form.privateKey} onChange={set('privateKey')} rows={6} mono placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'} /></Field>
            : <Field label="Password" required><TextInput type="password" value={form.password} onChange={set('password')} autoComplete="off" /></Field>}
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.host || (form.authType === 'key' ? !form.privateKey : !form.password)}>Connect and list accounts</Button></FormActions>
        </Card>
      </form>
      {sessions?.length > 0 && (
        <Card title="Open connections" padded={false} subtitle="Connections expire automatically; reuse one to skip entering the credential again.">
          <DataTable
            columns={[
              { key: 'host', label: 'Server', render: (s) => <code>{s.user}@{s.host}:{s.port}</code> },
              { key: 'probe', label: 'Detected', render: (s) => <span className="muted">{s.probe?.os?.name || '—'}{s.probe?.cpanel ? ' · cPanel' : ''}{s.probe?.isRoot === false ? ' · not root' : ''}</span> },
              { key: 'authType', label: 'Auth' },
              { key: 'expiresAt', label: 'Expires', render: (s) => formatDate(s.expiresAt) },
            ]}
            rows={sessions} rowKey={(s) => s.id} dense
            rowActions={(s) => [{ label: 'Use', primary: true, onClick: () => onConnected(s) }, { label: 'Forget', danger: true, onClick: () => remove(s) }]}
          />
        </Card>
      )}
    </>
  );
}

function AccountsStep({ session, caps, onBack, onStarted }) {
  const confirm = useConfirm();
  const [refreshing, setRefreshing] = useState(false);
  const { data, loading, error, refetch } = useApi(`/transfers/sessions/${session.id}/accounts`);
  const [selected, setSelected] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [options, setOptions] = useState({ skipHome: false, skipDatabases: false, skipDns: false, overwrite: false });
  const [preview, setPreview] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const accounts = data?.accounts || [];
  const probe = session.probe || {};
  const setOverride = (username, key) => (v) => { setOverrides((o) => ({ ...o, [username]: { ...(o[username] || {}), [key]: v } })); setPreview(null); };
  const body = () => ({ sessionId: session.id, accounts: selected.map((u) => { const o = overrides[u] || {}; return { source: u, ...(o.username ? { username: o.username.trim() } : {}), ...(o.domain ? { domain: o.domain.trim().toLowerCase() } : {}), ...(o.package ? { package: o.package } : {}) }; }), options });

  const refresh = async () => { setRefreshing(true); try { await api.get(`/transfers/sessions/${session.id}/accounts?refresh=true`); await refetch(); } finally { setRefreshing(false); } };
  const runPreview = async () => {
    setBusy(true); setActionError(null);
    try { const { data: p } = await api.post('/transfers/transfer/preview', body()); setPreview(p); } catch (err) { setActionError(err); } finally { setBusy(false); }
  };
  const start = async () => {
    const ok = await confirm({ title: `Transfer ${selected.length} account(s) from ${session.host}?`, message: `Accounts are created here${options.skipHome ? '' : ', home directories copied with rsync'}${options.skipDatabases ? '' : ', databases dumped and imported'}${options.skipDns ? '' : ', zones imported'}. Sites on the source keep running.`, confirmLabel: 'Start transfer' });
    if (!ok) return;
    setBusy(true); setActionError(null);
    try { const { data: r } = await api.post('/transfers/transfer', body()); onStarted(r); } catch (err) { setActionError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <Card title={`Source: ${session.user}@${session.host}`} actions={<><Button size="sm" variant="ghost" onClick={onBack}>Change server</Button><Button size="sm" onClick={refresh} loading={refreshing}>Re-scan accounts</Button></>}>
        <KeyValue items={[
          ['System', probe.os?.name || probe.hostname || '—'],
          ['Control panel', probe.cpanel ? 'cPanel/WHM detected' : 'none detected (plain Linux users)'],
          ['SSH user', <span key="u">{session.user} {probe.isRoot === false && <StatusPill status="warning">not root</StatusPill>}</span>],
          ['Source tools', <span key="t">rsync {probe.tools?.rsync ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="failed">missing</StatusPill>} · mysqldump {probe.tools?.mysqldump ? <StatusPill status="ok">yes</StatusPill> : <StatusPill status="failed">missing</StatusPill>}</span>],
          probe.homeDisk && ['Source /home', `${formatBytes(probe.homeDisk.usedBytes)} used of ${formatBytes(probe.homeDisk.sizeBytes)}`],
          data?.fetchedAt && ['Account list', `${accounts.length} account(s) · fetched ${formatDate(data.fetchedAt)}`],
        ]} />
      </Card>
      <ToolingNotice caps={caps} needs={options.skipHome ? [] : ['rsync']} />
      <Card title="Select accounts" subtitle={`${selected.length} of ${accounts.length} selected. Override the local username, domain or package per account when needed.`} padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'Source user', render: (a) => <code>{a.username}</code> },
            { key: 'domain', label: 'Main domain', render: (a) => a.domain || <span className="muted">unknown</span> },
            { key: 'domains', label: 'Other domains', render: (a) => (a.domains?.length ? <span className="muted">{a.domains.join(', ')}</span> : '—') },
            { key: 'home', label: 'Home', render: (a) => <code>{a.home}</code> },
            { key: 'localExists', label: 'Here', render: (a) => (a.localExists ? <StatusPill status="warning">exists ({a.localDomain})</StatusPill> : a.domainHostedBy ? <StatusPill status="warning">domain on {a.domainHostedBy}</StatusPill> : <StatusPill status="ok">new</StatusPill>) },
            { key: 'new_username', label: 'Local username', render: (a) => <input className="input" style={{ minWidth: 120 }} value={overrides[a.username]?.username ?? ''} placeholder={a.username} onChange={(e) => setOverride(a.username, 'username')(e.target.value)} disabled={!selected.includes(a.username)} /> },
            { key: 'new_domain', label: 'Domain', render: (a) => <input className="input" style={{ minWidth: 150 }} value={overrides[a.username]?.domain ?? ''} placeholder={a.domain || 'required'} onChange={(e) => setOverride(a.username, 'domain')(e.target.value)} disabled={!selected.includes(a.username)} /> },
            { key: 'package', label: 'Package', render: (a) => <PackageSelect value={overrides[a.username]?.package ?? ''} onChange={setOverride(a.username, 'package')} placeholder="default" /> },
          ]}
          rows={accounts} loading={loading} rowKey={(a) => a.username} selectable selected={selected} onSelectedChange={(s) => { setSelected(s); setPreview(null); }} dense
          toolbar={<><Button size="sm" onClick={() => setSelected(accounts.filter((a) => !a.localExists).map((a) => a.username))}>Select all new</Button><Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button></>}
          emptyText="No hosting accounts found on the source server."
        />
      </Card>
      <Card title="Options">
        <Options value={options} onChange={(o) => { setOptions(o); setPreview(null); }} fields={OPTION_FIELDS} />
        <CapabilityNotice error={actionError} />
        {actionError && actionError.status !== 501 && <ErrorBanner error={actionError} />}
        <FormActions>
          <Button onClick={runPreview} loading={busy} disabled={!selected.length}>Check plan</Button>
          <Button variant="primary" onClick={start} loading={busy} disabled={!preview?.ok}>Start transfer</Button>
        </FormActions>
      </Card>
      {preview && (
        <Card title="Plan" padded={false}>
          <div className="card-body">
            <Totals items={[['Accounts', preview.totals.accounts], ['Ready', preview.totals.ready], ['Blocked', preview.totals.blocked]]} />
            <Warnings warnings={preview.warnings} />
          </div>
          <DataTable
            columns={[
              { key: 'sourceUsername', label: 'Source', render: (i) => <code>{i.sourceUsername}</code> },
              { key: 'username', label: 'Local account', render: (i) => <code>{i.username}</code> },
              { key: 'domain', label: 'Domain' },
              { key: 'package', label: 'Package', render: (i) => i.package || <span className="muted">default</span> },
              { key: 'issues', label: 'Status', render: (i) => (i.issues.length ? <span><StatusPill status="failed">blocked</StatusPill> <span className="muted">{i.issues.join('; ')}</span></span> : <StatusPill status="ok">ready</StatusPill>) },
            ]}
            rows={preview.items} rowKey={(i) => `${i.sourceUsername}-${i.username}`} dense
          />
        </Card>
      )}
    </>
  );
}

export default function TransferTool({ fn }) {
  const { data: caps } = useApi('/transfers/capabilities');
  const [session, setSession] = useState(null);
  const [run, setRun] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const step = run ? 3 : session ? 2 : 1;

  return (
    <>
      <PageHeader fn={fn} description="Moves accounts from another server over SSH: the Linux account is created here, the home directory is copied with rsync, MySQL databases are dumped on the source and imported, and DNS zones, addon domains and mail routing are recreated. Each run is a job you can watch and review." />
      <Steps step={step} labels={['Connect', 'Choose accounts and options', 'Transfer']} />
      {step === 1 && <ConnectStep caps={caps} onConnected={setSession} />}
      {step === 2 && <AccountsStep session={session} caps={caps} onBack={() => setSession(null)} onStarted={(r) => { setRun(r); setHistoryKey((k) => k + 1); }} />}
      {step === 3 && <RunPanel job={run.job} runId={run.run.id} title={`Transferring from ${session.host}`} resetLabel="Transfer more accounts" onReset={() => setRun(null)} />}
      <RunHistory kind="transfer" refreshKey={historyKey} />
    </>
  );
}
