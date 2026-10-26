import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatBytes, formatDuration } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Button, Select, Field } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, StatGrid } from '../../email/Shared.jsx';

function MessageModal({ id, onClose }) {
  const { data, loading, error } = useApi(id ? `/email/queue/${id}` : null, { enabled: Boolean(id) });
  return (
    <Modal open={Boolean(id)} title={`Message ${id || ''}`} onClose={onClose} size="lg">
      <RequestError error={error} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && (
        <>
          <KeyValue items={[['Subject', data.subject], ['From', data.from], ['To', data.to]]} />
          <h3>Headers (exim -Mvh)</h3><pre className="log">{data.headers}</pre>
          <h3>Body (exim -Mvb){data.bodyTruncated ? ' — truncated' : ''}</h3><pre className="log">{data.body || '(empty)'}</pre>
          <h3>Delivery log (exim -Mvl)</h3><pre className="log">{data.log || '(no log yet)'}</pre>
        </>
      )}
    </Modal>
  );
}

export default function MailQueueManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const table = useTableState({ pageSize: 50 });
  const [frozen, setFrozen] = useState('');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [last, setLast] = useState(null);
  const [flushJob, setFlushJob] = useState(null);
  const path = `/email/queue${queryString({ ...table.state, frozen: frozen || undefined })}`;
  const { data, meta, loading, error, refetch } = useApi(path, { refreshMs: 30_000 });

  const act = async (kind, ids, { danger = false } = {}) => {
    if (!ids.length) return;
    const label = { deliver: 'Deliver now', freeze: 'Freeze', thaw: 'Thaw', remove: 'Delete' }[kind];
    if (kind === 'remove' && !(await confirm({ title: `Delete ${ids.length} message(s)?`, message: 'The messages are removed from the Exim spool and will never be delivered. This cannot be undone.', confirmLabel: 'Delete', danger: true, typeToConfirm: ids.length > 5 ? 'DELETE' : undefined }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post(`/email/queue/${kind}`, { ids });
      setLast(res);
      toast[res.ok ? 'success' : 'warning'](`${label}: ${res.results.filter((r) => r.ok).length}/${ids.length} ok`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const bulk = async (action, filter, message) => {
    if (!(await confirm({ title: `${action === 'remove' ? 'Delete' : 'Thaw'} matching messages?`, message, confirmLabel: action === 'remove' ? 'Delete' : 'Thaw', danger: action === 'remove' }))) return;
    setBusy(true);
    try { const { data: res } = await api.post('/email/queue/bulk', { action, ...filter }); setLast(res); toast.success(`${res.matched} message(s) matched, ${res.results.filter((r) => r.ok).length} ok`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  // A queue run lasts as long as the slowest remote host, so it is a job
  // followed live below instead of a request that would time out.
  const flush = async (force) => {
    if (!(await confirm({ title: force ? 'Force-flush the queue?' : 'Flush the queue?', message: force ? 'Runs exim -qff in the background: every message, including frozen ones, gets a delivery attempt now.' : 'Runs exim -qf in the background: every non-frozen message gets a delivery attempt now.', confirmLabel: 'Flush' }))) return;
    setBusy(true);
    try { const { data: res } = await api.post('/email/queue/flush', { force }); setFlushJob(res.job.id); toast.info('Queue run started'); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const flushFinished = (e) => {
    refetch();
    if (e.type !== 'done') { toast.error(e.error || 'Queue run failed'); return; }
    const r = e.result || {};
    setLast(r);
    toast[r.ok ? 'success' : 'warning'](`Queue run finished: ${r.delivered ?? 0} delivered, ${r.deferred ?? 0} deferred, ${r.failed ?? 0} failed`);
  };

  const rows = data || [];
  return (
    <>
      <PageHeader fn={fn} description="Messages waiting in the Exim spool (exim -bp). Search by id, sender or recipient, then deliver, freeze, thaw or delete them; flushing runs the whole queue now." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {meta && <StatGrid stats={[['In queue', meta.queueTotal], ['Frozen', meta.queueFrozen, meta.queueFrozen ? 'warn' : null], ['Matching', meta.total]]} />}
      <Card padded={false} actions={(
        <>
          <Button size="sm" variant="primary" loading={busy} disabled={!selected.length} onClick={() => act('deliver', selected)}>Deliver ({selected.length})</Button>
          <Button size="sm" loading={busy} disabled={!selected.length} onClick={() => act('freeze', selected)}>Freeze</Button>
          <Button size="sm" loading={busy} disabled={!selected.length} onClick={() => act('thaw', selected)}>Thaw</Button>
          <Button size="sm" variant="danger" loading={busy} disabled={!selected.length} onClick={() => act('remove', selected)}>Delete</Button>
        </>
      )}>
        <DataTable
          columns={[
            { key: 'id', label: 'Message id', render: (m) => <button className="link-button" onClick={() => setViewing(m.id)}><code>{m.id}</code></button> },
            { key: 'age', label: 'Age', sortable: true, render: (m) => formatDuration(m.ageSeconds) },
            { key: 'size', label: 'Size', sortable: true, render: (m) => formatBytes(m.sizeBytes) },
            { key: 'sender', label: 'Sender', sortable: true, render: (m) => <code>{m.sender}</code> },
            { key: 'recipients', label: 'Recipients', render: (m) => m.recipients.map((r) => <div key={r.address}><code>{r.address}</code>{r.delivered && <StatusPill status="ok">delivered</StatusPill>}</div>) },
            { key: 'frozen', label: 'State', render: (m) => <StatusPill status={m.frozen ? 'warning' : 'pending'}>{m.frozen ? 'frozen' : 'queued'}</StatusPill> },
          ]}
          rows={rows} loading={loading} total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
          sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
          searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search id, sender or recipient"
          selectable selected={selected} onSelectedChange={setSelected} rowKey={(m) => m.id} dense emptyText="The mail queue is empty."
          toolbar={<Field inline><Select value={frozen} onChange={(v) => { setFrozen(v); table.setPage(1); }} options={[{ value: 'true', label: 'Frozen only' }, { value: 'false', label: 'Not frozen' }]} placeholder="All messages" /></Field>}
          rowActions={(m) => [
            { label: 'View', primary: true, onClick: () => setViewing(m.id) },
            { label: 'Deliver now', onClick: () => act('deliver', [m.id]) },
            m.frozen ? { label: 'Thaw', onClick: () => act('thaw', [m.id]) } : { label: 'Freeze', onClick: () => act('freeze', [m.id]) },
            { label: 'Delete', danger: true, onClick: () => act('remove', [m.id]) },
          ]}
        />
      </Card>
      <Card title="Queue-wide actions">
        <div className="form-actions">
          <Button variant="primary" loading={busy} onClick={() => flush(false)}>Flush queue (exim -qf)</Button>
          <Button loading={busy} onClick={() => flush(true)}>Force flush incl. frozen (exim -qff)</Button>
          <Button loading={busy} onClick={() => bulk('thaw', { frozen: true }, 'Thaws every frozen message so Exim retries it on the next queue run.')}>Thaw all frozen</Button>
          <Button variant="danger" loading={busy} onClick={() => bulk('remove', { frozen: true }, 'Deletes every frozen message from the spool.')}>Delete all frozen</Button>
          <Button variant="danger" loading={busy} onClick={() => bulk('remove', { olderThanMinutes: 1440 }, 'Deletes every message that has been queued for more than 24 hours.')}>Delete older than 24 h</Button>
        </div>
        {flushJob && <div style={{ marginTop: 12 }}><ProgressLog jobId={flushJob} onFinished={flushFinished} /></div>}
        {last && <pre className="log" style={{ marginTop: 12 }}>{last.output || JSON.stringify({ ...last, output: undefined }, null, 2)}</pre>}
      </Card>
      <MessageModal id={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
