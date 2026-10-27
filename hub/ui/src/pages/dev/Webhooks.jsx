import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal, SecretOnce } from '../../widgets/index.jsx';

export const DEV_WEBHOOK_EVENTS = ['*', 'version.scan_completed', 'version.review_decided', 'version.published', 'version.revoked', 'version.resigned', 'developer.status_changed', 'purchase.completed', 'purchase.refunded', 'payout.paid'];

export default function Webhooks() {
  const { data, error, refetch } = useApi('/dev/webhooks');
  const { run } = useAction();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [open, setOpen] = useState(null);
  const deliveries = useListQuery(open ? `/dev/webhooks/${open}/deliveries` : null, { enabled: Boolean(open), pageSize: 20 });
  return (
    <>
      <PageHeader title="Webhooks" description="HTTPS endpoints that receive scan, review, publish, revocation, purchase and payout events (HMAC-signed, retried with backoff)." home="/dev" actions={<Button variant="primary" onClick={() => setCreating(true)}>Add webhook</Button>} />
      <ErrorBanner error={error} onRetry={refetch} />
      <SecretOnce label="Webhook secret" value={created?.secret}>Verify <code>X-WHM-Webhook-Signature: t=…,v1=hmac-sha256(secret, t + "." + body)</code>.</SecretOnce>
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>URL</th><th>Events</th><th>Enabled</th><th>Created</th><th /></tr></thead>
            <tbody>
              {(data || []).map((w) => <tr key={w.id}><td><code>{w.url}</code></td><td>{(w.events || []).join(', ')}</td><td><StatusPill status={w.enabled ? 'enabled' : 'disabled'} /></td><td>{formatDate(w.created_at)}</td><td className="inline-list"><Button size="sm" onClick={() => setOpen(open === w.id ? null : w.id)}>Deliveries</Button><Button size="sm" variant="danger-ghost" onClick={async () => { if (await confirm({ title: 'Delete webhook', message: w.url, danger: true })) run(() => api.delete(`/dev/webhooks/${w.id}`), { success: 'Deleted', then: refetch }); }}>Delete</Button></td></tr>)}
              {!(data || []).length && <tr><td colSpan={5} className="muted">No webhooks.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      {open && (
        <Card title="Deliveries">
          <DataTable dense columns={[{ key: 'event', label: 'Event' }, { key: 'status', label: 'Status', render: (d) => <StatusPill status={d.status} /> }, { key: 'attempt', label: 'Attempt' }, { key: 'last_code', label: 'HTTP' }, { key: 'next_at', label: 'Next', render: (d) => formatDate(d.next_at) }, { key: 'created_at', label: 'Created', render: (d) => formatDate(d.created_at) }]}
            {...deliveries.tableProps} rowKey={(d) => d.id} emptyText="No deliveries yet" rowActions={(d) => [{ label: 'Replay', primary: true, onClick: () => run(() => api.post(`/dev/webhooks/${open}/deliveries/${d.id}/replay`), { success: 'Replay queued', then: deliveries.refetch }) }]} />
        </Card>
      )}
      <FormModal open={creating} title="Add webhook" fields={[{ key: 'url', label: 'HTTPS URL', required: true, help: 'Private, loopback and link-local hosts are refused (SSRF policy)' }, { key: 'events', label: 'Events (comma-separated)', required: true, help: DEV_WEBHOOK_EVENTS.join(', ') }, { key: 'secret', label: 'Secret (optional, 16–128 chars)' }]} initial={{ events: '*' }} onClose={() => setCreating(false)} submitLabel="Add"
        onSubmit={async (d) => { const { data: out } = await api.post('/dev/webhooks', { url: d.url, events: d.events.split(',').map((s) => s.trim()).filter(Boolean), ...(d.secret ? { secret: d.secret } : {}) }); setCreated(out); refetch(); }} />
    </>
  );
}
