import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, RadioGroup, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { publishMessage } from '../../dns/ZonePicker.jsx';

const ROUTING = [
  { value: 'local', label: 'Local Mail Exchanger', description: 'This server accepts mail for the domain. MX → mail.<domain> (priority 0).' },
  { value: 'backup', label: 'Backup Mail Exchanger', description: 'Remote servers deliver first; this server queues mail when they are down. Your MX hosts plus a lower-priority local MX.' },
  { value: 'remote', label: 'Remote Mail Exchanger', description: 'Mail is handled elsewhere (e.g. Google Workspace). This server does not accept mail for the domain.' },
  { value: 'auto', label: 'Automatically Detect Configuration', description: 'Decide from the MX records: local when this server is the primary MX, backup when it is a lower-priority MX, remote otherwise. MX records are left as they are.' },
];

function RoutingForm({ row, onSaved, onCancel }) {
  const toast = useToast();
  const [routing, setRouting] = useState(row.routing);
  const [exchanges, setExchanges] = useState(row.mx.filter((m) => !m.value.startsWith('mail.')).map((m) => ({ priority: m.priority, exchange: m.value.replace(/\.$/, '') })));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const needsMx = ['remote', 'backup'].includes(routing);
  const setEx = (i, k, v) => setExchanges((list) => list.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { routing };
      if (needsMx) body.exchanges = exchanges.filter((e) => e.exchange).map((e) => ({ priority: Number(e.priority) || 0, exchange: e.exchange.trim().toLowerCase() }));
      const { data } = await api.put(`/dns/routing/${row.domain}`, body);
      toast.success(publishMessage(data, `Routing for ${row.domain} set to ${routing}`));
      onSaved(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <>
      <CapabilityNotice error={error} />
      <ErrorBanner error={error && !error.fields && error.code !== 'capability_missing' ? error : null} />
      <RadioGroup name="routing" value={routing} onChange={setRouting} options={ROUTING} />
      {needsMx && (
        <Card title="External mail exchangers" subtitle="Lowest priority is tried first">
          {error?.fields?.exchanges && <div className="field-message">{error.fields.exchanges.join(', ')}</div>}
          {exchanges.map((e, i) => (
            <div className="form-grid" key={i}>
              <Field label="Priority"><NumberInput value={e.priority} onChange={(v) => setEx(i, 'priority', v ?? 0)} nullable={false} min={0} max={65535} /></Field>
              <Field label="Mail exchanger host"><div className="input-group"><TextInput value={e.exchange} onChange={(v) => setEx(i, 'exchange', v)} placeholder="aspmx.l.google.com" /><Button onClick={() => setExchanges((l) => l.filter((_, j) => j !== i))}>Remove</Button></div></Field>
            </div>
          ))}
          <Button size="sm" onClick={() => setExchanges((l) => [...l, { priority: (l.length + 1) * 10, exchange: '' }])}>Add exchanger</Button>
        </Card>
      )}
      <FormActions><Button variant="primary" loading={busy} onClick={save}>Save routing</Button><Button onClick={onCancel}>Cancel</Button></FormActions>
    </>
  );
}

export default function EmailRoutingConfiguration({ fn }) {
  const { data, loading, error, refetch } = useApi('/dns/routing');
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('');
  const rows = (data || []).filter((r) => !filter || `${r.domain} ${r.account || ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <PageHeader fn={fn} description="Choose, per domain, whether this server, a remote provider or a backup arrangement receives mail. The MX records in the zone are updated to match and the mail server is told about the routing." />
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Domain', render: (r) => <code>{r.domain}</code> },
            { key: 'account', label: 'Account', render: (r) => r.account || <span className="muted">—</span> },
            { key: 'routing', label: 'Routing', render: (r) => <StatusPill status={{ local: 'ok', remote: 'info', backup: 'warning', auto: 'unknown' }[r.routing]}>{ROUTING.find((o) => o.value === r.routing)?.label || r.routing}</StatusPill> },
            { key: 'effective', label: 'Effective', render: (r) => <StatusPill status={{ local: 'ok', remote: 'info', backup: 'warning' }[r.effective] || 'unknown'}>{r.routing === 'auto' ? `auto → ${r.effective}` : r.effective}</StatusPill> },
            { key: 'mx', label: 'MX records', render: (r) => (r.mx.length ? <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.mx.map((m) => `${m.priority} ${m.value}`).join(', ')}</span> : <span className="muted">none</span>) },
          ]}
          rows={rows} loading={loading} error={error} rowKey={(r) => r.domain} emptyText="No zones yet; add a DNS zone first."
          toolbar={<TextInput value={filter} onChange={setFilter} placeholder="Filter domains" style={{ width: 220 }} />}
          rowActions={(r) => [{ label: 'Configure', primary: true, onClick: () => setEditing(r) }]}
        />
      </Card>
      <Modal open={Boolean(editing)} title={editing ? `Email routing for ${editing.domain}` : ''} onClose={() => setEditing(null)} size="lg">
        {editing && <RoutingForm row={editing} onSaved={() => { setEditing(null); refetch(); }} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
