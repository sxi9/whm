import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue } from '../../../components/Common.jsx';
import { Field, RadioGroup, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ResellerPicker } from '../../resellers/Shared.jsx';

export default function ManageResellersSharedIp({ fn }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const { data, error, refetch } = useApi(username ? `/resellers/${encodeURIComponent(username)}/ips` : null, { enabled: Boolean(username) });
  const [choice, setChoice] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setChoice(data.shared_ip || ''); }, [data]);

  const candidates = (data?.addresses || []).filter((a) => !a.reserved && !a.dedicated_to && a.managed && (a.delegated || a.is_main || a.server_shared || !a.delegated_to));
  const options = [
    { value: '', label: `Server shared IP${data?.server_shared_ip ? ` (${data.server_shared_ip})` : ''}`, description: 'Accounts the reseller creates use the server-wide shared address' },
    ...candidates.map((a) => ({ value: a.address, label: a.address, description: a.is_main ? 'Main IP' : a.delegated ? 'Delegated to this reseller' : a.server_shared ? 'Server shared IP' : 'Free address (not delegated)' })),
  ];

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setSaveError(null);
    try {
      const { data: res } = await api.put(`/resellers/${encodeURIComponent(username)}/shared-ip`, { sharedIp: choice || null });
      toast.success(`${username}: shared IP ${res.shared_ip || 'reset to the server default'} (effective ${res.effective_shared_ip || 'none'})`);
      refetch();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="The shared IP is the address a reseller's new accounts receive when no dedicated address is chosen. Existing accounts are not moved; use Change Site's IP Address for those." />
      <Card title="Reseller"><ResellerPicker value={username} onChange={setUsername} /></Card>
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <form onSubmit={save}>
          <Card title={`Shared IP for ${username}`} actions={<Link className="btn btn-sm" to={`/resellers/manage-resellers-ip-delegation?username=${username}`}>Delegate addresses</Link>}>
            <KeyValue items={[['Current', data.shared_ip || 'server default'], ['Server shared IP', data.server_shared_ip || 'not set (Basic WebHost Manager Setup)'], ['Delegated addresses', data.delegated.join(', ') || 'none']]} />
            <ErrorBanner error={saveError} />
            <Field label="Use" help="Delegated or free addresses can be chosen; reserved and dedicated ones cannot">
              <RadioGroup name="shared-ip" value={choice} onChange={setChoice} options={options} />
            </Field>
            <FormActions><Button type="submit" variant="primary" loading={busy} disabled={choice === (data.shared_ip || '')}>Save shared IP</Button></FormActions>
          </Card>
        </form>
      )}
    </>
  );
}
