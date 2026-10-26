import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Select, Field } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { IpRequestError, FamilyPill, BoundPill, Iproute2Notice } from '../../ip/Shared.jsx';

export default function ShowOrDeleteCurrentIpAddresses({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [family, setFamily] = useState('');
  const { data, meta, loading, error, refetch } = useApi(`/ip/addresses${family ? `?family=${family}` : ''}`);
  const [actionError, setActionError] = useState(null);

  const remove = async (row) => {
    const ok = await confirm({
      title: row.managed ? `Remove ${row.address}?` : `Forget ${row.address}?`,
      message: row.managed
        ? `The address is removed from ${row.interface || 'its interface'} immediately and dropped from the boot-time inventory. Sites or services still answering on it will stop responding.`
        : 'This is a DHCP/SLAAC or privacy address owned by the host: it is dropped from the panel\'s inventory only and stays bound to the interface. Rebuilding the pool imports it again while it is present.',
      confirmLabel: row.managed ? 'Remove address' : 'Forget address', danger: row.managed, typeToConfirm: row.managed ? row.address : undefined,
    });
    if (!ok) return;
    setActionError(null);
    try {
      const { data: res } = await api.delete(`/ip/addresses/${encodeURIComponent(row.address)}`);
      toast.success(`${res.address} removed${res.removedFromSystem ? ' from the interface' : ''}`);
      refetch();
    } catch (err) { setActionError(err); }
  };

  const routes = meta?.routes;
  return (
    <>
      <PageHeader fn={fn} description="Every address the panel knows about, with its live state on the host. The main IP and addresses in use by accounts, the shared IP or remote services cannot be removed." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <Iproute2Notice meta={meta} />
      <IpRequestError error={error} onRetry={refetch} />
      <IpRequestError error={actionError} />
      {meta && (
        <Card title="Host summary">
          <KeyValue items={[
            ['Main IP', meta.mainIp ? <code key="m">{meta.mainIp}</code> : <span key="m" className="muted">not detected — set it in <Link to="/server-configuration/basic-webhost-manager-setup">Basic Setup</Link></span>],
            ['Default route (IPv4)', routes?.ipv4 ? <span key="r4">via <code>{routes.ipv4.gateway}</code> on <code>{routes.ipv4.dev}</code>{routes.ipv4.prefsrc ? <> from <code>{routes.ipv4.prefsrc}</code></> : null}</span> : 'none'],
            ['Default route (IPv6)', routes?.ipv6 ? <span key="r6">via <code>{routes.ipv6.gateway}</code> on <code>{routes.ipv6.dev}</code></span> : 'none'],
            ['Address source', meta.source === 'iproute2' ? 'ip -j addr' : meta.source === 'os' ? 'OS view (iproute2 missing)' : 'unavailable'],
            ['Recorded addresses', meta.total],
          ]} />
        </Card>
      )}
      <Card title="Bound IP addresses" padded={false} actions={<Field inline><Select value={family} onChange={setFamily} options={[{ value: '4', label: 'IPv4 only' }, { value: '6', label: 'IPv6 only' }]} placeholder="All families" /></Field>}>
        <DataTable
          columns={[
            { key: 'address', label: 'Address', render: (r) => <code>{r.address}</code> },
            { key: 'family', label: 'Family', render: (r) => <FamilyPill family={r.family} /> },
            { key: 'netmask', label: 'Netmask', render: (r) => r.family === 4 ? r.netmask : `/${r.prefix}` },
            { key: 'interface', label: 'Interface', render: (r) => <>{r.interface || <span className="muted">—</span>}{r.live_interface && r.live_interface !== r.interface ? <span className="muted"> (live: {r.live_interface})</span> : null}</> },
            { key: 'bound', label: 'On host', render: (r) => <BoundPill bound={r.bound} /> },
            { key: 'role', label: 'Role', render: (r) => r.is_main ? <StatusPill status="info">main IP</StatusPill> : r.reserved ? <StatusPill status="warning">reserved</StatusPill> : r.dedicated_to ? <StatusPill status="ok">dedicated: {r.dedicated_to}</StatusPill> : !r.managed ? <StatusPill status="warning">dynamic — not persisted</StatusPill> : <span className="muted">{r.accounts ? 'shared' : 'free'}</span> },
            { key: 'accounts', label: 'Accounts', align: 'right', render: (r) => r.accounts ? <Link to={`/ip-functions/show-ip-address-usage`}>{r.accounts}</Link> : <span className="muted">0</span> },
          ]}
          rows={data || []} loading={loading} rowKey={(r) => r.address}
          rowActions={(r) => [{ label: r.protected ? 'Protected' : r.managed ? 'Delete' : 'Forget', primary: true, danger: true, disabled: r.protected || r.accounts > 0 || Boolean(r.dedicated_to), onClick: () => remove(r) }]}
          emptyText="No addresses recorded. Use Rebuild the IP Address Pool to import the host's addresses."
        />
      </Card>
      {meta?.unmanaged?.length > 0 && (
        <Card title="Addresses on the host that are not in the inventory" subtitle="Found on an interface but never recorded by the panel. Rebuilding the pool imports them; DHCP/SLAAC and privacy addresses are imported as dynamic and never re-added at boot." actions={<Link className="btn btn-sm" to="/ip-functions/rebuild-the-ip-address-pool">Rebuild pool</Link>} padded={false}>
          <DataTable
            columns={[
              { key: 'address', label: 'Address', render: (r) => <code>{r.address}</code> },
              { key: 'family', label: 'Family', render: (r) => <FamilyPill family={r.family} /> },
              { key: 'prefix', label: 'Prefix', render: (r) => `/${r.prefix}` },
              { key: 'interface', label: 'Interface' },
              { key: 'dynamic', label: 'Kind', render: (r) => r.temporary ? 'IPv6 privacy (temporary)' : r.dynamic ? 'DHCP / SLAAC' : 'static' },
            ]}
            rows={meta.unmanaged} rowKey={(r) => r.address} dense
          />
        </Card>
      )}
    </>
  );
}
