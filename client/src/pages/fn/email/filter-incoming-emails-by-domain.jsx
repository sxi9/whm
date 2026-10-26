import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, EximNotice, ApplyBadge, IncludeHint, applyMessage, useMailStatus } from '../../email/Shared.jsx';

export default function FilterIncomingEmailsByDomain({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, refetch: refetchStatus } = useMailStatus();
  const { data, loading, error, refetch } = useApi('/email/filters/domain');
  const [form, setForm] = useState({ domain: '', kind: 'block', comment: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastApply, setLastApply] = useState(null);
  const [fieldErrors, setFieldErrors] = useState(null);
  useEffect(() => { if (data) setMessage(data.message || ''); }, [data]);
  const done = (res, verb) => { setLastApply(res.apply); toast[res.apply?.applied ? 'success' : 'warning'](applyMessage(res.apply, verb)); refetch(); };

  const add = async () => {
    setBusy(true); setFieldErrors(null);
    try {
      const { data: res } = await api.post('/email/filters/domain', { domain: form.domain.trim().toLowerCase(), kind: form.kind, ...(form.comment.trim() ? { comment: form.comment.trim() } : {}) });
      done(res, `${res.rule.domain} added to the ${res.rule.kind} list`); setForm({ domain: '', kind: form.kind, comment: '' });
    } catch (err) { setFieldErrors(err.fields); toast.error(err); } finally { setBusy(false); }
  };
  const toggle = async (r) => { setBusy(true); try { const { data: res } = await api.patch(`/email/filters/domain/${r.id}`, { enabled: !r.enabled }); done(res, `${r.domain} ${r.enabled ? 'disabled' : 'enabled'}`); } catch (err) { toast.error(err); } finally { setBusy(false); } };
  const remove = async (r) => {
    if (!(await confirm({ title: `Remove ${r.domain}?`, message: `The domain leaves the ${r.kind} list and Exim is updated.`, confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true); try { const { data: res } = await api.delete(`/email/filters/domain/${r.id}`); done(res, `${r.domain} removed`); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const saveMessage = async () => { setBusy(true); try { const { data: res } = await api.put('/email/filters/messages', { domain: message }); done(res, 'Rejection message saved'); } catch (err) { toast.error(err); } finally { setBusy(false); } };

  const rules = data?.rules || [];
  return (
    <>
      <PageHeader fn={fn} description="Rejects mail whose envelope sender is at a blocked domain (or any of its subdomains) at SMTP time. Allow-listed domains are exempt from the block list and from country filtering of the sender domain. Authenticated users are never filtered." />
      <EximNotice status={status} onRetry={refetchStatus} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Rules" padded={false} actions={<><ApplyBadge apply={lastApply || data.lastApply} /><Button size="sm" loading={busy} onClick={async () => { try { const { data: res } = await api.post('/email/filters/apply'); setLastApply(res); toast.success(applyMessage(res, 'Filters re-applied')); refetch(); } catch (err) { toast.error(err); } }}>Apply to Exim</Button></>}>
            <DataTable
              columns={[
                { key: 'domain', label: 'Sender domain', render: (r) => <><code>{r.domain}</code> <span className="muted">(*@{r.domain}, *@*.{r.domain})</span></> },
                { key: 'kind', label: 'List', render: (r) => <StatusPill status={r.kind === 'block' ? 'failed' : 'ok'}>{r.kind}</StatusPill> },
                { key: 'enabled', label: 'Enabled', render: (r) => <StatusPill status={r.enabled ? 'enabled' : 'disabled'} /> },
                { key: 'comment', label: 'Comment' },
                { key: 'created_at', label: 'Added', render: (r) => formatDate(r.created_at) },
              ]}
              rows={rules} loading={loading} rowKey={(r) => r.id} dense emptyText="No domain rules yet."
              rowActions={(r) => [{ label: r.enabled ? 'Disable' : 'Enable', primary: true, onClick: () => toggle(r) }, { label: 'Remove', danger: true, onClick: () => remove(r) }]}
            />
          </Card>
          <IncludeHint apply={lastApply || data.lastApply} />
          <div className="form-grid">
            <Card title="Add a domain">
              <Field label="Domain" error={fieldErrors?.domain}><TextInput value={form.domain} onChange={(v) => setForm((f) => ({ ...f, domain: v }))} placeholder="spammer.example" /></Field>
              <Field label="List"><Select value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={[{ value: 'block', label: 'Block list — reject mail from this domain' }, { value: 'allow', label: 'Allow list — never block this domain' }]} /></Field>
              <Field label="Comment (optional)"><TextInput value={form.comment} onChange={(v) => setForm((f) => ({ ...f, comment: v }))} placeholder="phishing campaign, ticket #123" /></Field>
              <FormActions><Button variant="primary" loading={busy} disabled={!form.domain.includes('.')} onClick={add}>Add</Button></FormActions>
            </Card>
            <Card title="Rejection message" subtitle="Sent in the SMTP 550 response to blocked senders">
              <Field label="Message"><TextInput value={message} onChange={setMessage} /></Field>
              <FormActions><Button variant="primary" loading={busy} disabled={message === data.message} onClick={saveMessage}>Save message</Button></FormActions>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
