import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';

export default function SynchronizeDnsRecords({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/dns/sync');
  const [clusterId, setClusterId] = useState('');
  const [domains, setDomains] = useState('');
  const [jobId, setJobId] = useState(null);
  const [runError, setRunError] = useState(null);
  const [busy, setBusy] = useState(false);
  const peers = (data?.clusters || []).filter((c) => c.enabled && c.role !== 'standalone');

  const run = async () => {
    setBusy(true); setRunError(null);
    try {
      const body = {};
      if (clusterId) body.clusterId = Number(clusterId);
      const list = domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (list.length) body.domains = list;
      const { data: res } = await api.post('/dns/sync', body);
      setJobId(res.job.id);
    } catch (err) { setRunError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Pushes zones to the nameservers in your DNS cluster over their panel API, so every peer serves the same records. Synchronisation is push-only in this version: peers in the 'sync' role receive zones like 'write-only' ones, and changes made on a peer are not pulled back. The hourly run only sends zones a peer has not acknowledged at their current serial; this page pushes everything you select." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <ErrorBanner error={error} onRetry={refetch} />
      <Card title="Cluster peers" padded={false}>
        {data && !data.clusters.length ? (
          <EmptyState title="No DNS cluster peers configured">Add nameservers under <Link to="/clusters/dns-cluster">Clusters → DNS Cluster</Link>; each needs the peer's address and an API token for its root user.</EmptyState>
        ) : (
          <DataTable
            columns={[
              { key: 'name', label: 'Peer' },
              { key: 'remote_host', label: 'Host', render: (c) => <code>{c.remote_host}</code> },
              { key: 'role', label: 'Role', render: (c) => <StatusPill status="info">{c.role}</StatusPill> },
              { key: 'enabled', label: 'Enabled', render: (c) => <StatusPill status={c.enabled ? 'enabled' : 'disabled'}>{c.enabled ? 'yes' : 'no'}</StatusPill> },
              { key: 'has_token', label: 'API token', render: (c) => <StatusPill status={c.has_token ? 'ok' : 'warning'}>{c.has_token ? 'set' : 'missing'}</StatusPill> },
              { key: 'last_sync_at', label: 'Last sync', render: (c) => formatDate(c.last_sync_at) },
            ]}
            rows={data?.clusters || []} loading={loading} rowKey={(c) => c.id} dense
          />
        )}
      </Card>
      <Card title="Synchronise now">
        <ErrorBanner error={runError} />
        <div className="form-grid">
          <Field label="Peer" help="Blank pushes to every enabled peer"><Select value={clusterId} onChange={setClusterId} options={peers.map((c) => ({ value: String(c.id), label: `${c.name} (${c.remote_host})` }))} placeholder="All peers" /></Field>
          <Field label="Zones" help="Comma-separated; blank pushes every zone"><TextInput value={domains} onChange={setDomains} placeholder="example.com, example.net" /></Field>
        </div>
        <FormActions><Button variant="primary" loading={busy} onClick={run} disabled={!peers.length}>Synchronise DNS records</Button></FormActions>
        {jobId && <ProgressLog jobId={jobId} onFinished={() => { refetch(); toast.success('Synchronisation finished'); }} />}
      </Card>
      <Card title="Zone sync status" subtitle="Outcome of the last push for each zone and peer" padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Zone', render: (r) => <Link to={`/dns-functions/dns-zone-manager?domain=${r.domain}`}><code>{r.domain}</code></Link> },
            { key: 'cluster', label: 'Peer' },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.status === 'ok' ? (r.stale ? 'warning' : 'ok') : 'failed'}>{r.status === 'ok' ? (r.stale ? 'stale' : 'in sync') : 'failed'}</StatusPill> },
            { key: 'serial', label: 'Pushed serial', render: (r) => <code>{r.serial}</code> },
            { key: 'current_serial', label: 'Current serial', render: (r) => <code>{r.current_serial}</code> },
            { key: 'message', label: 'Message', render: (r) => r.message || '' },
            { key: 'synced_at', label: 'When', render: (r) => formatDate(r.synced_at) },
          ]}
          rows={data?.zones || []} loading={loading} rowKey={(r) => `${r.zone_id}-${r.cluster_id}`} dense emptyText="Nothing has been synchronised yet."
        />
      </Card>
    </>
  );
}
