import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Download } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PeerTable } from './PeerTable.jsx';
import { ExchangeLog } from './ExchangeLog.jsx';

export function ConfigurationCluster() {
  const overview = useApi('/clusters/config');
  const [logVersion, setLogVersion] = useState(0);
  const data = overview.data;
  const refreshAll = () => { overview.refetch(); setLogVersion((v) => v + 1); };

  if (overview.loading && !data) return <Loading />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.refetch} />;

  return (
    <>
      <PeerTable peers={data.peers} loading={overview.loading} onChanged={refreshAll} focus="config"
        subtitle={`Peers with "Receives config" on get the shared settings of ${data.hostname} when you push. A peer that should push to this server needs a token from Clusters > DNS Cluster.`} />
      <GroupSelection groups={data.groups} settings={data.settings} schedule={data.schedule} keyCount={data.keyCount} onSaved={refreshAll} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, alignItems: 'start' }}>
        <PushCard peers={data.peers} groups={data.groups} selected={data.selectedGroups} onFinished={refreshAll} />
        <PullCard peers={data.peers} groups={data.groups} selected={data.selectedGroups} onApplied={refreshAll} />
      </div>
      <ExchangeLog kinds={['config.push', 'config.pull', 'config.receive', 'config.export', 'peer.test']} version={logVersion} />
    </>
  );
}

function KeyList({ keys }) {
  const [open, setOpen] = useState(false);
  if (!keys?.length) return <span className="muted">—</span>;
  const shown = open ? keys : keys.slice(0, 3);
  return (
    <span style={{ fontSize: 12 }}>
      <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{shown.join(', ')}</code>
      {keys.length > 3 && <> <button type="button" className="link-button" onClick={() => setOpen((v) => !v)}>{open ? 'fewer' : `+${keys.length - 3} more`}</button></>}
    </span>
  );
}

const RESULT_STATUS = { applied: 'ok', stored: 'warning', failed: 'failed' };
const RESULT_LABEL = { applied: 'applied', stored: 'stored, daemon missing', failed: 'failed' };

// Per-key outcome of an apply on this server or a peer.
function ApplyResults({ results }) {
  const rows = Object.entries(results || {}).map(([key, r]) => ({ key, ...r }));
  if (!rows.length) return null;
  return (
    <DataTable dense rows={rows} rowKey={(r) => r.key} emptyText="Nothing applied."
      columns={[
        { key: 'key', label: 'Setting', render: (r) => <code style={{ fontSize: 12 }}>{r.key}</code> },
        { key: 'status', label: 'Outcome', render: (r) => <StatusPill status={RESULT_STATUS[r.status] || r.status}>{RESULT_LABEL[r.status] || r.status}</StatusPill> },
        { key: 'via', label: 'Through', render: (r) => (r.via ? <code style={{ fontSize: 12 }}>{r.via}</code> : <span className="muted">settings database</span>) },
        { key: 'note', label: 'Details', render: (r) => <span style={{ wordBreak: 'break-word' }}>{r.note || (r.stored ? 'saved' : '—')}</span> },
      ]}
    />
  );
}

