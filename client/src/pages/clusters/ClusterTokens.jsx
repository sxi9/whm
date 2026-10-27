import { useState } from 'react';
import { KeyRound, Copy } from 'lucide-react';
import { api } from '../../api/client.js';
import { Card, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

const PURPOSE = {
  dns: { label: 'zones', title: 'Tokens for remote panels (zones)', can: 'push zones to', issued: 'under Clusters > DNS Cluster', endpoints: 'ping, receiving zones and the zone import' },
  config: { label: 'settings', title: 'Tokens for remote panels (settings)', can: 'exchange settings with', issued: 'under Clusters > Configuration Cluster', endpoints: 'ping, serving an export and receiving settings' },
};

// Tokens other panels use to reach this one. Each carries one purpose (zones
// or settings) and reaches nothing but that purpose's endpoints. The secret
// is shown once.
export function ClusterTokens({ tokens, hostname, purpose = 'dns', onChanged }) {
  const p = PURPOSE[purpose] || PURPOSE.dns;
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);

  const issue = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), purpose };
      if (days) body.expiresInDays = days;
      const { data } = await api.post('/clusters/tokens', body);
      setIssued(data);
      setName('');
      setDays(null);
      onChanged?.();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  const revoke = async (t) => {
    if (!(await confirm({ title: `Revoke ${t.name}?`, message: 'The remote panel using this token loses access immediately. Pushes it sends afterwards are rejected until it is given a new token.', confirmLabel: 'Revoke', danger: true }))) return;
    try { await api.delete(`/clusters/tokens/${t.id}`); toast.success(`${t.name} revoked`); onChanged?.(); } catch (err) { toast.error(err); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(issued.token); toast.success('Token copied'); } catch { toast.warning('Could not access the clipboard; select the token and copy it by hand'); }
  };

  return (
    <>
      <Card title={p.title} subtitle={`A peer that wants to ${p.can} ${hostname || 'this server'} authenticates with one of these. Issue one per peer so each can be revoked on its own. A ${p.label} token is confined to ${p.endpoints}; every other API, including the other cluster's endpoints, answers it with 403.${purpose === 'dns' ? ' Tokens issued before the split (marked legacy) keep pushing zones only; reissue them when convenient.' : ''}`} padded={false}
        actions={<Button size="sm" icon={KeyRound} onClick={() => { setIssued(null); setError(null); setOpen(true); }}>Issue token</Button>}>
        <DataTable dense rows={tokens || []} rowKey={(t) => t.id} emptyText="No cluster tokens issued. A peer needs one before it can push to this server."
          columns={[
            { key: 'name', label: 'Name', render: (t) => <><strong>{t.name}</strong><br /><code style={{ fontSize: 12 }}>{t.prefix}…</code></> },
            { key: 'username', label: 'Acts as', render: (t) => <>{t.username}<br /><small className="muted" title={(t.allowed || []).join('\n')}>{PURPOSE[t.purpose]?.label || t.purpose} endpoints only{t.legacy ? ' (legacy token)' : ''}</small></> },
            { key: 'lastUsedAt', label: 'Last used', render: (t) => formatDate(t.lastUsedAt) },
            { key: 'expiresAt', label: 'Expires', render: (t) => (t.expiresAt ? formatDate(t.expiresAt) : <span className="muted">never</span>) },
            { key: 'createdAt', label: 'Issued', render: (t) => <>{formatDate(t.createdAt)}{t.createdIp && <small className="muted"> from {t.createdIp}</small>}</> },
          ]}
          rowActions={(t) => [{ label: 'Revoke', danger: true, primary: true, onClick: () => revoke(t) }]}
        />
      </Card>
      <Modal open={open} title={issued ? 'Token issued' : 'Issue a cluster token'} onClose={() => setOpen(false)} size="md">
        {issued ? (
          <>
            <div className="banner banner-warning"><div><strong>Copy it now.</strong><p>This is the only time the token is shown; only its hash is stored here.</p></div></div>
            <Field label={`Token for ${issued.name}`}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input mono" readOnly value={issued.token} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
                <Button icon={Copy} onClick={copy}>Copy</Button>
              </div>
            </Field>
            <p className="muted">On the remote panel, add {hostname || 'this server'} as a peer and paste the token as its API token. It can call only: {(issued.allowed || []).map((a) => <code key={a} style={{ fontSize: 12, marginRight: 6 }}>{a}</code>)}</p>
            {purpose === 'config' && <p className="muted">Settings arrive here only while "Accept settings pushed by peers" is on, and only for the groups this server shares.</p>}
            <FormActions><Button variant="primary" onClick={() => setOpen(false)}>Done</Button></FormActions>
          </>
        ) : (
          <form onSubmit={issue}>
            <ErrorBanner error={error && !error.fields ? error : null} />
            <Field label="Name" required error={error?.fields?.name} help="Usually the peer that will hold it."><TextInput value={name} onChange={setName} placeholder="ns1 master" autoFocus /></Field>
            <Field label="Expires in (days)" error={error?.fields?.expiresInDays} help={`Blank never expires. The token reaches the ${p.label} endpoints only; revoke it when the peer is decommissioned.`}><NumberInput value={days} onChange={setDays} min={1} max={3650} /></Field>
            <FormActions>
              <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>Issue token</Button>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
            </FormActions>
          </form>
        )}
      </Modal>
    </>
  );
}
