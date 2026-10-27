import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, Select, TextInput, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PeerTable } from './PeerTable.jsx';
import { ClusterTokens } from './ClusterTokens.jsx';
import { ExchangeLog } from './ExchangeLog.jsx';

export function DnsCluster() {
  const toast = useToast();
  const overview = useApi('/clusters/dns');
  const [logVersion, setLogVersion] = useState(0);
  const data = overview.data;
  const refreshAll = () => { overview.refetch(); setLogVersion((v) => v + 1); };

  if (overview.loading && !data) return <Loading />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.refetch} />;

  return (
    <>
      {!data.dnsModule && <CapabilityNotice error={{ code: 'capability_missing', message: 'The DNS Functions module is not loaded on this panel, so zones can be neither pushed nor received. Peers and tokens can still be managed.' }} onRetry={refreshAll} />}
      {data.dnsModule && !data.bind && (
        <div className="banner banner-info"><div><strong>BIND is not installed here.</strong><p>Zones live in the panel database and are still pushed to peers; this server starts serving them itself once BIND is installed (<Link to="/software/install-distro-packages">Install Distro Packages</Link>).</p></div></div>
      )}
      <PeerTable peers={data.peers} roles={data.roles} loading={overview.loading} onChanged={refreshAll} focus="dns"
        subtitle={`Other servers running this panel. ${data.hostname} pushes its zones to every enabled write-only or sync peer over the peer's own API.`} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, alignItems: 'start' }}>
        <SyncNow peers={data.peers} onStarted={refreshAll} />
        <DnsSettings settings={data.settings} schedule={data.schedule} dnsModule={data.dnsModule} onSaved={refreshAll} />
      </div>
      <ClusterTokens tokens={data.tokens} hostname={data.hostname} purpose="dns" onChanged={refreshAll} />
      <Card title="Zone status per peer" subtitle="The serial each peer last acknowledged. Stale zones are re-sent by the hourly run; a failed push shows the peer's answer. Pushes replicate existing zones only: a zone deleted here stays on the peers until it is removed there, and a sync peer's zones reach this server only when that peer pushes them." padded={false}>
        <DataTable dense rows={data.zones} rowKey={(r) => `${r.zone_id}-${r.cluster_id}`} emptyText="Nothing has been pushed yet."
          columns={[
            { key: 'domain', label: 'Zone' },
            { key: 'cluster', label: 'Peer' },
            { key: 'serial', label: 'Serial sent / current', render: (r) => <>{r.serial ?? '—'} / {r.current_serial}</> },
            { key: 'status', label: 'Status', render: (r) => <>{r.stale ? <StatusPill status="warning">stale</StatusPill> : <StatusPill status={r.status} />}{r.message && <><br /><small className="muted">{r.message}</small></>}</> },
            { key: 'synced_at', label: 'Last push', render: (r) => formatDate(r.synced_at) },
          ]}
        />
      </Card>
      <ExchangeLog kinds={['peer.test', 'dns.receive']} version={logVersion} />
    </>
  );
}

function SyncNow({ peers, onStarted }) {
  const [clusterId, setClusterId] = useState('');
  const [domains, setDomains] = useState('');
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const targets = peers.filter((p) => p.enabled && p.role !== 'standalone');

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = {};
      if (clusterId) body.clusterId = Number(clusterId);
      const list = domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
      if (list.length) body.domains = list;
      const { data } = await api.post('/clusters/dns/sync', body);
      setJobId(data.job.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Card title="Push zones now" subtitle="Re-sends zones regardless of what the peer already acknowledged.">
      <ErrorBanner error={error} />
      <Field label="Peer" help="Blank pushes to every enabled write-only or sync peer."><Select value={clusterId} onChange={setClusterId} placeholder="All peers" options={targets.map((p) => ({ value: String(p.id), label: `${p.name} (${p.host})` }))} /></Field>
      <Field label="Zones" help="Comma-separated; blank pushes every zone."><TextInput value={domains} onChange={setDomains} placeholder="example.com, example.net" /></Field>
      <FormActions>
        <Button variant="primary" icon={RefreshCw} loading={busy} onClick={run} disabled={!targets.length}>Push zones</Button>
        {!targets.length && <span className="muted">Add an enabled write-only or sync peer first.</span>}
      </FormActions>
      <ProgressLog jobId={jobId} onFinished={onStarted} />
    </Card>
  );
}

function DnsSettings({ settings, schedule, dnsModule, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    try {
      const body = {};
      for (const k of ['verifyTls', 'autoSync', 'acceptPushes']) if (draft[k] !== settings[k]) body[k] = draft[k];
      await api.put('/clusters/dns/settings', body);
      toast.success('DNS cluster settings saved');
      onSaved?.();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="DNS cluster settings">
      <Field inline><Toggle checked={draft.autoSync} onChange={(v) => setDraft((d) => ({ ...d, autoSync: v }))} disabled={!dnsModule} label="Push changed zones automatically" description={schedule ? `Hourly (${schedule.cron}); only zones a peer has not acknowledged at their current serial. Next run ${formatDate(schedule.nextRunAt)}.` : 'The DNS module provides the schedule.'} /></Field>
      <Field inline><Toggle checked={draft.acceptPushes} onChange={(v) => setDraft((d) => ({ ...d, acceptPushes: v }))} label="Accept zones pushed by peers" description="Off refuses token-authenticated zone pushes on both the cluster endpoint and the DNS module's zone import that peers' sync jobs use; a root session importing a zone by hand is unaffected." /></Field>
      <Field inline><Toggle checked={draft.verifyTls} onChange={(v) => setDraft((d) => ({ ...d, verifyTls: v }))} label="Verify peer TLS certificates on zone pushes" description="Applies to the hourly and manual zone pushes to every peer; the per-peer toggle covers connectivity tests and settings exchanges." /></Field>
      <KeyValue items={[['Last scheduled run', formatDate(schedule?.lastRunAt)], ['Schedule', schedule ? <StatusPill status={schedule.enabled ? 'enabled' : 'disabled'}>{schedule.enabled ? 'enabled' : 'paused'}</StatusPill> : '—']]} />
      <FormActions><Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save settings</Button></FormActions>
    </Card>
  );
}