function GroupSelection({ groups, settings, schedule, keyCount, onSaved }) {
  const toast = useToast();
  const initial = () => ({ groups: settings.groups, autoPush: settings.autoPush, acceptPushes: settings.acceptPushes });
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(initial()); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial());
  const toggleGroup = (name) => setDraft((d) => ({ ...d, groups: d.groups.includes(name) ? d.groups.filter((g) => g !== name) : [...d.groups, name] }));

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/clusters/config/settings', draft);
      toast.success('Configuration cluster settings saved');
      onSaved?.();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Shared settings" subtitle="Which groups of settings travel between peers. Only the keys listed per group are ever sent or accepted; host identity, addresses, daemon selection, per-host paths, timestamps and secrets never leave a server, and a receiving peer validates every value and applies it through the module that owns it." padded={false}
      actions={<Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={save}>Save</Button>}>
      <DataTable dense rows={groups} rowKey={(g) => g.name}
        columns={[
          { key: 'share', label: 'Share', width: 60, render: (g) => <input type="checkbox" checked={draft.groups.includes(g.name)} onChange={() => toggleGroup(g.name)} aria-label={`Share ${g.label}`} /> },
          { key: 'label', label: 'Group', render: (g) => <><strong>{g.label}</strong><br /><small className="muted">{g.description}</small></> },
          { key: 'keyCount', label: 'Settings', align: 'right', render: (g) => (g.keyCount ? g.keyCount : <span className="muted">none yet</span>) },
          { key: 'keys', label: 'Keys', render: (g) => <KeyList keys={g.keys} /> },
        ]}
      />
      <div className="card-body">
        <div className="form-grid">
          <Field inline><Toggle checked={draft.autoPush} onChange={(v) => setDraft((d) => ({ ...d, autoPush: v }))} label="Push automatically" description={schedule ? `Every six hours (${schedule.cron}) to every peer that receives config. Next run ${formatDate(schedule.nextRunAt)}.` : 'Every six hours.'} /></Field>
          <Field inline><Toggle checked={draft.acceptPushes} onChange={(v) => setDraft((d) => ({ ...d, acceptPushes: v }))} label="Accept settings pushed by peers" description="A peer holding a cluster token issued here may overwrite the shared groups on this server." /></Field>
        </div>
        <KeyValue items={[['Settings in the selected groups', keyCount], ['Last push from here', formatDate(settings.lastPushAt)], ['Last pull into here', formatDate(settings.lastPullAt)], ['Schedule', schedule ? <StatusPill status={schedule.enabled ? 'enabled' : 'disabled'}>{schedule.enabled ? 'enabled' : 'paused'}</StatusPill> : '—']]} />
      </div>
    </Card>
  );
}

