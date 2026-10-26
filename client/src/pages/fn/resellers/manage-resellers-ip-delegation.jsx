import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ResellerPicker } from '../../resellers/Shared.jsx';

export default function ManageResellersIpDelegation({ fn }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const { data, loading, error, refetch } = useApi(username ? `/resellers/${encodeURIComponent(username)}/ips` : null, { enabled: Boolean(username) });
  const [selected, setSelected] = useState([]);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setSelected(data.delegated); }, [data]);

  const rows = (data?.addresses || []).filter((a) => a.delegatable || a.delegated);
  const others = (data?.addresses || []).filter((a) => !a.delegatable && !a.delegated);
  const dirty = data && (selected.length !== data.delegated.length || selected.some((a) => !data.delegated.includes(a)));

  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      const { data: res } = await api.put(`/resellers/${encodeURIComponent(username)}/ips`, { addresses: selected });
      toast.success(`${username}: ${res.delegated.length} address(es) delegated${res.added.length ? `, +${res.added.length}` : ''}${res.removed.length ? `, -${res.removed.length}` : ''}`);
      refetch();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };

  const role = (a) => a.is_main ? <StatusPill status="info">main IP</StatusPill> : a.reserved ? <StatusPill status="warning">reserved</StatusPill> : a.dedicated_to ? <StatusPill status="ok">dedicated: {a.dedicated_to}</StatusPill> : a.delegated_to && !a.delegated ? <StatusPill status="warning">delegated to {a.delegated_to}</StatusPill> : !a.managed ? <StatusPill status="warning">dynamic</StatusPill> : a.server_shared ? <StatusPill status="info">server shared IP</StatusPill> : <span className="muted">free</span>;

  return (
    <>
      <PageHeader fn={fn} description="Delegated addresses are the only ones a reseller may assign when creating accounts, besides its shared IP. An address can be delegated to one reseller at a time; the main, reserved and dedicated addresses are never delegated." />
      <Card title="Reseller"><ResellerPicker value={username} onChange={setUsername} /></Card>
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <>
          <Card title={`Addresses available to ${username}`} subtitle={`Reseller shared IP: ${data.shared_ip || `server default (${data.server_shared_ip || 'not set'})`}`} padded={false}
            actions={<Link className="btn btn-sm" to={`/resellers/manage-resellers-shared-ip?username=${username}`}>Change shared IP</Link>}>
            <DataTable
              columns={[
                { key: 'address', label: 'Address', render: (a) => <code>{a.address}</code> },
                { key: 'family', label: 'Family', render: (a) => `IPv${a.family}` },
                { key: 'interface', label: 'Interface' },
                { key: 'role', label: 'Role', render: role },
                { key: 'delegated', label: 'Delegated', render: (a) => <StatusPill status={a.delegated ? 'enabled' : 'disabled'}>{a.delegated ? 'Yes' : 'No'}</StatusPill> },
              ]}
              rows={rows} loading={loading} rowKey={(a) => a.address} selectable selected={selected} onSelectedChange={setSelected}
              emptyText="No free addresses. Add some under IP Functions → Add a New IP Address."
            />
            <div className="card-body">
              <ErrorBanner error={saveError} />
              <FormActions>
                <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save delegation ({selected.length} address(es))</Button>
                <Button variant="ghost" disabled={!dirty} onClick={() => setSelected(data.delegated)}>Reset</Button>
              </FormActions>
            </div>
          </Card>
          {others.length > 0 && (
            <Card title="Not delegatable" subtitle="Main, reserved, dedicated, dynamic or delegated to another reseller" padded={false}>
              <DataTable columns={[{ key: 'address', label: 'Address', render: (a) => <code>{a.address}</code> }, { key: 'role', label: 'Why', render: role }]} rows={others} rowKey={(a) => a.address} dense />
            </Card>
          )}
        </>
      )}
    </>
  );
}
