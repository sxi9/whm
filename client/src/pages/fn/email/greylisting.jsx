import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, Tabs, EximNotice, ApplyBadge, IncludeHint, applyMessage, useMailStatus } from '../../email/Shared.jsx';

const KINDS = [{ value: 'host', label: 'Sending host / network' }, { value: 'sender_domain', label: 'Sender domain' }, { value: 'recipient_domain', label: 'Recipient domain (opt out a hosted domain)' }];

function Triplets() {
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const { data, loading, error, refetch } = useApi(`/email/greylist/triplets?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const purge = async (all) => {
    if (!(await confirm({ title: all ? 'Delete every greylist record?' : 'Purge expired records?', message: all ? 'Every sender will be greylisted again on its next attempt.' : 'Removes records older than the configured expiry.', confirmLabel: all ? 'Delete all' : 'Purge', danger: all }))) return;
    try { const { data: res } = await api.delete(`/email/greylist/triplets${all ? '?all=true' : ''}`); toast.success(`${res.deleted} record(s) deleted`); refetch(); } catch (err) { toast.error(err); }
  };
  return (
    <Card title="Greylist records" subtitle={data?.backend === 'sqlite' ? `${data.total} triplet(s) in the Exim SQLite database` : data?.backend === 'greylistd' ? 'Managed by greylistd' : 'No backend'} padded={false}
      actions={<><Button size="sm" onClick={() => purge(false)}>Purge expired</Button><Button size="sm" variant="danger" onClick={() => purge(true)}>Delete all</Button></>}>
      <RequestError error={error} onRetry={refetch} />
      {data?.stats && <pre className="log" style={{ margin: 12 }}>{data.stats}</pre>}
      {data?.reason && <p className="muted" style={{ padding: 12 }}>{data.reason}</p>}
      <DataTable
        columns={[
          { key: 'sender', label: 'Sender', render: (t) => <code>{t.sender || '<>'}</code> },
          { key: 'recipient', label: 'Recipient', render: (t) => <code>{t.recipient}</code> },
          { key: 'host', label: 'Host', render: (t) => <code>{t.host}</code> },
          { key: 'passed', label: 'State', render: (t) => <StatusPill status={t.passed ? 'ok' : 'pending'}>{t.passed ? 'passed' : 'waiting'}</StatusPill> },
          { key: 'count', label: 'Attempts', align: 'right' },
          { key: 'firstSeen', label: 'First seen', render: (t) => formatDate(t.firstSeen) },
          { key: 'lastSeen', label: 'Last seen', render: (t) => formatDate(t.lastSeen) },
        ]}
        rows={data?.triplets || []} loading={loading} rowKey={(t) => `${t.sender}|${t.recipient}|${t.host}`} dense emptyText="No greylist records yet."
        searchable q={q} onSearch={setQ} searchPlaceholder="Filter sender, recipient or host"
      />
    </Card>
  );
}

export default function Greylisting({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, refetch: refetchStatus } = useMailStatus();
  const { data, loading, error, refetch } = useApi('/email/greylist');
  const [tab, setTab] = useState('settings');
  const [draft, setDraft] = useState(null);
  const [trusted, setTrusted] = useState({ kind: 'host', value: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const [lastApply, setLastApply] = useState(null);
  useEffect(() => { if (data) setDraft(data.settings); }, [data]);
  const done = (res, verb) => { setLastApply(res.apply); toast[res.apply?.applied ? 'success' : 'warning'](applyMessage(res.apply, verb)); refetch(); };
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (draft.enabled && !data.settings.enabled && !(await confirm({ title: 'Enable greylisting?', message: 'Unknown senders receive a temporary 451 error and must retry; legitimate mail is delayed by the initial deferral on first contact. Authenticated users and trusted hosts are exempt.', confirmLabel: 'Enable' }))) return;
    setBusy(true);
    try { const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== data.settings[k])); const { data: res } = await api.put('/email/greylist/settings', changed); done(res, 'Greylisting settings saved'); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const addTrusted = async () => {
    setBusy(true);
    try { const { data: res } = await api.post('/email/greylist/trusted', { kind: trusted.kind, value: trusted.value.trim(), ...(trusted.comment.trim() ? { comment: trusted.comment.trim() } : {}) }); done(res, `${trusted.value} trusted`); setTrusted({ kind: trusted.kind, value: '', comment: '' }); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const removeTrusted = async (t) => { setBusy(true); try { const { data: res } = await api.delete(`/email/greylist/trusted/${t.id}`); done(res, `${t.value} removed`); } catch (err) { toast.error(err); } finally { setBusy(false); } };

  const be = data?.backend;
  const dirty = draft && data && JSON.stringify(draft) !== JSON.stringify(data.settings);
  return (
    <>
      <PageHeader fn={fn} description="Temporarily rejects mail from sender/recipient/host triplets it has never seen; real mail servers retry after a few minutes while most spam engines do not. Runs inside Exim's acl_check_rcpt using Exim's own SQLite lookup or Debian's greylistd." />
      <EximNotice status={status} onRetry={refetchStatus} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Status">
            <KeyValue items={[
              ['Greylisting', <StatusPill key="s" status={data.settings.enabled ? 'enabled' : 'disabled'} />],
              ['Backend', be?.backend ? <span key="b"><StatusPill status="ok">{be.backend}</StatusPill> {be.dbFile && <code>{be.dbFile}</code>}{be.socket && <code>{be.socket}</code>}</span> : <span key="n"><StatusPill status="not-installed">none</StatusPill> <span className="muted">{be?.reason}</span></span>],
              ['Exim', <ApplyBadge key="a" apply={lastApply || data.lastApply} />],
            ]} />
            <IncludeHint apply={lastApply || data.lastApply} />
          </Card>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'settings', label: 'Settings' }, { value: 'trusted', label: 'Trusted (exempt)', count: data.trusted.length }, { value: 'records', label: 'Records' }]} />
          {tab === 'settings' && (
            <Card title="Settings">
              <Field inline><Toggle checked={draft.enabled} onChange={set('enabled')} label="Enable greylisting" description={be?.backend ? `Using the ${be.backend} backend` : 'Needs greylistd or an Exim built with SQLite lookups plus sqlite3'} disabled={!be?.backend && !draft.enabled} /></Field>
              <div className="form-grid">
                <Field label="Initial deferral (minutes)" help="How long a new triplet is rejected before a retry is accepted"><NumberInput value={draft.initialDelayMinutes} onChange={set('initialDelayMinutes')} min={1} max={1440} nullable={false} /></Field>
                <Field label="Must retry within (hours)" help="A retry later than this starts over"><NumberInput value={draft.mustRetryHours} onChange={set('mustRetryHours')} min={1} max={168} nullable={false} /></Field>
                <Field label="Records expire after (days)" help="Known-good triplets are forgotten after this long without mail"><NumberInput value={draft.recordExpiresDays} onChange={set('recordExpiresDays')} min={1} max={365} nullable={false} /></Field>
                <Field label="Deferral message" help="Sent in the SMTP 451 response"><TextInput value={draft.message} onChange={set('message')} /></Field>
              </div>
              <FormActions><Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button><Button disabled={!dirty} onClick={() => setDraft(data.settings)}>Reset</Button></FormActions>
            </Card>
          )}
          {tab === 'trusted' && (
            <>
              <Card title="Trusted hosts and domains" subtitle="Never greylisted" padded={false}>
                <DataTable
                  columns={[{ key: 'kind', label: 'Type', render: (t) => KINDS.find((k) => k.value === t.kind)?.label }, { key: 'value', label: 'Value', render: (t) => <code>{t.value}</code> }, { key: 'comment', label: 'Comment' }, { key: 'created_at', label: 'Added', render: (t) => formatDate(t.created_at) }]}
                  rows={data.trusted} rowKey={(t) => t.id} dense emptyText="Nothing is exempt yet." rowActions={(t) => [{ label: 'Remove', primary: true, danger: true, onClick: () => removeTrusted(t) }]}
                />
              </Card>
              <Card title="Add an exemption">
                <div className="form-grid">
                  <Field label="Type"><Select value={trusted.kind} onChange={(v) => setTrusted((t) => ({ ...t, kind: v }))} options={KINDS} /></Field>
                  <Field label="Value" help={trusted.kind === 'host' ? 'IP, CIDR network or host name' : 'Domain name'}><TextInput value={trusted.value} onChange={(v) => setTrusted((t) => ({ ...t, value: v }))} placeholder={trusted.kind === 'host' ? '203.0.113.0/24' : 'gmail.com'} /></Field>
                  <Field label="Comment (optional)"><TextInput value={trusted.comment} onChange={(v) => setTrusted((t) => ({ ...t, comment: v }))} /></Field>
                </div>
                <FormActions><Button variant="primary" loading={busy} disabled={!trusted.value.trim()} onClick={addTrusted}>Add</Button></FormActions>
              </Card>
            </>
          )}
          {tab === 'records' && <Triplets />}
        </>
      )}
    </>
  );
}
