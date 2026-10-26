import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatBytes } from '../../../components/Common.jsx';
import { Select, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../databases/Shared.jsx';

export default function DatabaseMapTool({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/databases/map');
  const [busy, setBusy] = useState(null);
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);

  const assign = async (kind, name, account) => {
    setBusy(`${kind}:${name}`);
    try {
      await api.post('/databases/map/assign', { kind, name, account: account || null });
      toast.success(account ? `${name} assigned to ${account}` : `${name} unassigned`);
      await refetch();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  const applySuggestions = async (kind, rows) => {
    const todo = rows.filter((r) => !r.account && r.suggested);
    for (const r of todo) await assign(kind, r.name, r.suggested);
    if (!todo.length) toast.info('Nothing to suggest: every object is mapped or has no matching prefix');
  };

  const table = (kind, rows, extraCols) => {
    const visible = onlyUnmapped ? rows.filter((r) => !r.account) : rows;
    return (
      <div className="table-wrap">
        <table>
          <thead><tr><th>{kind === 'database' ? 'Database' : 'User'}</th>{extraCols.map((c) => <th key={c.label}>{c.label}</th>)}<th style={{ width: 120 }}>On server</th><th style={{ width: 320 }}>Mapped to account</th></tr></thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={4 + extraCols.length} className="table-state">Nothing to show.</td></tr>}
            {visible.map((r) => (
              <tr key={r.name}>
                <td><code>{r.name}</code></td>
                {extraCols.map((c) => <td key={c.label}>{c.render(r)}</td>)}
                <td><StatusPill status={r.onServer ? 'ok' : 'failed'}>{r.onServer ? 'yes' : 'missing'}</StatusPill></td>
                <td>
                  <div className="row-actions">
                    <Select value={r.account || ''} onChange={(v) => assign(kind, r.name, v)} options={data.accounts.map((a) => ({ value: a, label: a }))} placeholder="— unmapped —" disabled={busy === `${kind}:${r.name}`} />
                    {!r.account && r.suggested && <Button size="sm" onClick={() => assign(kind, r.name, r.suggested)} loading={busy === `${kind}:${r.name}`}>Use {r.suggested}</Button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <PageHeader fn={fn} description="Map databases and database users that exist on the server to hosting accounts, so quotas, backups, transfers and terminations know what belongs to whom. Objects created through the panel are mapped automatically; use this tool for databases created by hand or migrated in." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          {data.engineError && <div className="banner banner-warning"><div><strong>Server unreachable</strong><p>{data.engineError.message} Only the panel's own records are shown.</p></div></div>}
          <div className="row-actions" style={{ marginBottom: 14 }}>
            <label className="radio"><input type="checkbox" checked={onlyUnmapped} onChange={(e) => setOnlyUnmapped(e.target.checked)} /><span><strong>Show unmapped only</strong></span></label>
            <span className="muted">{data.databases.filter((d) => !d.account).length} unmapped database(s), {data.users.filter((u) => !u.account).length} unmapped user(s){data.prefixing ? ' · suggestions use the <account>_ prefix' : ''}</span>
          </div>
          <Card title="Databases" padded={false} actions={<Button size="sm" onClick={() => applySuggestions('database', data.databases)}>Apply all suggestions</Button>}>
            {table('database', data.databases, [{ label: 'Size', render: (r) => (r.sizeBytes == null ? '—' : formatBytes(r.sizeBytes)) }])}
          </Card>
          <Card title="Database users" padded={false} actions={<Button size="sm" onClick={() => applySuggestions('user', data.users)}>Apply all suggestions</Button>}>
            {table('user', data.users, [{ label: 'Hosts', render: (r) => (r.hosts?.length ? r.hosts.map((h) => <code key={h} style={{ marginRight: 6 }}>{h}</code>) : '—') }])}
          </Card>
        </>
      )}
    </>
  );
}
