import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Toggle } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { Tabs, RequestError } from '../../security/Shared.jsx';

function Hits({ onDisable }) {
  const { data, loading, error, refetch } = useApi('/security/modsec/hits?limit=500', { refreshMs: 30_000 });
  return (
    <Card title="Recent hits" subtitle={data ? `Parsed from ${data.file}${data.available ? '' : ' (log not readable)'}` : undefined} padded={false} actions={<button className="btn btn-sm" onClick={() => refetch()}>Refresh</button>}>
      <DataTable dense columns={[
        { key: 'ts', label: 'Time' },
        { key: 'client', label: 'Client', render: (h) => <code>{h.client}</code> },
        { key: 'hostname', label: 'Host' },
        { key: 'uri', label: 'URI', render: (h) => <code className="small">{h.uri}</code> },
        { key: 'id', label: 'Rule', render: (h) => <code>{h.id}</code> },
        { key: 'msg', label: 'Message' },
        { key: 'severity', label: 'Severity', render: (h) => <StatusPill status={/CRITICAL|EMERGENCY|ALERT/.test(h.severity || '') ? 'failed' : /ERROR|WARNING/.test(h.severity || '') ? 'warning' : 'unknown'}>{h.severity || '—'}</StatusPill> },
        { key: 'action', label: 'Action' },
      ]} rows={data?.hits || []} loading={loading} error={error} rowKey={(h) => `${h.uniqueId || h.ts}-${h.id}-${h.client}`} emptyText="No ModSecurity events in the error log tail."
        rowActions={(h) => (h.id ? [{ label: 'Disable rule', primary: true, onClick: () => onDisable(h.id) }] : [])} />
    </Card>
  );
}

function Rules() {
  const toast = useToast();
  const confirm = useConfirm();
  const t = useTableState({ pageSize: 50 });
  const [disabledOnly, setDisabledOnly] = useState(false);
  const { data, meta, loading, error, refetch } = useApi(`/security/modsec/rules${queryString({ page: t.state.page, pageSize: t.state.pageSize, q: t.state.q, disabled: disabledOnly ? 'true' : undefined })}`);
  const toggle = async (r) => {
    if (!r.disabled && !(await confirm({ title: `Disable rule ${r.id}?`, message: `${r.msg || 'This rule'} will no longer be evaluated. Prefer disabling a single rule over turning the engine off.`, confirmLabel: 'Disable', danger: true }))) return;
    try { await api.put(`/security/modsec/rules/${r.id}`, { disabled: !r.disabled, ...(r.disabled ? {} : { reason: 'disabled from ModSecurity Tools' }) }); toast.success(`Rule ${r.id} ${r.disabled ? 'enabled' : 'disabled'}; Apache reloaded`); refetch(); } catch (err) { toast.error(err); }
  };
  return (
    <Card title="Rules" subtitle={meta ? `${meta.total} rules across ${meta.files} files${meta.truncated ? ' (truncated)' : ''}` : undefined} padded={false}>
      <DataTable columns={[
        { key: 'id', label: 'Rule ID', render: (r) => <code>{r.id}</code> },
        { key: 'msg', label: 'Message', render: (r) => r.msg || <span className="muted">{r.action === 'action' ? 'SecAction' : '—'}</span> },
        { key: 'severity', label: 'Severity' },
        { key: 'phase', label: 'Phase' },
        { key: 'vendor', label: 'Source', render: (r) => <><div>{r.vendor || 'base'}</div><small className="muted"><code>{r.file.split('/').pop()}</code></small></> },
        { key: 'disabled', label: 'Enabled', render: (r) => <Toggle checked={!r.disabled} onChange={() => toggle(r)} /> },
      ]} rows={data || []} loading={loading} error={error} rowKey={(r) => `${r.id}-${r.file}`}
        total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
        searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search id, message, tag or file…"
        toolbar={<Toggle checked={disabledOnly} onChange={(v) => { setDisabledOnly(v); t.setPage(1); }} label="Disabled only" />} emptyText="No rules found." dense />
    </Card>
  );
}

export default function ModsecurityTools({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('hits');
  const { data, loading, error, refetch } = useApi('/security/modsec');
  const disableFromHit = async (id) => {
    if (!(await confirm({ title: `Disable rule ${id}?`, message: 'The rule will be removed with SecRuleRemoveById for the whole server and Apache reloaded.', confirmLabel: 'Disable', danger: true }))) return;
    try { await api.put(`/security/modsec/rules/${id}`, { disabled: true, reason: 'false positive seen in hit list' }); toast.success(`Rule ${id} disabled`); } catch (err) { toast.error(err); }
  };
  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && <RequestError error={{ status: 501, code: 'capability_missing', capability: 'modsecurity', message: 'ModSecurity is not installed on this server.' }} onRetry={refetch} />}
      {data && data.installed && (
        <>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'hits', label: 'Hits list' }, { value: 'rules', label: 'Rules list', count: data.disabledRules.length ? `${data.disabledRules.length} disabled` : undefined }]} />
          {tab === 'hits' && <Hits onDisable={disableFromHit} />}
          {tab === 'rules' && <Rules />}
        </>
      )}
    </>
  );
}
