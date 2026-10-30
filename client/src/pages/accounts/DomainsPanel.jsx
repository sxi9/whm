import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, Loading, KeyValue } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button, ErrorBanner } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

export const DOMAIN_TYPES = [
  { value: 'addon', label: 'Addon domain', description: 'A separate website in its own directory under public_html' },
  { value: 'sub', label: 'Subdomain', description: 'A name under one of the account\'s domains, in its own directory' },
  { value: 'parked', label: 'Parked (alias) domain', description: 'Another name for the main website, same files' },
];
const TYPE_LABEL = { main: 'Main domain', addon: 'Addon', sub: 'Subdomain', parked: 'Parked', alias: 'Alias' };
const STEP_STATUS = { applied: 'ok', pending: 'pending', skipped: 'inactive', failed: 'failed' };
const STEP_LABEL = { docroot: 'Document root', web: 'Virtual host', dns: 'DNS', mail: 'Mail routing', ssl: 'AutoSSL', files: 'Files' };

export const domainTypeLabel = (type) => TYPE_LABEL[type] || type;

// A domain's default document root, as the server computes it (shown as the
// placeholder of the optional docroot field).
export function defaultDocroot(home, domain, type, parents = []) {
  if (!domain) return `${home}/public_html/…`;
  if (type === 'parked') return `${home}/public_html`;
  if (type === 'sub') {
    const parent = parents.filter((p) => domain.endsWith(`.${p}`)).sort((a, b) => b.length - a.length)[0];
    return `${home}/public_html/${parent ? domain.slice(0, -(parent.length + 1)) : domain}`;
  }
  return `${home}/public_html/${domain}`;
}

export function SslCell({ ssl }) {
  if (!ssl) return <span className="muted">none</span>;
  const status = ssl.expired ? 'failed' : ssl.daysRemaining != null && ssl.daysRemaining <= 30 ? 'warning' : ssl.state === 'pending' ? 'pending' : 'ok';
  const text = ssl.expired ? 'expired' : ssl.state === 'pending' ? 'pending' : ssl.daysRemaining != null ? `${ssl.daysRemaining}d` : 'installed';
  return <StatusPill status={status}>{`${text}${ssl.autossl ? ' · AutoSSL' : ssl.selfSigned ? ' · self-signed' : ''}`}</StatusPill>;
}

// The outcome of an add/remove, one line per provisioning step.
export function DomainSteps({ steps }) {
  if (!steps) return null;
  return (
    <KeyValue items={Object.entries(steps).map(([key, s]) => [STEP_LABEL[key] || key, <span key={key} style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}><StatusPill status={STEP_STATUS[s.status] || 'unknown'}>{s.status}</StatusPill><span className="small">{s.detail}</span></span>])} />
  );
}

