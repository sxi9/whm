import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useListQuery } from '../../hooks/useListQuery.js';
import { useAction } from '../../hooks/useAction.js';
import { FormModal, SecretOnce, Tabs } from '../../widgets/index.jsx';

export const VENDOR_API_SCOPES = ['admin:*', 'admin:read', 'admin:write', 'billing:webhook', 'report:read', 'market:*', 'market:read', 'market:review', 'market:verify', 'market:revoke', 'market:billing', 'license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write'];
export const RESELLER_API_SCOPES = ['license:read', 'license:issue', 'license:renew', 'license:revoke', 'customer:write', 'webhook:write'];
export const WEBHOOK_EVENTS = ['*', 'license.issued', 'license.activated', 'license.checkin_failed', 'license.expiring', 'license.expired', 'license.suspended', 'license.revoked', 'license.transferred', 'license.renewed', 'license.edition_changed', 'trial.started', 'trial.converted'];

// API keys (creation is a step-up route) — shared by vendor and reseller portals.
export function ApiKeysPanel({ base, scopes }) {
  const { data, error, refetch } = useApi(`${base}/api-keys`);
  const { run } = useAction();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [picked, setPicked] = useState([]);
  return (
    <>
      <ErrorBanner error={error} onRetry={refetch} />
      <SecretOnce label={`API key ${created?.name || ''}`} value={created?.key}>Send it as <code>Authorization: Bearer …</code>. It is stored hashed and never shown again.</SecretOnce>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Expires</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(data || []).map((k) => (
              <tr key={k.id}><td>{k.name}</td><td><code>{k.key_prefix}…</code></td><td><div className="inline-list">{(k.scopes || []).map((s) => <span key={s} className="pill pill-muted">{s}</span>)}</div></td><td>{k.expires_at ? formatDate(k.expires_at) : 'never'}</td><td>{formatDate(k.last_used_at)}</td><td><StatusPill status={k.revoked_at ? 'revoked' : 'active'} /></td>
                <td>{!k.revoked_at && <Button size="sm" variant="danger-ghost" onClick={async () => { if (await confirm({ title: 'Revoke API key', message: `Revoke "${k.name}"? Integrations using it stop immediately.`, danger: true })) run(() => api.delete(`${base}/api-keys/${k.id}`), { success: 'Key revoked', then: refetch }); }}>Revoke</Button>}</td></tr>
            ))}
            {!(data || []).length && <tr><td colSpan={7} className="muted">No API keys.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="form-actions"><Button variant="primary" onClick={() => { setPicked([]); setCreating(true); }}>Create API key</Button></div>
      <FormModal open={creating} title="Create API key (requires a fresh 2FA code)" fields={[{ key: 'name', label: 'Name', required: true }, { key: 'expires_in_days', label: 'Expires in days (optional)', type: 'number', min: 1, max: 3650 }]} onClose={() => setCreating(false)} submitLabel="Create"
        onSubmit={async (d) => {
          if (!picked.length) throw Object.assign(new Error('Pick at least one scope'), { fields: { scopes: ['required'] } });
          const { data: out } = await api.post(`${base}/api-keys`, { name: d.name, scopes: picked, ...(d.expires_in_days ? { expires_in_days: Number(d.expires_in_days) } : {}) });
          setCreated(out); refetch();
        }} />
      {creating && (
        <div className="card" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 95, maxWidth: 360 }}>
          <div className="card-body"><strong>Scopes</strong><div className="inline-list" style={{ marginTop: 6 }}>{scopes.map((s) => <button key={s} type="button" className={`btn btn-sm ${picked.includes(s) ? 'btn-primary' : ''}`} onClick={() => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}>{s}</button>)}</div></div>
        </div>
      )}
    </>
  );
}

