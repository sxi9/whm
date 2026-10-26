import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, KeyValue } from '../../../components/Common.jsx';
import { Field, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { AccountPicker, useSelectedAccount } from '../../accounts/AccountPicker.jsx';
import { useResellerCatalog } from '../../resellers/Shared.jsx';

export default function ChangeOwnershipOfAnAccount({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const catalog = useResellerCatalog();
  const [owner, setOwner] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const owners = (catalog.data?.owners || []).filter((o) => o.username !== account?.owner);

  const submit = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Move ${username} to ${owner}?`, message: `${owner} gains full control of ${account.domain}; ${account.owner} loses it. Packages, IPs and DNS are unchanged.`, confirmLabel: 'Change owner' }))) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/resellers/ownership/${encodeURIComponent(username)}`, { owner });
      setLast(data);
      toast.success(`${data.username} is now owned by ${data.owner}`);
      setOwner('');
      refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Moves one hosting account to root or to another reseller. The new owner's limits are reported, not enforced, so an over-limit reseller is flagged after the move." />
      <Card title="Account"><AccountPicker value={username} onChange={setUsername} /></Card>
      <ErrorBanner error={catalog.error} onRetry={catalog.refetch} />
      {account && (
        <form onSubmit={submit}>
          <Card title={`${account.domain} (${account.username})`}>
            <KeyValue items={[['Current owner', <code key="o">{account.owner}</code>], ['Package', account.package_name], ['IP', account.ip], ['Status', account.suspended ? 'Suspended' : 'Active']]} />
            <ErrorBanner error={error} />
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Field label="New owner" required help="root or a reseller"><Select value={owner} onChange={setOwner} options={owners.map((o) => ({ value: o.username, label: `${o.username} (${o.role})` }))} placeholder="Select an owner" /></Field>
            </div>
            <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!owner}>Change ownership</Button></FormActions>
          </Card>
        </form>
      )}
      {last && (
        <Card title="Last change">
          <KeyValue items={[['Account', last.username], ['From', last.previous_owner], ['To', last.owner], last.warnings.length > 0 && ['Warnings', last.warnings.join('; ')]]} />
        </Card>
      )}
    </>
  );
}
