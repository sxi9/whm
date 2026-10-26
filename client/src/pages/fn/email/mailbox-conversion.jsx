import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, formatBytes } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, AccountPicker, useMailStatus } from '../../email/Shared.jsx';
import { CapabilityNotice } from '../../../components/Common.jsx';

const FORMATS = [{ value: 'maildir', label: 'Maildir (one file per message)' }, { value: 'mdbox', label: 'mdbox (Dovecot multi-message files)' }, { value: 'sdbox', label: 'sdbox (Dovecot single-message files)' }, { value: 'mbox', label: 'mbox (one file per folder)' }];

export default function MailboxConversion({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, refetch: refetchStatus } = useMailStatus();
  const { data: accounts, error: accountsError, refetch } = useApi('/email/mailbox/accounts');
  const [username, setUsername] = useState('');
  const { data: inspect, error: inspectError } = useApi(username ? `/email/mailbox/accounts/${username}` : null, { enabled: Boolean(username) });
  const [form, setForm] = useState({ mailUser: '', sourceFormat: 'maildir', sourcePath: 'mail', targetFormat: 'mdbox', targetPath: 'mail/mdbox', dryRun: true });
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const start = async () => {
    if (!form.dryRun && !(await confirm({ title: `Convert ${username}'s mailbox?`, message: `Runs doveadm -o mail_location=${form.sourceFormat}:${form.sourcePath} sync -1 -u ${form.mailUser.trim() || username} ${form.targetFormat}:${form.targetPath}: the source is read through mail_location and copied one-way into the target. The source is left in place; point Dovecot's mail_location at the target afterwards. Large mailboxes take a while.`, confirmLabel: 'Convert', typeToConfirm: 'CONVERT' }))) return;
    setBusy(true); setError(null);
    try {
      const body = { username, source: { format: form.sourceFormat, path: form.sourcePath.trim() }, target: { format: form.targetFormat, path: form.targetPath.trim() }, dryRun: form.dryRun };
      if (form.mailUser.trim()) body.mailUser = form.mailUser.trim();
      const { data } = await api.post('/email/mailbox/convert', body);
      setJob(data.job.id);
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  const dovecotMissing = status && !status.dovecot;
  return (
    <>
      <PageHeader fn={fn} description="Converts a mailbox between Maildir, mdbox, sdbox and mbox with Dovecot's dsync: doveadm -o mail_location=<source> sync -1 -u <user> <target> reads the source through mail_location and writes a one-way copy into the target. The source stays untouched; switch the account's mail_location once the copy is verified. Use Dry run first to see the exact command." />
      {dovecotMissing && <CapabilityNotice error={{ code: 'capability_missing', message: 'Dovecot (doveadm) is not installed on this server. Install dovecot-core / dovecot to convert mailboxes.' }} onRetry={refetchStatus} />}
      <RequestError error={accountsError} onRetry={refetch} />
      <Card title="Account"><AccountPicker value={username} onChange={(v) => { setUsername(v); setJob(null); }} accounts={accounts} /></Card>
      {username && (
        <>
          <Card title="Detected mail storage">
            <RequestError error={inspectError} />
            {inspect && (inspect.found.length
              ? <KeyValue items={[...inspect.found.map((f) => [f.path, `${f.format} — ${f.note}${f.size != null ? ` (${formatBytes(f.size)})` : ''}`]), inspect.domains.length && ['Mail domains', inspect.domains.join(', ')]]} />
              : <p className="muted">No mail directories found under {inspect.homeDir} yet.</p>)}
          </Card>
          <Card title="Conversion">
            <ErrorBanner error={error} />
            <div className="form-grid">
              <Field label="Source format"><Select value={form.sourceFormat} onChange={set('sourceFormat')} options={FORMATS} /></Field>
              <Field label="Source path" help="Relative to the account home or absolute inside it" error={error?.fields?.['source.path']}><TextInput value={form.sourcePath} onChange={set('sourcePath')} placeholder="mail/example.com/alice" /></Field>
              <Field label="Target format"><Select value={form.targetFormat} onChange={set('targetFormat')} options={FORMATS} /></Field>
              <Field label="Target path" help="Created if missing; must be inside the home" error={error?.fields?.['target.path']}><TextInput value={form.targetPath} onChange={set('targetPath')} placeholder="mail/mdbox" /></Field>
              <Field label="Dovecot user (optional)" help="The mail account doveadm runs as; defaults to the system user"><TextInput value={form.mailUser} onChange={set('mailUser')} placeholder="alice@example.com" /></Field>
            </div>
            <Field inline><Toggle checked={form.dryRun} onChange={set('dryRun')} label="Dry run" description="Only show the doveadm command that would run (source as mail_location, target as the sync destination)" /></Field>
            <FormActions><Button variant="primary" loading={busy} disabled={dovecotMissing || !form.sourcePath.trim() || !form.targetPath.trim()} onClick={start}>{form.dryRun ? 'Preview' : 'Start conversion'}</Button></FormActions>
          </Card>
          {job && <Card title="Progress"><ProgressLog jobId={job} onFinished={(e) => toast[e.type === 'done' ? 'success' : 'error'](e.type === 'done' ? 'Conversion finished' : e.error || 'Conversion failed')} /></Card>}
        </>
      )}
    </>
  );
}
