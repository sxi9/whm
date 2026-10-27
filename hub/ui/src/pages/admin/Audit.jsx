import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { TextInput } from '../../components/Form.jsx';
import { useListQuery } from '../../hooks/useListQuery.js';
import { Tabs } from '../../widgets/index.jsx';

// Two audit logs: license.db (every admin/reseller/portal mutation) and
// marketplace.db (developer, review, signing and money events).
export default function Audit() {
  const [source, setSource] = useState('license');
  const [action, setAction] = useState('');
  const path = source === 'license' ? '/admin/audit' : '/admin/market/audit';
  const list = useListQuery(path, { filters: action ? { action } : {}, pageSize: 50 });
  const columns = [
    { key: 'ts', label: 'Time', sortable: true, render: (r) => formatDate(r.ts) },
    { key: 'principal', label: 'Principal', render: (r) => <code className="small">{r.principal}</code> },
    { key: 'role', label: 'Role' },
    { key: 'ip', label: 'IP' },
    { key: 'action', label: 'Action', render: (r) => <code>{r.action}</code> },
    { key: 'target', label: 'Target', render: (r) => <code className="small">{r.target}</code> },
    { key: 'result', label: 'Result', render: (r) => <StatusPill status={String(r.result || '').startsWith('error') ? 'failed' : 'ok'}>{r.result}</StatusPill> },
    { key: 'args_redacted', label: 'Args', render: (r) => <code className="small">{typeof r.args_redacted === 'string' ? r.args_redacted.slice(0, 120) : JSON.stringify(r.args_redacted || null)}</code> },
  ];
  return (
    <>
      <PageHeader title="Audit log" description="Every privileged action with principal, IP, target and redacted arguments." home="/admin" />
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs tabs={[{ value: 'license', label: 'License server' }, { value: 'market', label: 'Marketplace' }]} value={source} onChange={setSource} /></div>
        <div className="filter-row" style={{ padding: '0 16px' }}><TextInput value={action} onChange={setAction} placeholder="Action prefix, e.g. license. or review." style={{ maxWidth: 320 }} /></div>
        <DataTable dense columns={columns} {...list.tableProps} rowKey={(r) => r.id} searchable searchPlaceholder="Action, target, principal" emptyText="No audit rows" />
      </Card>
    </>
  );
}
