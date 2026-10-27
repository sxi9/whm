import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, Select } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { FormModal } from '../../widgets/index.jsx';

// The hub's revocations.list() reports, per row, how many installs of the
// plugin exist, how many checked in (installs.last_seen) since the revocation
// and how many of those still have it present (enabled/installed/disabled).
export function propagationText(p) {
  if (!p || typeof p !== 'object') return null;
  const installs = Number(p.installs) || 0;
  const reported = Number(p.reported_after) || 0;
  const active = Number(p.still_active) || 0;
  return { installs, reported, active, text: `${reported} / ${installs} installs reported since the revocation · ${active} still active` };
}

function Propagation({ p }) {
  const t = propagationText(p);
  if (!t) return '—';
  return <>{t.reported} / {t.installs} installs <span className="muted">reported since the revocation</span> · <span className={t.active ? 'pill pill-warn' : 'pill pill-ok'}>{t.active} still active</span></>;
}

// §18.3 revoke vs kill-switch: a revocation reaches panels through the signed
// feed (every 6 h); the kill-switch additionally queues a check-in message so
// every activation pulls the feed within one check-in.
export default function Revocations() {
  const [severity, setSeverity] = useState('');
  const list = useListQuery('/admin/market/revocations', { filters: { severity } });
  const [modal, setModal] = useState(null);
  const columns = [
    { key: 'ts', label: 'Time', sortable: true, render: (r) => formatDate(r.ts) },
    { key: 'plugin_id', label: 'Plugin', render: (r) => <><code>{r.plugin_id}</code> {r.version ? r.version : <span className="muted">all versions</span>}</> },
    { key: 'severity', label: 'Severity', render: (r) => <StatusPill status={r.severity} /> },
    { key: 'action', label: 'Action' },
    { key: 'reason', label: 'Reason' },
    { key: 'revoked_by', label: 'By', render: (r) => <code className="small">{r.revoked_by}</code> },
    { key: 'propagation', label: 'Propagation', render: (r) => <Propagation p={r.propagation} /> },
  ];
  const fields = (kill) => [
    { key: 'plugin_id', label: 'Plugin id', required: true },
    ...(kill ? [] : [{ key: 'version', label: 'Version (empty = every version)' }, { key: 'severity', label: 'Severity', type: 'select', options: ['info', 'warning', 'critical'], required: true }]),
    { key: 'action', label: 'Panel action', type: 'select', options: ['disable', 'uninstall'], required: true },
    { key: 'reason', label: 'Reason', type: 'textarea', required: !kill },
  ];
  return (
    <>
      <PageHeader title="Revocations & takedowns" description="Revoked versions are disabled or uninstalled by panels; critical revocations also hit same-id sideloads." home="/admin"
        actions={<><Button onClick={() => setModal('revoke')}>New revocation</Button><Button variant="danger" onClick={() => setModal('kill')}>Emergency kill-switch</Button></>} />
      <Card padded={false}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={severity} onChange={setSeverity} options={['info', 'warning', 'critical']} placeholder="Any severity" /></div>
        <DataTable columns={columns} {...list.tableProps} emptyText="No revocations" />
      </Card>
      <FormModal open={modal === 'revoke'} title="Revoke a version (requires a fresh 2FA code)" fields={fields(false)} initial={{ severity: 'warning', action: 'disable' }} onClose={() => setModal(null)} submitLabel="Revoke"
        onSubmit={async (d) => { await api.post('/admin/market/revocations', { plugin_id: d.plugin_id, version: d.version || null, severity: d.severity, action: d.action, reason: d.reason }); list.refetch(); }} />
      <FormModal open={modal === 'kill'} title="Kill-switch: critical, every version, pushed at the next check-in" fields={fields(true)} initial={{ action: 'disable' }} onClose={() => setModal(null)} submitLabel="Fire kill-switch"
        onSubmit={async (d) => { await api.post('/admin/market/revocations/kill-switch', { plugin_id: d.plugin_id, action: d.action, ...(d.reason ? { reason: d.reason } : {}) }); list.refetch(); }} />
    </>
  );
}
