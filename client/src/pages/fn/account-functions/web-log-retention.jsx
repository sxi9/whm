import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';

function EditModal({ row, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ archiveLogs: row.archive_logs, removeOldArchives: row.remove_old_archives, retainMonths: row.retain_months });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.put(`/account-functions/log-retention/${row.username}`, form); toast.success(`Log retention saved for ${row.username}`); onSaved(); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Web log retention: ${row.username}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <ErrorBanner error={error} />
      <Field inline><Toggle checked={form.archiveLogs} onChange={(v) => setForm((f) => ({ ...f, archiveLogs: v }))} label="Archive logs in the home directory" description={`Each month the Apache logs in ${row.log_dir} are copied to ${row.archive_dir}/<YYYY-MM>, owned by the account.`} /></Field>
      <Field inline><Toggle checked={form.removeOldArchives} onChange={(v) => setForm((f) => ({ ...f, removeOldArchives: v }))} label="Remove old archives" description="Delete archives older than the retention period." /></Field>
      <Field label="Keep archives for (months)" error={error?.fields?.retainMonths}><NumberInput value={form.retainMonths} onChange={(v) => setForm((f) => ({ ...f, retainMonths: v ?? 1 }))} min={1} max={120} nullable={false} /></Field>
    </Modal>
  );
}

export default function WebLogRetention({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/account-functions/log-retention');
  const [editing, setEditing] = useState(null);
  const [job, setJob] = useState(null);
  const [runError, setRunError] = useState(null);
  const [busy, setBusy] = useState(false);

  const archiveNow = async (username) => {
    setBusy(true); setRunError(null);
    try { const { data: res } = await api.post('/account-functions/log-retention/archive', username ? { username } : {}); setJob(res.job.id); toast.success(username ? `Archiving ${username}'s logs` : 'Archiving every account with archiving enabled'); } catch (err) { setRunError(err); toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Per-account policy for the raw Apache logs: whether a monthly archive is kept in the account's ~/logs/archive and for how long. Rotation of the live logs is configured under Service Configuration → cPanel Log Rotation Configuration. The archive job runs on the 1st of each month." actions={<Button variant="primary" loading={busy} onClick={() => archiveNow()}>Archive now (all enabled)</Button>} />
      <CapabilityNotice error={runError} />
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Owner' },
            { key: 'archive_logs', label: 'Archive', render: (r) => <StatusPill status={r.archive_logs ? 'enabled' : 'disabled'}>{r.archive_logs ? 'monthly' : 'off'}</StatusPill> },
            { key: 'retain_months', label: 'Keep', render: (r) => (r.archive_logs ? `${r.retain_months} month(s)${r.remove_old_archives ? '' : ' (never pruned)'}` : <span className="muted">—</span>) },
            { key: 'last_archived_at', label: 'Last archived', render: (r) => formatDate(r.last_archived_at) },
            { key: 'configured', label: 'Source', render: (r) => <span className="muted">{r.configured ? 'account setting' : 'server default'}</span> },
          ]}
          rows={data?.accounts || []} loading={loading} rowKey={(r) => r.username} dense
          rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setEditing(r) }, { label: 'Archive now', onClick: () => archiveNow(r.username) }]}
        />
      </Card>
      {job && <Card title="Archive job"><ProgressLog jobId={job} onFinished={() => refetch()} /></Card>}
      {editing && <EditModal row={editing} onClose={() => setEditing(null)} onSaved={refetch} />}
    </>
  );
}
