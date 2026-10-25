import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';

const EMPTY = { domain: '', targetUrl: 'https://', type: 'permanent', matchWww: true, keepPath: true };

function ForwardingForm({ initial, onSaved, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState(initial ? { domain: initial.domain, targetUrl: initial.target_url, type: initial.type, matchWww: initial.match_www, keepPath: initial.keep_path } : EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/dns/forwarding/${form.domain.trim().toLowerCase()}`, { targetUrl: form.targetUrl.trim(), type: form.type, matchWww: form.matchWww, keepPath: form.keepPath });
      toast.success(data.status === 'applied' ? `Redirect for ${data.domain} is live` : data.status === 'pending' ? `Redirect for ${data.domain} saved; it is applied once the web server module is available` : `Redirect saved but not applied: ${data.last_error}`);
      onSaved(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <div className="form-grid">
        <Field label="Domain" required error={error?.fields?.domain}><TextInput value={form.domain} onChange={set('domain')} placeholder="old-site.com" disabled={Boolean(initial)} /></Field>
        <Field label="Redirect to" required error={error?.fields?.targetUrl} help="Absolute URL"><TextInput value={form.targetUrl} onChange={set('targetUrl')} placeholder="https://www.new-site.com/" /></Field>
        <Field label="Type" error={error?.fields?.type}><Select value={form.type} onChange={set('type')} options={[{ value: 'permanent', label: 'Permanent (301)' }, { value: 'temporary', label: 'Temporary (302)' }]} /></Field>
      </div>
      <Field inline><Toggle checked={form.matchWww} onChange={set('matchWww')} label="Also redirect www.<domain>" /></Field>
      <Field inline><Toggle checked={form.keepPath} onChange={set('keepPath')} label="Keep the request path" description="/page → target/page (off: everything goes to the target URL)" /></Field>
      <FormActions><Button type="submit" variant="primary" loading={busy}>{initial ? 'Save' : 'Add redirect'}</Button>{onCancel && <Button onClick={onCancel}>Cancel</Button>}</FormActions>
    </form>
  );
}

export default function SetupEditDomainForwarding({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const t = useTableState({ sort: 'domain' });
  const { data, meta, loading, error, refetch } = useApi(`/dns/forwarding${queryString(t.state)}`);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const pending = (data || []).filter((r) => r.status !== 'applied').length;
  const webSupported = data?.[0]?.webSupported;

  const remove = async (row) => {
    if (!(await confirm({ title: `Remove the redirect for ${row.domain}?`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/dns/forwarding/${row.domain}`); toast.success('Redirect removed'); refetch(); } catch (err) { toast.error(err); }
  };
  const applyAll = async () => {
    setBusy(true);
    try { const { data: res } = await api.post('/dns/forwarding/apply'); toast.success(res.webSupported ? `Applied ${res.results.filter((r) => r.status === 'applied').length} redirect(s)` : 'The web server module is not loaded yet; redirects stay pending'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="HTTP redirects for whole domains. Redirects are stored here and applied to the web server's virtual hosts; when the web module is unavailable they wait as pending."
        actions={<><Button variant="primary" onClick={() => setEditing({})}>Add redirect</Button>{user.role === 'root' && pending > 0 && <Button loading={busy} onClick={applyAll}>Apply pending ({pending})</Button>}</>} />
      {data && webSupported === false && <div className="banner banner-info"><div><strong>Web server integration not loaded</strong><p>Redirects are recorded and will be written to the vhosts as soon as the web server module is available.</p></div></div>}
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Domain', sortable: true, render: (r) => <code>{r.domain}</code> },
            { key: 'target_url', label: 'Redirects to', render: (r) => <a href={r.target_url} target="_blank" rel="noreferrer">{r.target_url}</a> },
            { key: 'type', label: 'Type', render: (r) => (r.type === 'permanent' ? '301' : '302') },
            { key: 'match_www', label: 'www', render: (r) => (r.match_www ? 'yes' : 'no') },
            { key: 'account', label: 'Account', sortable: true, render: (r) => r.account || <span className="muted">—</span> },
            { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.status === 'applied' ? 'ok' : r.status}>{r.status}{r.last_error ? `: ${r.last_error}` : ''}</StatusPill> },
            { key: 'updated_at', label: 'Updated', sortable: true, render: (r) => formatDate(r.updated_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.domain}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch}
          rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setEditing(r) }, { label: 'Remove', danger: true, onClick: () => remove(r) }]}
          emptyText="No domain redirects configured."
        />
      </Card>
      <Modal open={Boolean(editing)} title={editing?.domain ? `Edit redirect for ${editing.domain}` : 'Add a domain redirect'} onClose={() => setEditing(null)}>
        {editing && <ForwardingForm initial={editing.domain ? editing : null} onSaved={() => { setEditing(null); refetch(); }} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