export function DomainsPanel({ username }) {
  const toast = useToast();
  const path = username ? `/account-functions/domains/${encodeURIComponent(username)}` : null;
  const { data, loading, error, refetch } = useApi(path, { enabled: Boolean(username) });
  const [form, setForm] = useState({ domain: '', type: 'addon', docroot: '', autossl: true });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [result, setResult] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!username) return null;

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const parents = (data?.domains || []).filter((d) => d.type !== 'parked' && d.type !== 'alias').map((d) => d.domain);
  const limitText = (l) => (l ? `${l.used}${l.max == null ? '' : ` of ${l.max}`}` : '—');
  const atLimit = (key) => { const l = data?.limits?.[key]; return Boolean(l && l.max != null && l.used >= l.max); };

  const add = async (e) => {
    e.preventDefault();
    setAdding(true);
    setAddError(null);
    setResult(null);
    try {
      const body = { domain: form.domain.trim().toLowerCase(), type: form.type };
      if (form.type !== 'parked') { if (form.docroot.trim()) body.docroot = form.docroot.trim(); body.autossl = form.autossl; }
      const { data: added } = await api.post(path, body);
      setResult(added);
      toast.success(`${added.domain} added to ${username}`);
      setForm({ domain: '', type: form.type, docroot: '', autossl: true });
      refetch();
    } catch (err) { setAddError(err); toast.error(err); } finally { setAdding(false); }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const { data: gone } = await api.delete(`${path}/${encodeURIComponent(removing.domain)}${deleteFiles && removing.type !== 'parked' ? '?deleteFiles=true' : ''}`);
      setResult(gone);
      toast.success(`${removing.domain} removed`);
      setRemoving(null);
      setDeleteFiles(false);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const columns = [
    { key: 'domain', label: 'Domain', render: (d) => <><code>{d.domain}</code>{d.type === 'main' && <span className="pill pill-muted" style={{ marginLeft: 6 }}>main</span>}</> },
    { key: 'type', label: 'Type', render: (d) => domainTypeLabel(d.type) },
    { key: 'docroot', label: 'Document root', render: (d) => (d.docroot ? <code className="small">{d.docroot}</code> : <span className="muted">—</span>) },
    { key: 'ssl', label: 'SSL', render: (d) => <SslCell ssl={d.ssl} /> },
    { key: 'zone', label: 'DNS zone', render: (d) => <StatusPill status={d.zone ? 'ok' : 'inactive'}>{d.zone ? 'zone' : d.type === 'sub' ? 'in parent zone' : 'no zone'}</StatusPill> },
    { key: 'vhost', label: 'Virtual host', render: (d) => (d.vhost ? <StatusPill status={d.vhost.status === 'applied' ? 'ok' : d.vhost.status === 'pending' ? 'pending' : 'failed'}>{d.vhost.status}</StatusPill> : <span className="muted">—</span>) },
  ];

  return (
    <section className="domains-panel" style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px' }}>Domains</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Addon and sub domains get a directory of their own under <code>public_html</code> (created as the account, with the "Ready to launch" index page), a virtual host, a DNS zone or record, mail routing and an AutoSSL certificate once the name points at this server. Parked domains share the main website. Resellers see the accounts they own; package limits apply to them.</p>
      {error && <ErrorBanner error={error} onRetry={refetch} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="row-actions" style={{ gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
            <span className="small">Addon domains: <strong>{limitText(data.limits?.addon)}</strong></span>
            <span className="small">Subdomains: <strong>{limitText(data.limits?.sub)}</strong></span>
            <span className="small">Parked: <strong>{limitText(data.limits?.parked)}</strong></span>
            {!data.systemUser && <StatusPill status="warning">no Linux user: directories are created once it exists</StatusPill>}
            {data.suspended && <StatusPill status="suspended">account suspended</StatusPill>}
          </div>
          <div className="table-wrap">
            <DataTable dense columns={columns} rows={data.domains || []} rowKey={(d) => d.domain} emptyText="No domains yet."
              rowActions={(d) => (d.type === 'main' ? [] : [{ label: 'Remove', primary: true, danger: true, onClick: () => { setDeleteFiles(false); setRemoving(d); } }])} />
          </div>
          <form onSubmit={add} style={{ marginTop: 14 }}>
            <ErrorBanner error={addError} />
            <div className="form-grid">
              <Field label="Domain" required error={addError?.fields?.domain} help={form.type === 'sub' ? `Must be under ${parents.join(', ') || data.domain}` : 'Without www.; the site answers for the www. name too'}>
                <TextInput value={form.domain} onChange={set('domain')} placeholder={form.type === 'sub' ? `shop.${data.domain}` : 'example.net'} />
              </Field>
              <Field label="Type" error={addError?.fields?.type} help={DOMAIN_TYPES.find((t) => t.value === form.type)?.description}>
                <Select value={form.type} onChange={set('type')} options={DOMAIN_TYPES.map((t) => ({ value: t.value, label: `${t.label}${atLimit(t.value) ? ' (limit reached)' : ''}` }))} />
              </Field>
              {form.type !== 'parked' && (
                <Field label="Document root" error={addError?.fields?.docroot} help="Optional; must be inside the account home. Created as the account with the web-server group (0750).">
                  <TextInput value={form.docroot} onChange={set('docroot')} placeholder={defaultDocroot(data.home, form.domain.trim().toLowerCase(), form.type, parents)} />
                </Field>
              )}
            </div>
            {form.type !== 'parked' && (
              <Field inline>
                <Toggle checked={form.autossl} onChange={set('autossl')} label="Issue an AutoSSL certificate when the name already resolves here" description={data.capabilities?.autossl ? 'AutoSSL is enabled; names that still point elsewhere are skipped, not failed.' : 'AutoSSL is disabled (SSL/TLS › Manage AutoSSL); the step is skipped.'} />
              </Field>
            )}
            <div className="row-actions" style={{ marginTop: 8 }}>
              <Button type="submit" variant="primary" icon={Plus} loading={adding} disabled={!form.domain.trim() || data.suspended}>Add domain</Button>
              <Link className="btn btn-sm" to={`/ssl-tls/manage-autossl`}>AutoSSL settings</Link>
              <Link className="btn btn-sm" to={`/dns-functions/park-a-domain?account=${encodeURIComponent(username)}`}>Park a domain</Link>
            </div>
          </form>
          {result && (
            <div style={{ marginTop: 14 }}>
              <h4 style={{ margin: '0 0 6px' }}>{result.removed ? `Removed ${result.domain}` : `Added ${result.domain}`}{result.docroot ? <span className="muted small"> · {result.docroot}</span> : null}</h4>
              <DomainSteps steps={result.steps} />
            </div>
          )}
        </>
      )}
      <Modal open={Boolean(removing)} title={removing ? `Remove ${removing.domain}?` : ''} onClose={() => setRemoving(null)}
        footer={<><Button onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" loading={busy} onClick={remove}>Remove domain</Button></>}>
        {removing && (
          <>
            <p>The virtual host, the DNS {removing.type === 'sub' ? 'record' : 'zone'}, the mail routing and any installed certificate of <strong>{removing.domain}</strong> are removed.</p>
            {removing.type !== 'parked' && removing.type !== 'alias' && (
              <Field inline><Toggle checked={deleteFiles} onChange={setDeleteFiles} label={`Also delete the document root ${removing.docroot || ''}`} description="Deleted as the account user; a directory shared with another domain is kept." /></Field>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
