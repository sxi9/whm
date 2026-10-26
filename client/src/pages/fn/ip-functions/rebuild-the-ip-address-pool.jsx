import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError, FamilyPill, AddressStatusPill, Summary, Iproute2Notice } from '../../ip/Shared.jsx';

export default function RebuildTheIpAddressPool({ fn }) {
  const toast = useToast();
  const { data, meta, loading, error, refetch } = useApi('/ip/pool');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);

  const rebuild = async () => {
    setBusy(true); setRunError(null); setResult(null);
    try {
      const { data: res } = await api.post('/ip/pool/rebuild');
      setResult(res);
      toast.success(`Pool rebuilt: ${res.total} address(es), ${res.added.length} imported`);
      refetch();
    } catch (err) { setRunError(err); toast.error(err); } finally { setBusy(false); }
  };

  const states = (data || []).reduce((acc, p) => { acc[p.state] = (acc[p.state] || 0) + 1; return acc; }, {});
  return (
    <>
      <PageHeader fn={fn} description="Compares the addresses bound to the host (ip -j addr) with the panel's inventory: imports addresses the panel did not know about, refreshes interfaces and netmasks, re-detects the main IP and recomputes which addresses are free, shared, dedicated, reserved or missing." />
      <Iproute2Notice meta={meta} />
      <Card title="Rebuild">
        <p className="muted">Last rebuild: {meta?.lastRebuild ? formatDate(meta.lastRebuild) : 'never'}. Nothing is removed from the host; addresses recorded in the panel but absent from the interfaces are flagged as "not on host". DHCP/SLAAC leases and IPv6 privacy addresses are imported as dynamic: shown, but never re-added at boot nor handed to accounts.</p>
        <FormActions><Button variant="primary" loading={busy} onClick={rebuild}>Rebuild the IP address pool</Button></FormActions>
        <IpRequestError error={runError} />
        {result && (
          <div className="action-result">
            <KeyValue items={[
              ['Main IP', result.main ? <code key="m">{result.main}</code> : 'not detected'],
              ['Source', result.source === 'iproute2' ? 'ip -j addr' : 'OS view'],
              ['Imported from host', result.added.length ? result.added.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : 'none'],
              ['Dynamic (DHCP / SLAAC / privacy), not persisted', result.unmanaged?.length ? result.unmanaged.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : 'none'],
              ['Interface/netmask refreshed', result.updated.length || 'none'],
              ['Recorded but not on host', result.missing.length ? result.missing.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : 'none'],
              ['Dynamic addresses that left the host (forgotten)', result.dropped?.length ? result.dropped.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : 'none'],
              ['Boot persistence', <StatusPill key="p" status={result.persisted?.skipped ? 'disabled' : result.persisted?.enabled ? 'ok' : 'warning'}>{result.persisted?.skipped ? 'disabled' : result.persisted?.enabled ? 'whm-ips.service enabled' : result.persisted?.error || 'written'}</StatusPill>],
            ]} />
          </div>
        )}
      </Card>
      <IpRequestError error={error} onRetry={refetch} />
      {data && <Summary items={[['Total', data.length], ['Main', states.main || 0], ['Shared', states.shared || 0], ['Dedicated', states.dedicated || 0], ['Reserved', states.reserved || 0], ['Free', states.free || 0], ['Dynamic', states.unmanaged || 0], ['Not on host', states.missing || 0]]} />}
      <Card title="IP address pool" subtitle="State of every address after the last rebuild" padded={false}>
        <DataTable
          columns={[
            { key: 'address', label: 'Address', render: (r) => <code>{r.address}</code> },
            { key: 'family', label: 'Family', render: (r) => <FamilyPill family={r.family} /> },
            { key: 'interface', label: 'Interface' },
            { key: 'state', label: 'State', render: (r) => <AddressStatusPill status={r.state} /> },
            { key: 'account', label: 'Account', render: (r) => r.account || <span className="muted">—</span> },
            { key: 'on_system', label: 'On host', render: (r) => <StatusPill status={r.on_system ? 'up' : 'down'}>{r.on_system ? 'yes' : 'no'}</StatusPill> },
            { key: 'synced_at', label: 'Synced', render: (r) => formatDate(r.synced_at) },
          ]}
          rows={data || []} loading={loading} rowKey={(r) => r.address} dense emptyText="The pool has not been built yet."
        />
      </Card>
    </>
  );
}