export function WebhooksPanel({ base, events = WEBHOOK_EVENTS }) {
  const { data, error, refetch } = useApi(`${base}/webhooks`);
  const { run } = useAction();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [deliveriesOf, setDeliveriesOf] = useState(null);
  const deliveries = useListQuery(deliveriesOf ? `${base}/webhooks/${deliveriesOf}/deliveries` : null, { enabled: Boolean(deliveriesOf), pageSize: 20 });
  return (
    <>
      <ErrorBanner error={error} onRetry={refetch} />
      <SecretOnce label="Webhook secret" value={created?.secret}>Verify <code>X-WHM-Webhook-Signature: t=…,v1=hmac-sha256(secret, t + "." + body)</code>.</SecretOnce>
      <div className="table-wrap">
        <table>
          <thead><tr><th>URL</th><th>Events</th><th>Enabled</th><th>Created</th><th /></tr></thead>
          <tbody>
            {(data || []).map((w) => (
              <tr key={w.id}><td><code>{w.url}</code></td><td>{(w.events || []).join(', ')}</td><td><StatusPill status={w.enabled ? 'enabled' : 'disabled'} /></td><td>{formatDate(w.created_at)}</td>
                <td className="inline-list">
                  <Button size="sm" onClick={() => run(() => api.post(`${base}/webhooks/${w.id}/test`), { success: 'Test delivery queued' })}>Test</Button>
                  <Button size="sm" onClick={() => setDeliveriesOf(deliveriesOf === w.id ? null : w.id)}>Deliveries</Button>
                  <Button size="sm" variant="danger-ghost" onClick={async () => { if (await confirm({ title: 'Delete webhook', message: w.url, danger: true })) run(() => api.delete(`${base}/webhooks/${w.id}`), { success: 'Webhook deleted', then: refetch }); }}>Delete</Button>
                </td></tr>
            ))}
            {!(data || []).length && <tr><td colSpan={5} className="muted">No outbound webhooks.</td></tr>}
          </tbody>
        </table>
      </div>
      {deliveriesOf && (
        <DataTable dense columns={[{ key: 'event', label: 'Event' }, { key: 'status', label: 'Status', render: (d) => <StatusPill status={d.status} /> }, { key: 'attempt', label: 'Attempt' }, { key: 'last_code', label: 'HTTP' }, { key: 'next_at', label: 'Next', render: (d) => formatDate(d.next_at) }, { key: 'created_at', label: 'Created', render: (d) => formatDate(d.created_at) }]}
          {...deliveries.tableProps} rowKey={(d) => d.id} emptyText="No deliveries" rowActions={(d) => [{ label: 'Replay', primary: true, onClick: () => run(() => api.post(`${base}/webhooks/${deliveriesOf}/deliveries/${d.id}/replay`), { success: 'Replay queued', then: deliveries.refetch }) }]} />
      )}
      <div className="form-actions"><Button variant="primary" onClick={() => setCreating(true)}>Add webhook</Button></div>
      <FormModal open={creating} title="Add outbound webhook" fields={[{ key: 'url', label: 'HTTPS URL', required: true }, { key: 'events', label: 'Events (comma-separated, * for all)', required: true, help: events.join(', ') }, { key: 'secret', label: 'Secret (optional, 16–128 chars)', help: 'Leave empty to let the hub generate one' }]} initial={{ events: '*' }} onClose={() => setCreating(false)} submitLabel="Add"
        onSubmit={async (d) => { const { data: out } = await api.post(`${base}/webhooks`, { url: d.url, events: d.events.split(',').map((s) => s.trim()).filter(Boolean), ...(d.secret ? { secret: d.secret } : {}) }); setCreated(out); refetch(); }} />
    </>
  );
}

