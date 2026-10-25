import { useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, formatMb } from '../../components/Common.jsx';
import { Field, Select, Button, FormActions } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { AccountPicker, useSelectedAccount } from './AccountPicker.jsx';

export default function UpgradeDowngrade({ fn }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const { data: packages } = useApi('/packages?pageSize=500');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const pkg = (packages || []).find((p) => p.name === target);

  const apply = async () => {
    setBusy(true);
    try {
      await api.patch(`/accounts/${username}`, { package: target });
      toast.success(`${username} moved to package "${target}"`);
      setTarget('');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {account && (
        <Card title={`Current package: ${account.package_name || 'none'}`}>
          <KeyValue items={[['Disk', formatMb(account.plan?.disk_mb)], ['Bandwidth', formatMb(account.plan?.bandwidth_mb)], ['Addon domains', account.plan?.max_addons ?? 'Unlimited'], ['Databases', account.plan?.max_db ?? 'Unlimited'], ['Email accounts', account.plan?.max_email ?? 'Unlimited'], ['Shell', account.plan?.has_shell ? 'Yes' : 'No']]} />
          <Field label="New package" style={{ marginTop: 16 }}>
            <Select value={target} onChange={setTarget} options={(packages || []).filter((p) => p.name !== account.package_name).map((p) => ({ value: p.name, label: p.name }))} placeholder="Select a package" />
          </Field>
          {pkg && <KeyValue items={[['Disk', formatMb(pkg.disk_mb)], ['Bandwidth', formatMb(pkg.bandwidth_mb)], ['Addon domains', pkg.max_addons ?? 'Unlimited'], ['Databases', pkg.max_db ?? 'Unlimited'], ['Email accounts', pkg.max_email ?? 'Unlimited'], ['Shell', pkg.has_shell ? 'Yes' : 'No']]} />}
          <FormActions><Button variant="primary" disabled={!target} loading={busy} onClick={apply}>Upgrade/Downgrade</Button></FormActions>
        </Card>
      )}
    </>
  );
}
