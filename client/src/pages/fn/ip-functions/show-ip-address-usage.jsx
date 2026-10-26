import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Select, Field } from '../../../components/Form.jsx';
import { IpRequestError, FamilyPill, BoundPill, AddressStatusPill, Summary } from '../../ip/Shared.jsx';

export default function ShowIpAddressUsage({ fn }) {
  const { data, meta, loading, error, refetch } = useApi('/ip/usage');
  const [status, setStatus] = useState('');
  const rows = (data || []).filter((r) => !status || r.status === status);
  const s = meta?.summary;

  return (
    <>
      <PageHeader fn={fn} description="Which account uses each address: the main and shared IPs are used by every account without a dedicated address; dedicated IPs belong to one account; reserved ones are held back. Resellers see only the addresses their accounts use." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <IpRequestError error={error} onRetry={refetch} />
      {s && <Summary items={[['Main', s.main], ['Shared', s.shared], ['Dedicated', s.dedicated], ['Reserved', s.reserved], ['Free', s.free], ['Dynamic', s.unmanaged ?? 0], ['Not recorded', s.unknown]]} />}
      <Card title="IP address usage" padded={false} actions={<Field inline><Select value={status} onChange={setStatus} options={['main', 'shared', 'dedicated', 'reserved', 'free', 'unmanaged', 'unknown'].map((v) => ({ value: v, label: v === 'unmanaged' ? 'dynamic' : v }))} placeholder="All states" /></Field>}>
        <DataTable
          columns={[
            { key: 'address', label: 'Address', render: (r) => <><code>{r.address}</code>{r.shared_ip && <span className="pill pill-info" style={{ marginLeft: 6 }}>shared IP</span>}</> },
            { key: 'family', label: 'Family', render: (r) => <FamilyPill family={r.family} /> },
            { key: 'status', label: 'State', render: (r) => <AddressStatusPill status={r.status} /> },
            { key: 'bound', label: 'On host', render: (r) => <BoundPill bound={r.bound} /> },
            { key: 'dedicated_to', label: 'Dedicated to', render: (r) => r.dedicated_to ? <Link to={`/account-functions/modify-an-account?username=${r.dedicated_to}`}>{r.dedicated_to}</Link> : r.ipv6_account ? <Link to={`/account-functions/modify-an-account?username=${r.ipv6_account}`}>{r.ipv6_account} (IPv6)</Link> : <span className="muted">—</span> },
            { key: 'account_count', label: 'Accounts', align: 'right', render: (r) => r.account_count },
            { key: 'accounts', label: 'Used by', render: (r) => r.accounts?.length ? <span className="muted">{r.accounts.slice(0, 6).map((a) => a.username).join(', ')}{r.accounts.length > 6 ? ` +${r.accounts.length - 6} more` : ''}</span> : r.reserved_reason ? <span className="muted">{r.reserved_reason}</span> : '' },
          ]}
          rows={rows} loading={loading} rowKey={(r) => r.address} emptyText="No addresses to show."
        />
      </Card>
      {(data || []).some((r) => r.unknown) && (
        <Card title="Addresses used by accounts but not in the inventory">
          <p className="muted">These accounts point at an address the panel has not recorded. If the address is bound to this host, run <Link to="/ip-functions/rebuild-the-ip-address-pool">Rebuild the IP Address Pool</Link>; otherwise move the accounts with the <Link to="/ip-functions/ip-migration-wizard">IP Migration Wizard</Link>.</p>
          <ul>{data.filter((r) => r.unknown).map((r) => <li key={r.address}><code>{r.address}</code> — {r.accounts.map((a) => a.username).join(', ')} <StatusPill status={r.bound ? 'ok' : 'failed'}>{r.bound ? 'bound' : 'not bound'}</StatusPill></li>)}</ul>
        </Card>
      )}
    </>
  );
}
