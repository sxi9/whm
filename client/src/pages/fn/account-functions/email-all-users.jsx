import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, CapabilityNotice, KeyValue } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

const SCOPES = [{ value: 'all', label: 'All accounts' }, { value: 'active', label: 'Active accounts only' }, { value: 'suspended', label: 'Suspended accounts only' }];

export default function EmailAllUsers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [form, setForm] = useState({ subject: '', text: '', scope: 'all', owner: '', from: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const { data: who } = useApi(`/account-functions/email/recipients?scope=${form.scope}${form.owner ? `&owner=${encodeURIComponent(form.owner)}` : ''}`);

  const submit = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Email ${who?.recipients.length ?? 0} account owner(s)?`, message: `"${form.subject}" is handed to the mail server for every account with a contact address in the selection.`, confirmLabel: 'Send' }))) return;
    setBusy(true); setError(null); setOutcome(null);
    try {
      const body = { subject: form.subject, text: form.text, scope: form.scope };
      if (form.owner && user.role === 'root') body.owner = form.owner;
      if (form.from) body.from = form.from;
      const { data } = await api.post('/account-functions/email', body);
      setJob(data.job.id);
      toast.success(`Sending to ${data.recipients} recipient(s) as ${data.from}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Sends a plain-text message to the contact address of every account you manage. {{username}}, {{domain}} and {{hostname}} are replaced per recipient. Delivery goes through this server's Exim." />
      <form onSubmit={submit}>
        <Card title="Recipients">
          <div className="form-grid">
            <Field label="Which accounts"><Select value={form.scope} onChange={set('scope')} options={SCOPES} /></Field>
            {user.role === 'root' && <Field label="Owned by" help="Limit to one reseller's accounts (blank = everyone)"><TextInput value={form.owner} onChange={set('owner')} placeholder="reseller username" /></Field>}
            <Field label="From address" help="Blank uses the server's notification sender"><TextInput type="email" value={form.from} onChange={set('from')} placeholder={`root@${window.location.hostname}`} /></Field>
          </div>
          {who && <p className="muted" style={{ marginTop: 8 }}>{who.recipients.length} recipient(s){who.withoutEmail ? `; ${who.withoutEmail} account(s) have no contact email and are skipped` : ''}.</p>}
        </Card>
        <Card title="Message">
          <CapabilityNotice error={error} />
          <ErrorBanner error={error && error.status !== 501 ? error : null} />
          <Field label="Subject" required error={error?.fields?.subject}><TextInput value={form.subject} onChange={set('subject')} placeholder="Scheduled maintenance on {{hostname}}" /></Field>
          <Field label="Body" required error={error?.fields?.text}><Textarea value={form.text} onChange={set('text')} rows={12} placeholder={'Hello {{username}},\n\nYour site {{domain}} …'} /></Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.subject || !form.text || !who?.recipients.length}>Send to {who?.recipients.length ?? 0} recipient(s)</Button></FormActions>
        </Card>
      </form>
      {job && (
        <Card title="Delivery">
          <ProgressLog jobId={job} onFinished={(ev) => setOutcome(ev)} />
          {outcome?.result && <KeyValue items={[['Sent', outcome.result.sent.length], ['Failed', outcome.result.failed.length], outcome.result.failed.length > 0 && ['Failures', outcome.result.failed.map((f) => `${f.username}: ${f.error}`).join('; ')]]} />}
        </Card>
      )}
    </>
  );
}