function PortalUsersPanel() {
  const list = useListQuery('/portal/users');
  const { run } = useAction();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(null);
  return (
    <>
      <DataTable columns={[{ key: 'email', label: 'E-mail' }, { key: 'role', label: 'Role' }, { key: 'reseller_id', label: 'Reseller' }, { key: 'totp_enabled', label: '2FA', render: (u) => <StatusPill status={u.totp_enabled ? 'enabled' : 'disabled'} /> }, { key: 'status', label: 'Status', render: (u) => <StatusPill status={u.status} /> }, { key: 'last_login_at', label: 'Last login', render: (u) => formatDate(u.last_login_at) }]}
        {...list.tableProps} emptyText="No portal users" toolbar={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>New portal user</Button>}
        rowActions={(u) => [
          u.status === 'active' ? { label: 'Disable', danger: true, onClick: () => run(() => api.patch(`/portal/users/${u.id}`, { status: 'disabled' }), { success: 'User disabled', then: list.refetch }) } : { label: 'Enable', onClick: () => run(() => api.patch(`/portal/users/${u.id}`, { status: 'active' }), { success: 'User enabled', then: list.refetch }) },
          { label: 'Reset password', onClick: () => setResetting(u) },
        ]} />
      <FormModal open={creating} title="New portal user (requires a fresh 2FA code)" fields={[{ key: 'email', label: 'E-mail', type: 'email', required: true }, { key: 'password', label: 'Initial password', type: 'password', required: true }, { key: 'role', label: 'Role', type: 'select', options: ['vendor_admin', 'vendor_support', 'reseller_admin', 'reseller_staff'], required: true }, { key: 'reseller_id', label: 'Reseller id (reseller roles only)' }]} initial={{ role: 'vendor_support' }} onClose={() => setCreating(false)} submitLabel="Create"
        onSubmit={async (d) => { await api.post('/portal/users', { email: d.email, password: d.password, role: d.role, ...(d.reseller_id ? { reseller_id: d.reseller_id } : {}) }); list.refetch(); }} />
      <FormModal open={Boolean(resetting)} title={`Reset password for ${resetting?.email || ''}`} fields={[{ key: 'password', label: 'New password', type: 'password', required: true }]} onClose={() => setResetting(null)} submitLabel="Reset"
        onSubmit={async (d) => { await api.post(`/portal/users/${resetting.id}/reset-password`, { password: d.password }); }} />
    </>
  );
}

function BillingPanel() {
  const list = useListQuery('/admin/billing/events', { pageSize: 25 });
  return (
    <>
      <p className="muted">Inbound connectors post to <code>/v1/admin/billing/webhooks/:source</code> (stripe · whmcs · paddle), signature-verified and idempotent on <code>external_id</code>. Events whose <code>metadata.whm_kind</code> is <code>plugin_purchase</code> are routed to the marketplace.</p>
      <DataTable dense columns={[{ key: 'source', label: 'Source' }, { key: 'event_type', label: 'Event' }, { key: 'external_id', label: 'External id', render: (e) => <code>{e.external_id}</code> }, { key: 'result', label: 'Result', render: (e) => <StatusPill status={e.result?.startsWith('error') ? 'failed' : 'ok'}>{e.result}</StatusPill> }, { key: 'processed_at', label: 'Processed', render: (e) => formatDate(e.processed_at) }]} {...list.tableProps} emptyText="No billing events yet" />
    </>
  );
}

function SchedulesPanel() {
  const { data, refetch } = useApi('/admin/schedules');
  const { run } = useAction();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Job</th><th>Cron</th><th>Last run</th><th>Result</th><th /></tr></thead>
        <tbody>
          {(data || []).map((s) => <tr key={s.name}><td><code>{s.name}</code></td><td>{s.cron}</td><td>{formatDate(s.last_run_at || s.lastRunAt)}</td><td>{s.last_error ? <span className="pill pill-bad">{s.last_error}</span> : s.last_result ? <code className="small">{JSON.stringify(s.last_result).slice(0, 80)}</code> : '—'}</td><td><Button size="sm" onClick={() => run(() => api.post(`/admin/schedules/${s.name}/run`), { success: `${s.name} ran`, then: refetch })}>Run now</Button></td></tr>)}
          {!(data || []).length && <tr><td colSpan={5} className="muted">No schedules reported.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function Integrations() {
  const [tab, setTab] = useState('api-keys');
  return (
    <>
      <PageHeader title="Integrations" description="API keys with scopes, outbound webhooks, inbound billing connectors, portal users and the hub schedules." home="/admin"
        actions={<Link className="btn" to="/admin/signing-keys">Signing-key rotation</Link>} />
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs value={tab} onChange={setTab} tabs={[{ value: 'api-keys', label: 'API keys' }, { value: 'webhooks', label: 'Outbound webhooks' }, { value: 'billing', label: 'Inbound billing' }, { value: 'users', label: 'Portal users' }, { value: 'schedules', label: 'Schedules' }]} /></div>
        <div className="card-body">
          {tab === 'api-keys' && <ApiKeysPanel base="/admin" scopes={VENDOR_API_SCOPES} />}
          {tab === 'webhooks' && <WebhooksPanel base="/admin" />}
          {tab === 'billing' && <BillingPanel />}
          {tab === 'users' && <PortalUsersPanel />}
          {tab === 'schedules' && <SchedulesPanel />}
        </div>
      </Card>
    </>
  );
}
