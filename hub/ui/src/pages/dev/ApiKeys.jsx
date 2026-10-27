import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Button, ErrorBanner, Field, TextInput, NumberInput } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { SecretOnce } from '../../widgets/index.jsx';

export const DEV_API_SCOPES = ['plugin:read', 'plugin:write', 'version:upload', 'version:publish', 'stats:read', 'webhook:write'];

export default function ApiKeys() {
  const { session } = useAuth();
  const { data, error, refetch } = useApi('/dev/api-keys');
  const { run, busy, error: actionError } = useAction();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['plugin:read', 'version:upload']);
  const [days, setDays] = useState(null);
  const [created, setCreated] = useState(null);
  return (
    <>
      <PageHeader title="API keys" description="CI keys call /v1/dev/* with the X-Dev-Api-Key header. Keys cannot exist without 2FA and are revoked when it is disabled; † routes stay closed to keys." home="/dev" />
      {!session?.totpEnabled && <div className="banner banner-warning"><div>Enable two-factor authentication under <Link to="/dev/security">Security</Link> first.</div></div>}
      <ErrorBanner error={error} onRetry={refetch} />
      <ErrorBanner error={actionError} />
      <SecretOnce label={`API key ${created?.name || ''}`} value={created?.key || created?.secret}>Send it as <code>X-Dev-Api-Key</code>. Stored hashed; never shown again.</SecretOnce>
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Scopes</th><th>Expires</th><th>Last used</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(data || []).map((k) => <tr key={k.id}><td>{k.name}</td><td><div className="inline-list">{(k.scopes || []).map((s) => <span key={s} className="pill pill-muted">{s}</span>)}</div></td><td>{k.expires_at ? formatDate(k.expires_at) : 'never'}</td><td>{formatDate(k.last_used_at)}</td><td><StatusPill status={k.revoked_at ? 'revoked' : 'active'} /></td><td>{!k.revoked_at && <Button size="sm" variant="danger-ghost" onClick={async () => { if (await confirm({ title: 'Revoke key', message: k.name, danger: true })) run(() => api.delete(`/dev/api-keys/${k.id}`), { success: 'Revoked', then: refetch }); }}>Revoke</Button>}</td></tr>)}
              {!(data || []).length && <tr><td colSpan={6} className="muted">No API keys.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Create a key" subtitle="Needs a fresh two-factor code.">
        <Field label="Name"><TextInput value={name} onChange={setName} placeholder="github-actions" /></Field>
        <Field label="Scopes"><div className="inline-list">{DEV_API_SCOPES.map((s) => <button key={s} type="button" className={`btn btn-sm ${scopes.includes(s) ? 'btn-primary' : ''}`} onClick={() => setScopes((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}>{s}</button>)}</div></Field>
        <Field label="Expires in days (optional)"><NumberInput value={days} onChange={setDays} min={1} max={3650} /></Field>
        <Button variant="primary" loading={busy} disabled={!name || !scopes.length || !session?.totpEnabled} onClick={() => run(() => api.post('/dev/api-keys', { name, scopes, ...(days ? { expires_in_days: Number(days) } : {}) }), { success: 'Key created', then: (r) => { setCreated(r.data); setName(''); refetch(); } })}>Create key</Button>
      </Card>
    </>
  );
}
