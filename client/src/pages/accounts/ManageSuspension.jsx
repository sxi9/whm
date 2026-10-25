import { useState } from 'react';
import { api } from '../../api/client.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../components/Common.jsx';
import { Field, Textarea, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { AccountPicker, useSelectedAccount } from './AccountPicker.jsx';

export default function ManageSuspension({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action) => {
    if (action === 'suspend' && !(await confirm({ title: `Suspend ${username}?`, message: 'The user cannot log in and the sites stop serving until unsuspended.', confirmLabel: 'Suspend', danger: true }))) return;
    setBusy(true);
    try {
      await api.post(`/accounts/${username}/${action}`, action === 'suspend' ? { reason } : {});
      toast.success(`${username} ${action === 'suspend' ? 'suspended' : 'unsuspended'}`);
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
