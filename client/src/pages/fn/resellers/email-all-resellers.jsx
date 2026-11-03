import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, CapabilityNotice, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function EmailAllResellers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({ subject: '', text: '', from: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const { data: who, loading: whoLoading, error: whoError, refetch } = useApi('/resellers/email/recipients');
  const history = useApi('/resellers/email/history');

  const submit = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Email ${who?.recipients.length ?? 0} reseller(s)?`, message: `"${form.subject}" is handed to the mail server for every reseller with an email address.`, confirmLabel: 'Send' }))) return;
    setBusy(true); setError(null); setOutcome(null);
    try {
      const body = { subject: form.subject, text: form.text };
      if (form.from) body.from = form.from;
      const { data } = await api.post('/resellers/email', body);
      setJob(data.job.id);
      toast.success(`Sending to ${data.recipients} reseller(s) as ${data.from}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const recipientsSubtitle = who
    ? `${who.recipients.length} reseller(s) with an email address${who.withoutEmail ? `; ${who.withoutEmail} without one are skipped (set it in Reseller Center)` : ''}`
    : undefined;

  return (
    <>
      <PageHeader fn={fn} description="Sends a plain-text message to every reseller's email address. {{username}}, {{accounts}} and {{hostname}} are replaced per recipient. Delivery goes through this server's mail server." />
      <form onSubmit={submit}>
        <Card title="Recipients" subtitle={recipientsSubtitle} padded={false}>
          <ErrorBanner error={whoError} onRetry={refetch} />
          <DataTable
            dense
            columns={[
              { key: 'username', label: 'Reseller', render: (r) => <><code>{r.username}</code>{r.suspended ? <span className="muted"> (suspended)</span> : null}</> },
              { key: 'email', label: 'Email' },
              { key: 'accounts', label: 'Accounts', align: 'right' },
            ]}
            rows={who?.recipients || []} loading={whoLoading} rowKey={(r) => r.username}
            emptyText="Resellers with an email address will be listed here. Set one in Reseller Center."
          />
        </Card>
        <Card title="Message">
          <CapabilityNotice error={error} />
          <ErrorBanner error={error && error.status !== 501 ? error : null} />
          <div className="form-grid">
            <Field label="From address" help="Blank uses the resellers.email_from setting, then the server's notification sender"><TextInput type="email" value={form.from} onChange={set('from')} placeholder={`root@${window.location.hostname}`} /></Field>
          </div>
          <Field label="Subject" required error={error?.fields?.subject}><TextInput value={form.subject} onChange={set('subject')} placeholder="Scheduled maintenance on {{hostname}}" /></Field>
          <Field label="Body" required error={error?.fields?.text}><Textarea value={form.text} onChange={set('text')} rows={12} placeholder={'Hello {{username}},\n\nYour {{accounts}} account(s) on {{hostname}} …'} /></Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.subject || !form.text || !who?.recipients.length}>Send to {who?.recipients.length ?? 0} reseller(s)</Button></FormActions>
        </Card>
      </form>
      {job && (
        <Card title="Delivery">
          <ProgressLog jobId={job} onFinished={(ev) => { setOutcome(ev); history.refetch(); }} />
          {outcome?.result && <KeyValue items={[['Sent', outcome.result.sent.length], ['Failed', outcome.result.failed.length], outcome.result.failed.length > 0 && ['Failures', outcome.result.failed.map((f) => `${f.username}: ${f.error}`).join('; ')]]} />}
        </Card>
      )}
      <Card title="Recent broadcasts" subtitle="Messages and addresses are kept here, visible to root only; the job queue shows counts" padded={false}>
        <ErrorBanner error={history.error} onRetry={history.refetch} />
        <DataTable
          dense
          columns={[
            { key: 'created_at', label: 'Sent', render: (b) => formatDate(b.created_at) },
            { key: 'subject', label: 'Subject' },
            { key: 'from', label: 'From' },
            { key: 'requested_by', label: 'By', render: (b) => <code>{b.requested_by}</code> },
            { key: 'status', label: 'Status', render: (b) => <StatusPill status={b.status === 'partial' ? 'warning' : b.status}>{b.status}</StatusPill> },
            { key: 'sent', label: 'Delivered', align: 'right', render: (b) => b.sent.length },
            { key: 'failed', label: 'Failed', render: (b) => b.failed.length ? b.failed.map((f) => `${f.username} <${f.email}>: ${f.error}`).join('; ') : '0' },
          ]}
          rows={history.data || []} loading={history.loading} rowKey={(b) => b.id}
          emptyText="Messages sent from this page will be listed here."
        />
      </Card>
    </>
  );
}
