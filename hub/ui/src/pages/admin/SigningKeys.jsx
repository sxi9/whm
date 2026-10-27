import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, Select } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { KV, Stat, StatGrid } from '../../widgets/index.jsx';

// §16.7 / §18.9: keys carry a purpose. Plugin-key rotation: create (pending,
// pinned by panels at their next check-in) → activate after ≥ 90 days (old key
// retiring, re-sign job runs) → retire once nothing references it.
export default function SigningKeys() {
  const [purpose, setPurpose] = useState('');
  const keys = useApi(`/admin/signing-keys${purpose ? `?purpose=${purpose}` : ''}`);
  const resign = useApi('/admin/market/resign-status');
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const refresh = () => { keys.refetch(); resign.refetch(); };
  const rows = keys.data || [];
  const inUse = Object.fromEntries((resign.data?.keys_in_use || []).map((k) => [k.kid, k.versions]));
  return (
    <>
      <PageHeader title="Signing keys" description="License keys sign tokens and every hub response; plugin keys sign SIGNATURE.json only. Private keys never leave /etc/whm-hub/keys." home="/admin"
        actions={<><Button disabled={busy} onClick={async () => { if (await confirm({ title: 'Create a license key', message: 'The new key starts pending. Ship it in license-keys.json of a panel release before activating it (≥ 90 days).' })) run(() => api.post('/admin/signing-keys', { purpose: 'license' }), { success: (r) => `License key ${r.data?.kid} created (pending)`, then: refresh }); }}>New license key</Button>
          <Button variant="primary" disabled={busy} onClick={async () => { if (await confirm({ title: 'Create a plugin key', message: 'Panels pin it from their next activation/check-in as "pending"; activate it after ≥ 90 days.' })) run(() => api.post('/admin/signing-keys', { purpose: 'plugin' }), { success: (r) => `Plugin key ${r.data?.kid} created (pending)`, then: refresh }); }}>New plugin key</Button></>} />
      <ErrorBanner error={keys.error} onRetry={keys.refetch} />
      <StatGrid>
        <Stat label="Active plugin key" value={resign.data?.active_kid || '—'} />
        <Stat label="Re-sign backlog" value={resign.data?.backlog ?? 0} tone={resign.data?.backlog ? 'warn' : undefined} hint={resign.data?.last_run ? `last run ${formatDate(resign.data.last_run.at || resign.data.last_run.finished_at)}` : 'no run yet'} />
        <Stat label="Keys in use by packages" value={(resign.data?.keys_in_use || []).length} hint={(resign.data?.keys_in_use || []).map((k) => `${k.kid}: ${k.versions}`).join(' · ')} />
      </StatGrid>
      <Card padded={false} actions={null}>
        <div className="filter-row" style={{ padding: '12px 16px 0' }}><Select value={purpose} onChange={setPurpose} options={['license', 'plugin']} placeholder="Both purposes" />
          {resign.data?.backlog > 0 && <Button size="sm" onClick={() => run(() => api.post('/admin/market/jobs/resign-packages/run'), { success: 'Re-sign job ran', then: refresh })}>Run re-sign job now</Button>}</div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kid</th><th>Purpose</th><th>Status</th><th>Created</th><th>Activated</th><th>Retired</th><th>Packages signed</th><th /></tr></thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.kid}>
                  <td><code>{k.kid}</code></td><td>{k.purpose}</td><td><StatusPill status={k.status} /></td><td>{formatDate(k.created_at)}</td><td>{formatDate(k.activated_at)}</td><td>{formatDate(k.retired_at)}</td><td>{k.purpose === 'plugin' ? inUse[k.kid] ?? 0 : '—'}</td>
                  <td className="inline-list">
                    {k.status === 'pending' && <Button size="sm" variant="primary" disabled={busy} onClick={async () => { if (await confirm({ title: `Activate ${k.kid}`, message: k.purpose === 'plugin' ? 'The current key becomes retiring and every approved/published package is re-signed with this key.' : 'Tokens and responses are signed with this key from now on; the old key becomes retiring.', confirmLabel: 'Activate' })) run(() => api.post(`/admin/signing-keys/${k.kid}/activate`), { success: 'Activated', then: refresh }); }}>Activate</Button>}
                    {['retiring', 'pending'].includes(k.status) && <Button size="sm" variant="danger-ghost" disabled={busy} onClick={async () => { if (await confirm({ title: `Retire ${k.kid}`, message: 'Refused with 409 key_in_use while any package or recent activation still references it. Panels drop a retired key.', danger: true, confirmLabel: 'Retire' })) run(() => api.post(`/admin/signing-keys/${k.kid}/retire`, {}), { success: 'Retired', then: refresh }); }}>Retire</Button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="muted">No signing keys; run hub/scripts/gen-key.js --license and --plugin.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Public keys">
        {rows.filter((k) => k.public_key || k.pub).map((k) => <div key={k.kid}><KV items={[[`${k.purpose} ${k.kid}`, <pre className="code-block">{k.public_key || k.pub}</pre>]]} /></div>)}
        {!rows.some((k) => k.public_key || k.pub) && <p className="muted">Public keys are published at <code>GET /v1/keys</code> (license) and <code>GET /v1/market/keys</code> (plugin).</p>}
      </Card>
    </>
  );
}
