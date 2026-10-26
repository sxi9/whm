import { useMemo, useState } from 'react';
import { queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, formatMb } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, Select, TextInput, Button, ErrorBanner } from '../../components/Form.jsx';

const EMPTY = { q: '', owner: '', package: '', ip: '', suspended: '' };

// Selection state shared by both bulk pages: the filtered account list from
// /multi-account/accounts plus the chosen usernames.
export function useAccountSelection() {
  const [filter, setFilter] = useState(EMPTY);
  const [selected, setSelected] = useState([]);
  const query = useMemo(() => queryString({ q: filter.q, owner: filter.owner, package: filter.package, ip: filter.ip, suspended: filter.suspended, sort: 'username' }), [filter]);
  const { data, meta, loading, error, refetch } = useApi(`/multi-account/accounts${query}`);
  const rows = data || [];
  const selectedRows = rows.filter((r) => selected.includes(r.username));
  const filterActive = Object.values(filter).some(Boolean);
  return {
    filter, setFilter: (patch) => setFilter((f) => ({ ...f, ...patch })), resetFilter: () => setFilter(EMPTY), filterActive,
    rows, meta, loading, error, refetch, selected, setSelected, selectedRows,
    selectAll: () => setSelected(rows.map((r) => r.username)), clear: () => setSelected([]),
  };
}

export function AccountSelector({ sel, title = 'Select accounts', extraColumns = [] }) {
  const { filter, setFilter, resetFilter, rows, meta, loading, error, refetch, selected, setSelected, selectAll, clear } = sel;
  const options = meta?.filters || { owners: [], packages: [], ips: [] };
  return (
    <Card title={title} subtitle={meta ? `${rows.length} of ${meta.all} account(s) match · ${selected.length} selected · at most ${meta.maxBatch} per run` : undefined} padded={false}>
      <div className="card-body">
        <div className="form-grid">
          <Field label="Search"><TextInput value={filter.q} onChange={(v) => setFilter({ q: v })} placeholder="User, domain, owner or email" /></Field>
          <Field label="Owner"><Select value={filter.owner} onChange={(v) => setFilter({ owner: v })} options={options.owners} placeholder="Any owner" /></Field>
          <Field label="Package"><Select value={filter.package} onChange={(v) => setFilter({ package: v })} options={options.packages} placeholder="Any package" /></Field>
          <Field label="IP address"><Select value={filter.ip} onChange={(v) => setFilter({ ip: v })} options={options.ips} placeholder="Any address" /></Field>
          <Field label="Status"><Select value={filter.suspended} onChange={(v) => setFilter({ suspended: v })} options={[{ value: 'false', label: 'Active' }, { value: 'true', label: 'Suspended' }]} placeholder="Active and suspended" /></Field>
        </div>
      </div>
      <ErrorBanner error={error} onRetry={refetch} />
      <DataTable
        columns={[
          { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
          { key: 'domain', label: 'Domain' },
          { key: 'owner', label: 'Owner' },
          { key: 'package_name', label: 'Package' },
          { key: 'ip', label: 'IP', render: (r) => (r.ip ? <code>{r.ip}</code> : <span className="muted">shared / unset</span>) },
          { key: 'disk_quota_mb', label: 'Disk', align: 'right', render: (r) => `${formatMb(r.disk_used_mb)} / ${formatMb(r.disk_quota_mb)}` },
          { key: 'suspended', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'}>{r.suspended ? 'Suspended' : 'Active'}</StatusPill> },
          ...extraColumns,
        ]}
        rows={rows} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected} dense
        toolbar={(
          <>
            <Button size="sm" onClick={selectAll} disabled={!rows.length}>Select all matching ({rows.length})</Button>
            <Button size="sm" variant="ghost" onClick={clear} disabled={!selected.length}>Clear selection</Button>
            {Object.values(filter).some(Boolean) && <Button size="sm" variant="ghost" onClick={resetFilter}>Reset filters</Button>}
          </>
        )}
        emptyText="No accounts match these filters."
      />
    </Card>
  );
}

export function Steps({ step, labels }) {
  return (
    <div className="row-actions" style={{ marginBottom: 14 }}>
      {labels.map((label, i) => <span key={label} className={`pill ${step === i + 1 ? 'pill-info' : step > i + 1 ? 'pill-ok' : 'pill-muted'}`}>{i + 1}. {label}</span>)}
    </div>
  );
}

export function Totals({ items }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 14 }}>
      {items.map(([label, value]) => <div className="stat" key={label}><div className="label">{label}</div><div className="value">{value ?? '—'}</div></div>)}
    </div>
  );
}

export function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return <div className="banner banner-warning"><div><strong>Before you run</strong><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>;
}

export const ITEM_TONE = { done: 'done', pending: 'pending', failed: 'failed', skipped: 'disabled', unchanged: 'unknown', queued: 'queued', running: 'running', change: 'info', blocked: 'failed' };
export function ItemStatus({ status }) {
  return <StatusPill status={ITEM_TONE[status] || status}>{status}</StatusPill>;
}