function PushCard({ peers, groups, selected, onFinished }) {
  const confirm = useConfirm();
  const [clusterId, setClusterId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const targets = peers.filter((p) => p.enabled && p.configEnabled);

  const run = async () => {
    const who = clusterId ? targets.find((p) => String(p.id) === clusterId)?.name : `${targets.length} peer${targets.length === 1 ? '' : 's'}`;
    const what = groupName ? groups.find((g) => g.name === groupName)?.label : `the ${selected.length} selected group${selected.length === 1 ? '' : 's'}`;
    if (!(await confirm({ title: `Push ${what} to ${who}?`, message: 'Each peer validates every value, refuses keys it does not know, and applies the rest through the module that owns them (Apache, Exim, Dovecot, backups, ...). The job log shows, per peer, what was applied, what was only stored because a daemon is missing, and what failed.', confirmLabel: 'Push' }))) return;
    setBusy(true);
    setError(null);
    try {
      const body = {};
      if (clusterId) body.clusterIds = [Number(clusterId)];
      if (groupName) body.groups = [groupName];
      const { data } = await api.post('/clusters/config/push', body);
      setJobId(data.job.id);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Card title="Push to peers" subtitle="Send this server's shared settings to peers that receive config.">
      <ErrorBanner error={error} />
      <Field label="Peer" help="Blank pushes to every peer that receives config."><Select value={clusterId} onChange={setClusterId} placeholder="All config peers" options={targets.map((p) => ({ value: String(p.id), label: `${p.name} (${p.host})` }))} /></Field>
      <Field label="Group" help="Blank pushes every selected group."><Select value={groupName} onChange={setGroupName} placeholder="All selected groups" options={groups.map((g) => ({ value: g.name, label: g.label }))} /></Field>
      <FormActions>
        <Button variant="primary" icon={Upload} loading={busy} onClick={run} disabled={!targets.length || (!groupName && !selected.length)}>Push settings</Button>
        {!targets.length && <span className="muted">Turn on "Share config" for a peer first.</span>}
      </FormActions>
      <ProgressLog jobId={jobId} onFinished={onFinished} />
    </Card>
  );
}

function PullCard({ peers, groups, selected, onApplied }) {
  const toast = useToast();
  const [clusterId, setClusterId] = useState('');
  const [groupName, setGroupName] = useState('');
  const [preview, setPreview] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const sources = peers.filter((p) => p.enabled && p.hasToken);

  const pull = async (apply) => {
    setBusy(true);
    setError(null);
    try {
      const body = { clusterId: Number(clusterId), apply };
      if (groupName) body.groups = [groupName];
      const { data } = await api.post('/clusters/config/pull', body);
      if (apply) {
        const statuses = Object.values(data.results || {}).map((r) => r.status);
        const n = (st) => statuses.filter((x) => x === st).length;
        const summary = `${n('applied')} applied, ${n('stored')} stored (daemon missing), ${n('failed')} failed from ${data.source || data.peer.name}`;
        if (n('failed')) toast.warning(summary); else toast.success(summary);
        setPreview(null);
        setOutcome(data);
        onApplied?.();
      } else setPreview(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Card title="Pull from a peer" subtitle="Fetch a peer's shared settings, review the differences, then apply them here.">
      <ErrorBanner error={error} />
      {outcome && (
        <details open style={{ marginBottom: 12 }}>
          <summary>Last pull from {outcome.source || outcome.peer?.name}: per-key outcome</summary>
          <ApplyResults results={outcome.results} />
        </details>
      )}
      <Field label="Peer" required><Select value={clusterId} onChange={setClusterId} placeholder="Choose a peer" options={sources.map((p) => ({ value: String(p.id), label: `${p.name} (${p.host})` }))} /></Field>
      <Field label="Group" help="Blank pulls every selected group."><Select value={groupName} onChange={setGroupName} placeholder="All selected groups" options={groups.map((g) => ({ value: g.name, label: g.label }))} /></Field>
      <FormActions>
        <Button variant="primary" icon={Download} loading={busy} onClick={() => pull(false)} disabled={!clusterId || (!groupName && !selected.length)}>Preview differences</Button>
        {!sources.length && <span className="muted">Add a peer with an API token first. Peers need the Clusters module; see <Link to="/clusters/dns-cluster">DNS Cluster</Link> for tokens.</span>}
      </FormActions>
      <Modal open={Boolean(preview)} title={`Differences from ${preview?.source || preview?.peer?.name || 'peer'}`} onClose={() => setPreview(null)} size="lg"
        footer={(
          <>
            <Button onClick={() => setPreview(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!preview?.changes?.length} onClick={() => pull(true)}>Apply {preview?.changes?.length || 0} change{preview?.changes?.length === 1 ? '' : 's'}</Button>
          </>
        )}>
        {preview && (
          <>
            <p className="muted">{preview.received} settings received for {preview.groups.join(', ')}; {preview.changes.length} differ from this server{preview.rejected.length ? `; ${preview.rejected.length} refused: ${preview.rejected.map((k) => `${k} (${preview.rejections?.[k] || 'not shared'})`).join(', ')}` : ''}. Applying hands each change to the module that owns it; values a daemon cannot take yet are stored until it is installed.</p>
            <DataTable dense rows={preview.changes} rowKey={(c) => c.key} emptyText="Already identical."
              columns={[
                { key: 'key', label: 'Setting', render: (c) => <code style={{ fontSize: 12 }}>{c.key}</code> },
                { key: 'local', label: 'Here', render: (c) => <code style={{ fontSize: 12 }}>{JSON.stringify(c.local)}</code> },
                { key: 'remote', label: 'Peer', render: (c) => <code style={{ fontSize: 12 }}>{JSON.stringify(c.remote)}</code> },
                { key: 'apply', label: 'Applied through', render: (c) => (c.apply ? <code style={{ fontSize: 12 }}>{c.apply}</code> : <span className="muted">settings database</span>) },
              ]}
            />
          </>
        )}
      </Modal>
    </Card>
  );
}
