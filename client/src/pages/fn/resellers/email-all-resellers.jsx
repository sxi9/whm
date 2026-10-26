import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, CapabilityNotice, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
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
  const { data: who, error: whoError, refetch } = useApi('/resellers/email/recipients');
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

  return (
    <>
      <PageHeader fn={fn} description="Sends a plain-text message to every reseller's email address. {{username}}, {{accounts}} and {{hostname}} are replaced per recipient. Delivery goes through this server's mail server." />
      <form onSubmit={submit}>
        <Card title="Recipients" padded>
          <ErrorBanner error={whoError} onRetry={refetch} />
          {who && (
            <>
              <p className="muted" style={{ marginTop: 0 }}>{who.recipients.length} reseller(s) with an email address{who.withoutEmail ? `; ${who.withoutEmail} without one are skipped (set it in Reseller Center)` : ''}.</p>
              {who.recipients.length > 0 && <div className="table-wrap"><table><thead><tr><th>Reseller</th><th>Email</th><th>Accounts</th></tr></thead><tbody>{who.recipients.map((r) => <tr key={r.username}><td><code>{r.username}</code>{r.suspended ? ' (suspended)' : ''}</td><td>{r.email}</td><td>{r.accounts}</td></tr>)}</tbody></table></div>}
            </>
          )}
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
      <Card title="Recent broadcasts" subtitle="Messages and addresses are kept here, visible to root only; the job queue shows counts">
        <ErrorBanner error={history.error} onRetry={history.refetch} />
        {history.data?.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing has been sent yet.</p>}
        {history.data?.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Sent</th><th>Subject</th><th>From</th><th>By</th><th>Status</th><th>Delivered</th><th>Failed</th></tr></thead>
            <tbody>{history.data.map((b) => (
              <tr key={b.id}>
                <td>{formatDate(b.created_at)}</td><td>{b.subject}</td><td>{b.from}</td><td><code>{b.requested_by}</code></td>
                <td><StatusPill status={b.status === 'partial' ? 'warning' : b.status}>{b.status}</StatusPill></td>
                <td>{b.sent.length}</td>
                <td>{b.failed.length ? b.failed.map((f) => `${f.username} <${f.email}>: ${f.error}`).join('; ') : '0'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
