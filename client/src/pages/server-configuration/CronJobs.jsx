import { useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, formatDate, EmptyState } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Toggle, TextInput, Button } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

export default function CronJobs({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/system/schedules');
  const [drafts, setDrafts] = useState({});

  const update = async (s, patch) => {
    try { await api.patch(`/system/schedules/${s.name}`, patch); toast.success(`Schedule "${s.name}" updated`); setDrafts((d) => ({ ...d, [s.name]: undefined })); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="The panel's own maintenance schedules: backups, AutoSSL renewals, bandwidth accounting, quota checks and cleanup. Each runs as a background job you can follow in Task Queue Monitor." />
      <Card padded={false}>
        {data && data.length === 0 ? (
          <EmptyState title="No schedules registered yet">Each schedule appears here with its cron expression, switch and last and next run as its feature is enabled (backups, AutoSSL, bandwidth accounting).</EmptyState>
        ) : (
          <DataTable
            columns={[
              { key: 'name', label: 'Schedule', render: (s) => <><div>{s.name}</div><small className="muted"><code>{s.job_type}</code></small></> },
              { key: 'cron', label: 'Cron expression', render: (s) => <div className="input-group"><TextInput value={drafts[s.name] ?? s.cron} onChange={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))} className="input mono" style={{ width: '16ch', maxWidth: '100%' }} aria-label={`Cron expression for ${s.name}`} /><Button size="sm" variant="primary" disabled={drafts[s.name] == null || drafts[s.name] === s.cron} onClick={() => update(s, { cron: drafts[s.name] })}>Save</Button></div> },
              { key: 'enabled', label: 'Enabled', render: (s) => <Toggle checked={Boolean(s.enabled)} onChange={(v) => update(s, { enabled: v })} /> },
              { key: 'last_run_at', label: 'Last run', render: (s) => formatDate(s.last_run_at) },
              { key: 'next_run_at', label: 'Next run', render: (s) => formatDate(s.next_run_at) },
            ]}
            rows={data || []} loading={loading} error={error} rowKey={(s) => s.name}
          />
        )}
      </Card>
    </>
  );
}
