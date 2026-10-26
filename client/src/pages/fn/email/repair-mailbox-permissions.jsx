import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../email/Shared.jsx';

export default function RepairMailboxPermissions({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/email/mailbox/accounts');
  const [selected, setSelected] = useState([]);
  const [q, setQ] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async ({ usernames, all }) => {
    const n = all ? (data || []).length : usernames.length;
    if (!(await confirm({ title: `Repair ${n} mailbox(es)?`, message: 'Each account\'s ~/mail and ~/etc trees are chowned to the account user and reset to directories 0700 / files 0600. Mail delivery keeps working during the repair.', confirmLabel: 'Repair' }))) return;
    setBusy(true);
    try { const { data: res } = await api.post('/email/mailbox/repair', all ? { all: true } : { usernames }); setJob(res.job.id); setSelected([]); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const rows = (data || []).filter((a) => !q || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader fn={fn} description="Fixes mailbox trees whose ownership or modes were broken by restores, manual copies or scripts: ~/mail and ~/etc become user:user with 0700 directories and 0600 files, which is what Exim and Dovecot expect." actions={<Button variant="primary" loading={busy} disabled={!data?.length} onClick={() => run({ all: true })}>Repair all accounts</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {job && <Card title="Repair progress"><ProgressLog jobId={job} onFinished={(e) => toast[e.type === 'done' ? 'success' : 'error'](e.type === 'done' ? 'Mailbox permissions repaired' : e.error || 'Repair failed')} /></Card>}
      <Card padded={false} actions={<Button size="sm" variant="primary" loading={busy} disabled={!selected.length} onClick={() => run({ usernames: selected })}>Repair selected ({selected.length})</Button>}>
        <DataTable
          columns={[
            { key: 'username', label: 'Account', render: (a) => <code>{a.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Owner' },
            { key: 'homeDir', label: 'Mail tree', render: (a) => <code>{a.homeDir}/mail</code> },
            { key: 'suspended', label: 'State', render: (a) => <StatusPill status={a.suspended ? 'suspended' : 'active'} /> },
          ]}
          rows={rows} loading={loading} rowKey={(a) => a.username} dense emptyText="No accounts yet."
          searchable q={q} onSearch={setQ} searchPlaceholder="Filter accounts"
          selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(a) => [{ label: 'Repair', primary: true, onClick: () => run({ usernames: [a.username] }) }]}
        />
      </Card>
    </>
  );
}
