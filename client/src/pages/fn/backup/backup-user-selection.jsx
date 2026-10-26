import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Toggle, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../backup/Shared.jsx';

export default function BackupUserSelection({ fn }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const { data, meta, loading, error, refetch } = useApi(`/backup/selection${queryString({ q, enabled: filter || undefined })}`);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  const apply = async (usernames, enabled) => {
    setBusy(true);
    try {
      const { data: out } = await api.put('/backup/selection', { usernames, enabled });
      toast.success(`${out.changed.length} account(s) ${enabled ? 'included in' : 'excluded from'} backups`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const setDefault = async (value) => {
    try { await api.put('/backup/config', { 'backup.default_include': value }); toast.success(`Accounts without an explicit choice are now ${value ? 'included' : 'excluded'}`); refetch(); } catch (err) { toast.error(err); }
  };

  const counts = useMemo(() => ({ on: (data || []).filter((r) => r.enabled).length, off: (data || []).filter((r) => !r.enabled).length }), [data]);

  return (
    <>
      <PageHeader fn={fn} description="Choose which accounts the scheduled backup archives. Accounts without an explicit choice follow the default below." />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Default for new accounts">
        <div className="form-grid">
          <Field inline><Toggle checked={Boolean(meta?.defaultInclude)} onChange={setDefault} label="Include accounts that have no explicit setting" description="Changing this affects every account marked “default” below." /></Field>
          <Field label="Show"><Select value={filter} onChange={setFilter} options={[{ value: '', label: 'All accounts' }, { value: 'true', label: 'Included only' }, { value: 'false', label: 'Excluded only' }]} /></Field>
        </div>
        <p className="muted">{counts.on} included, {counts.off} excluded{data ? ` of ${data.length} shown` : ''}. Schedule and scope are set in <Link to="/backup/backup-configuration">Backup Configuration</Link>.</p>
      </Card>
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'username', label: 'Account', render: (r) => <><strong>{r.username}</strong> <span className="muted">{r.domain}</span>{r.suspended && <> <StatusPill status="suspended" /></>}</> },
            { key: 'owner', label: 'Owner' },
            { key: 'enabled', label: 'Backups', render: (r) => <><StatusPill status={r.enabled ? 'enabled' : 'disabled'} /> {!r.explicit && <span className="pill pill-muted">default</span>}</> },
            { key: 'lastBackup', label: 'Last backup', render: (r) => (r.lastBackup ? <><StatusPill status={r.lastBackup.status} /> {formatDate(r.lastBackup.created_at)} · {formatBytes(r.lastBackup.size)}</> : <span className="muted">never</span>) },
          ]}
          rows={data || []} loading={loading} error={null} rowKey={(r) => r.username}
          searchable q={q} onSearch={setQ} searchPlaceholder="Search by user, domain or owner"
          selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(r) => [{ label: r.enabled ? 'Exclude' : 'Include', primary: true, disabled: busy, onClick: () => apply([r.username], !r.enabled) }]}
          toolbar={(
            <>
              <Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => apply(selected, true)}>Include selected ({selected.length})</Button>
              <Button disabled={!selected.length} loading={busy} onClick={() => apply(selected, false)}>Exclude selected</Button>
            </>
          )}
          emptyText="No accounts."
        />
      </Card>
    </>
  );
}
