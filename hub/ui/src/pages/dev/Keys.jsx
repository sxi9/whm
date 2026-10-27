import { useState } from 'react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Textarea, Button, ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { ReasonModal } from '../../widgets/index.jsx';

// §18.2 step 3: challenge → sign with the private key → register the PEM.
// The browser never sees the private key; the developer signs locally.
export default function Keys() {
  const { data, error, refetch } = useApi('/dev/keys');
  const { run, busy, error: actionError } = useAction();
  const [challenge, setChallenge] = useState(null);
  const [pem, setPem] = useState('');
  const [label, setLabel] = useState('');
  const [sig, setSig] = useState('');
  const [revoking, setRevoking] = useState(null);
  return (
    <>
      <PageHeader title="Signing keys" description="Every upload carries DEV-SIGNATURE.json from one of your active Ed25519 keys. Keys are registered with proof of possession." home="/dev" />
      <ErrorBanner error={error} onRetry={refetch} />
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kid</th><th>Label</th><th>Status</th><th>Created</th><th>Revoked</th><th /></tr></thead>
            <tbody>
              {(data || []).map((k) => <tr key={k.kid}><td><code>{k.kid}</code></td><td>{k.label || '—'}</td><td><StatusPill status={k.status} /></td><td>{formatDate(k.created_at)}</td><td>{k.revoked_at ? `${formatDate(k.revoked_at)} · ${k.revoked_reason || ''}` : '—'}</td><td>{k.status === 'active' && <Button size="sm" variant="danger-ghost" onClick={() => setRevoking(k)}>Revoke</Button>}</td></tr>)}
              {!(data || []).length && <tr><td colSpan={6} className="muted">No signing keys yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Add a key" subtitle="Needs a fresh two-factor code. kid = first 8 hex of sha256(raw public key); it must not collide with any hub or developer key.">
        <ErrorBanner error={actionError} />
        {!challenge ? (
          <>
            <p className="muted">1. Generate a key pair locally: <code>openssl genpkey -algorithm ed25519 -out dev.pem && openssl pkey -in dev.pem -pubout -out dev.pub</code></p>
            <Button variant="primary" loading={busy} onClick={() => run(() => api.post('/dev/keys'), { then: (r) => setChallenge(r.data) })}>2. Request a challenge</Button>
          </>
        ) : (
          <>
            <p>3. Sign the raw challenge bytes (base64url-decoded) with your private key and paste the signature in standard base64. Expires in {challenge.expires_in_s} s.</p>
            <pre className="code-block">{challenge.challenge}</pre>
            <pre className="code-block">{`node -e "const c=require('crypto');const fs=require('fs');const k=c.createPrivateKey(fs.readFileSync('dev.pem'));console.log(c.sign(null,Buffer.from('${challenge.challenge}','base64url'),k).toString('base64'))"`}</pre>
            <Field label="Public key (PEM, SPKI)"><Textarea value={pem} onChange={setPem} rows={4} mono placeholder="-----BEGIN PUBLIC KEY-----" /></Field>
            <Field label="Label"><TextInput value={label} onChange={setLabel} placeholder="build server" /></Field>
            <Field label="Signature (base64)"><TextInput value={sig} onChange={setSig} /></Field>
            <div className="inline-list">
              <Button variant="primary" loading={busy} disabled={!pem.includes('BEGIN PUBLIC KEY') || !sig} onClick={() => run(() => api.post(`/dev/keys/${challenge.challenge}`, { public_key_pem: pem, sig, ...(label ? { label } : {}) }), { success: (r) => `Key ${r.data?.kid} registered`, then: () => { setChallenge(null); setPem(''); setSig(''); setLabel(''); refetch(); } })}>4. Register key</Button>
              <Button onClick={() => setChallenge(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Card>
      <ReasonModal open={Boolean(revoking)} title={`Revoke key ${revoking?.kid || ''}`} help="Uploads signed with it are refused from now on; published versions stay valid (the hub re-signed them). A compromise triggers re-verification." required={false} confirmLabel="Revoke" onClose={() => setRevoking(null)}
        onConfirm={({ reason }) => run(() => api.post(`/dev/keys/${revoking.kid}/revoke`, reason ? { reason } : {}), { success: 'Key revoked', then: refetch })} />
    </>
  );
}
