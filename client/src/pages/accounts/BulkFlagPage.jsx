import { useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

// Shared by Force Password Change and Manage Demo Mode: pick accounts, turn a
// per-account flag on or off in one request.
export function BulkFlagPage({ fn, flag, endpoint, onLabel, offLabel, description, columnLabel, confirmOn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/account-functions/summary');
  const [selected, setSelected] = useState([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const rows = (data || []).filter((a) => !filter || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(filter.toLowerCase()));
  const on = (data || []).filter((a) => a[flag]).length;

  const apply = async (enabled, usernames, all = false) => {
    const n = all ? (data || []).length : usernames.length;
    if (enabled && confirmOn && !(await confirm({ title: `${onLabel} for ${n} account(s)?`, message: confirmOn, confirmLabel: onLabel }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post(endpoint, all ? { all: true, enabled } : { usernames, enabled });
      setLast(res);
      toast.success(`${enabled ? onLabel : offLabel}: ${res.changed.length} changed${res.unchanged.length ? `, ${res.unchanged.length} already set` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description={description} />
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="label">Accounts</div><div className="value">{data ? data.length : '—'}</div></div>
        <div className="stat"><div className="label">{columnLabel}</div><div className="value">{data ? on : '—'}</div></div>
        <div className="stat"><div className="label">Selected</div><div className="value">{selected.length}</div></div>
      </div>
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Owner' },
            { key: 'suspended', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
            { key: flag, label: columnLabel, render: (r) => <StatusPill status={r[flag] ? 'enabled' : 'disabled'}>{r[flag] ? 'On' : 'Off'}</StatusPill> },
          ]}
          rows={rows} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
          searchable q={filter} onSearch={setFilter} searchPlaceholder="Filter by user, domain or owner"
          rowActions={(r) => [r[flag] ? { label: offLabel, primary: true, onClick: () => apply(false, [r.username]) } : { label: onLabel, primary: true, onClick: () => apply(true, [r.username]) }]}
          toolbar={(
            <>
              <Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => apply(true, selected)}>{onLabel} ({selected.length})</Button>
              <Button disabled={!selected.length} loading={busy} onClick={() => apply(false, selected)}>{offLabel} ({selected.length})</Button>
              <Button variant="ghost" loading={busy} disabled={!data?.length} onClick={() => apply(true, [], true)}>{onLabel} for all</Button>
            </>
          )}
          emptyText="No accounts match."
        />
      </Card>
      {last && (
        <Card title="Last change">
          <p>{last.enabled ? onLabel : offLabel}: <strong>{last.changed.length}</strong> changed{last.changed.length ? ` (${last.changed.join(', ')})` : ''}{last.unchanged.length ? `; ${last.unchanged.length} already in that state` : ''}{last.missing.length ? `; not found or not yours: ${last.missing.join(', ')}` : ''}.</p>
        </Card>
      )}
    </>
  );
}
