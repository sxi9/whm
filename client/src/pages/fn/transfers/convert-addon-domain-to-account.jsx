import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, CapabilityNotice, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ToolingNotice, Warnings, RunPanel, RunHistory, PackageSelect } from '../../transfers/Shared.jsx';

const EMPTY = { username: '', password: '', package: '', contactEmail: '' };

export default function ConvertAddonDomainToAccount({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  // Reassigning a database is the root-only Database Map Tool; the server also leaves the list empty for resellers.
  const canMoveDatabases = user?.role === 'root';
  const { data: caps } = useApi('/transfers/capabilities');
  const { data: addons, loading, error: listError, refetch } = useApi('/transfers/addon-domains');
  const [domain, setDomain] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [options, setOptions] = useState({ copyFiles: true, removeSource: false, moveMail: true, moveDatabases: [] });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const addon = (addons || []).find((a) => a.domain === domain) || null;
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); };
  const body = () => ({ domain, username: form.username.trim(), ...(form.package ? { package: form.package } : {}), ...(form.password ? { password: form.password } : {}), ...(form.contactEmail ? { contactEmail: form.contactEmail.trim() } : {}), options });

  const check = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post('/transfers/convert-addon/preview', body()); setPreview(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const start = async () => {
    const ok = await confirm({
      title: `Convert ${domain} into the account ${form.username}?`,
      message: `${domain} leaves ${addon?.account}${preview?.addon.linkedSubdomains?.length ? ` together with ${preview.addon.linkedSubdomains.join(', ')}` : ''}. ${options.copyFiles ? `The files in ${preview?.addon.docroot} are copied to the new account${options.removeSource ? ' and then deleted from the old one' : ''}.` : 'Files are not copied.'} The DNS zone and mail routing move with the domain.`,
      confirmLabel: 'Convert', danger: options.removeSource, typeToConfirm: options.removeSource ? domain : undefined,
    });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post('/transfers/convert-addon', body());
      toast.success(`Converting ${domain}`);
      setRun(data); setHistoryKey((k) => k + 1);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = () => { setRun(null); setPreview(null); setDomain(''); setForm(EMPTY); refetch(); };

  return (
    <>
      <PageHeader fn={fn} description="Turns an addon domain into a standalone account: a new account is created with the addon domain as its main domain, the document root is copied into its public_html, mailboxes for the domain move along, the DNS zone changes owner and both accounts' virtual hosts are rewritten." />
      {run ? <RunPanel job={run.job} runId={run.run.id} title={`Converting ${domain}`} resetLabel="Convert another addon domain" onReset={reset} /> : (
        <>
          <ToolingNotice caps={caps} needs={options.copyFiles ? ['rsync'] : []} />
          <Card title="Addon domains" padded={false} actions={<Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>}>
            <ErrorBanner error={listError} onRetry={refetch} />
            <DataTable
              columns={[
                { key: 'domain', label: 'Addon domain', render: (a) => <code>{a.domain}</code> },
                { key: 'account', label: 'Account', render: (a) => <code>{a.account}</code> },
                { key: 'mainDomain', label: 'Main domain' },
                { key: 'docroot', label: 'Document root', render: (a) => <code>{a.docroot}</code> },
                { key: 'package', label: 'Package' },
                { key: 'created_at', label: 'Added', render: (a) => formatDate(a.created_at) },
              ]}
              rows={addons || []} loading={loading} rowKey={(a) => a.domain} dense emptyText="No addon domains on this server (or on your accounts)."
              rowActions={(a) => [{ label: domain === a.domain ? 'Selected' : 'Convert', primary: true, disabled: domain === a.domain, onClick: () => { setDomain(a.domain); setPreview(null); setForm((f) => ({ ...f, username: f.username || a.domain.split('.')[0].replace(/[^a-z0-9]/g, '').slice(0, 16) })); } }]}
            />
          </Card>
          {addon && (
            <Card title={`New account for ${addon.domain}`} subtitle={`Currently an addon domain of ${addon.account} (${addon.mainDomain})`}>
              <CapabilityNotice error={error} />
              {error && error.status !== 501 && <ErrorBanner error={error} />}
              <div className="form-grid">
                <Field label="New username" required help="Lowercase letters, digits, _ or -; max 32" error={error?.fields?.username}><TextInput value={form.username} onChange={set('username')} /></Field>
                <Field label="Password" help="Optional; set a login password for the new account" error={error?.fields?.password}><PasswordInput value={form.password} onChange={set('password')} /></Field>
                <Field label="Package" help={`Defaults to ${addon.package || 'the server default'}`}><PackageSelect value={form.package} onChange={set('package')} placeholder={addon.package || 'Server default package'} /></Field>
                <Field label="Contact email" help="Defaults to the current account's contact" error={error?.fields?.contactEmail}><TextInput type="email" value={form.contactEmail} onChange={set('contactEmail')} /></Field>
              </div>
              <div className="form-grid">
                <Toggle checked={options.copyFiles} onChange={(v) => { setOptions((o) => ({ ...o, copyFiles: v, removeSource: v && o.removeSource })); setPreview(null); }} label="Copy the document root" description={`${addon.docroot} → new public_html (rsync)`} />
                <Toggle checked={options.removeSource} disabled={!options.copyFiles} onChange={(v) => { setOptions((o) => ({ ...o, removeSource: v })); setPreview(null); }} label="Delete the files from the old account afterwards" description="Only after a successful copy; refused when the document root is the account's main site or serves another of its domains" />
                <Toggle checked={options.moveMail} onChange={(v) => setOptions((o) => ({ ...o, moveMail: v }))} label="Move mailboxes of the domain" description="mail/<domain> and etc/<domain> are copied to the new home" />
              </div>
              {canMoveDatabases && preview?.addon.databases?.length > 0 && (
                <Field label="Move databases to the new account" help={`Databases of ${addon.account}; moved ones are reassigned, not copied`}>
                  <div className="form-grid">
                    {preview.addon.databases.map((name) => <Toggle key={name} checked={options.moveDatabases.includes(name)} onChange={(v) => setOptions((o) => ({ ...o, moveDatabases: v ? [...o.moveDatabases, name] : o.moveDatabases.filter((n) => n !== name) }))} label={name} />)}
                  </div>
                </Field>
              )}
              <FormActions>
                <Button onClick={check} loading={busy} disabled={!form.username.trim()}>Check</Button>
                <Button variant={options.removeSource ? 'danger' : 'primary'} onClick={start} loading={busy} disabled={!preview?.ok}>Convert to account</Button>
              </FormActions>
            </Card>
          )}
          {preview && (
            <Card title="Plan">
              {preview.issues.length > 0 && <div className="banner banner-error"><div><strong>Cannot convert</strong><ul>{preview.issues.map((i) => <li key={i}>{i}</li>)}</ul></div></div>}
              <Warnings warnings={preview.warnings} />
              <KeyValue items={[
                ['From', <span key="f"><code>{preview.addon.account}</code> · {preview.addon.docroot}</span>],
                ['To', <span key="t"><code>{preview.target.username}</code> · {preview.target.docroot} · package {preview.target.package || 'default'}</span>],
                ['Linked subdomains', preview.addon.linkedSubdomains.length ? preview.addon.linkedSubdomains.join(', ') : 'none'],
                ['DNS zone', preview.addon.zone ? <StatusPill key="z" status="ok">moves to the new account</StatusPill> : <StatusPill key="z" status="info">created for the new account</StatusPill>],
                ['Databases', canMoveDatabases ? (options.moveDatabases.length ? options.moveDatabases.join(', ') : 'none moved') : 'stay with the current account (moving them requires root)'],
              ]} />
            </Card>
          )}
        </>
      )}
      <RunHistory kind="convert_addon" refreshKey={historyKey} />
    </>
  );
}
