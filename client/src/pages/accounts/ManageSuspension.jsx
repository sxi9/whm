import { useState } from 'react';
import { api } from '../../api/client.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../components/Common.jsx';
import { Field, Textarea, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { AccountPicker, useSelectedAccount } from './AccountPicker.jsx';

const webReason = (reason) => ({
  web_category_missing: 'Service Configuration is not loaded',
  web_hook_missing: 'the web server integration does not switch suspended sites yet',
  capability_missing: 'Apache is not installed',
}[reason] || reason || 'not applied');

export default function ManageSuspension({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action) => {
    if (action === 'suspend' && !(await confirm({ title: `Suspend ${username}?`, message: 'The Linux account is locked, which blocks SSH, FTP and mailbox logins. The web sites are switched to the suspended page only when the web server integration provides it; the result says whether that happened.', confirmLabel: 'Suspend', danger: true }))) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/accounts/${username}/${action}`, action === 'suspend' ? { reason } : {});
      const verb = action === 'suspend' ? 'suspended' : 'unsuspended';
      if (data?.web?.applied) toast.success(`${username} ${verb}; the web sites now ${action === 'suspend' ? 'show the suspended page' : 'serve their content again'}`);
      else toast.success(`${username} ${verb} (logins ${action === 'suspend' ? 'locked' : 'unlocked'}); web sites unchanged: ${webReason(data?.web?.reason)}`);
      setReason('');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {account && (
        <Card title={`${account.domain} (${account.username})`}>
          <KeyValue items={[['Status', <StatusPill key="s" status={account.suspended ? 'suspended' : 'active'}>{account.suspended ? 'Suspended' : 'Active'}</StatusPill>], account.suspended && ['Reason', account.suspend_reason || '—'], account.suspended && ['Suspended at', account.suspended_at]]} />
          <p className="muted" style={{ marginTop: 10 }}>Suspending locks the Linux user (SSH, FTP and mailbox logins that authenticate against it stop working). The web sites keep their content until the web server integration switches them to the suspended page; the result of each action says what was applied.</p>
          {!account.suspended ? (
            <>
              <Field label="Reason (shown to the account owner)" style={{ marginTop: 14 }}><Textarea value={reason} onChange={setReason} rows={3} placeholder="e.g. Non-payment, abuse report #123" /></Field>
              <FormActions><Button variant="danger" loading={busy} onClick={() => run('suspend')}>Suspend account</Button></FormActions>
            </>
          ) : (
            <FormActions><Button variant="primary" loading={busy} onClick={() => run('unsuspend')}>Unsuspend account</Button></FormActions>
          )}
        </Card>
      )}
    </>
  );
}
