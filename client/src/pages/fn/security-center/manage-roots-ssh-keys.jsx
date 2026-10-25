import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Select, Button, FormActions, PasswordInput, Toggle } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../security/Shared.jsx';

export default function ManageRootsSshKeys({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/ssh/keys');
  const [gen, setGen] = useState({ name: 'id_ed25519', type: 'ed25519', bits: '', comment: '', passphrase: '', authorize: true });
  const [imported, setImported] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);

  const run = async (label, fnc) => {
    setBusy(true);
    try { await fnc(); if (label) toast.success(label); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const generate = () => run(`Key "${gen.name}" generated`, () => api.post('/security/ssh/keys/generate', {
    name: gen.name, type: gen.type, ...(gen.bits ? { bits: Number(gen.bits) } : {}), ...(gen.comment ? { comment: gen.comment } : {}), ...(gen.passphrase ? { passphrase: gen.passphrase } : {}), authorize: gen.authorize,
  }));
  const importKey = () => run('Key authorized', async () => { await api.post('/security/ssh/keys', { publicKey: imported.trim() }); setImported(''); });
  const deauthorize = async (k) => {
    if (!(await confirm({ title: 'Remove this key from authorized_keys?', message: `${k.type} ${k.fingerprint}${k.comment ? ` (${k.comment})` : ''} will no longer be able to log in as root.`, confirmLabel: 'De-authorize', danger: true }))) return;
    run('Key de-authorized', () => api.post('/security/ssh/keys/deauthorize', { fingerprint: k.fingerprint }));
  };
  const deletePair = async (k) => {
    if (!(await confirm({ title: `Delete key pair "${k.name}"?`, message: 'The private and public key files are removed from /root/.ssh and the key is de-authorized. This cannot be undone.', confirmLabel: 'Delete', danger: true, typeToConfirm: k.name }))) return;
    run('Key pair deleted', () => api.delete(`/security/ssh/keys/${k.name}?deauthorize=true`));
  };
  const view = async (k) => {
    if (!(await confirm({ title: 'Show the private key?', message: 'Anyone who sees this key can log in as root. The export is recorded in the audit log.', confirmLabel: 'Show key' }))) return;
    try { const { data: d } = await api.get(`/security/ssh/keys/${k.name}/private`); setViewing(d); } catch (err) { toast.error(err); }
  };

  const bitsOptions = gen.type === 'rsa' ? ['2048', '3072', '4096'] : gen.type === 'ecdsa' ? ['256', '384', '521'] : [];

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Key pairs in /root/.ssh" padded={false}>
            <DataTable columns={[
              { key: 'name', label: 'Name', render: (k) => <code>{k.name}</code> },
              { key: 'type', label: 'Type' },
              { key: 'fingerprint', label: 'Fingerprint', render: (k) => <code className="small">{k.fingerprint}</code> },
              { key: 'comment', label: 'Comment' },
              { key: 'authorized', label: 'Authorized', render: (k) => <StatusPill status={k.authorized ? 'ok' : 'inactive'}>{k.authorized ? 'yes' : 'no'}</StatusPill> },
              { key: 'createdAt', label: 'Created', render: (k) => formatDate(k.createdAt) },
            ]} rows={data.keys} rowKey={(k) => k.name} dense emptyText="No key pairs yet. Generate one below."
              rowActions={(k) => [
                k.authorized ? { label: 'De-authorize', primary: true, onClick: () => deauthorize(k) } : { label: 'Authorize', primary: true, onClick: () => run('Key authorized', () => api.post(`/security/ssh/keys/${k.name}/authorize`)) },
                k.hasPrivateKey && { label: 'View private key', onClick: () => view(k) },
                { label: 'Copy public key', onClick: () => navigator.clipboard?.writeText(k.publicKey).then(() => toast.success('Public key copied')) },
                { label: 'Delete key pair', danger: true, onClick: () => deletePair(k) },
              ]} />
          </Card>
          <Card title="Authorized keys" subtitle="Every key that may log in as root, including keys imported from elsewhere." padded={false}>
            <DataTable columns={[
              { key: 'type', label: 'Type' },
              { key: 'fingerprint', label: 'Fingerprint', render: (k) => <code className="small">{k.fingerprint}</code> },
              { key: 'comment', label: 'Comment' },
              { key: 'options', label: 'Options', render: (k) => (k.options ? <code className="small">{k.options}</code> : '—') },
            ]} rows={data.authorized} rowKey={(k) => `${k.index}-${k.fingerprint}`} dense emptyText="No key is authorized. Keep password authentication on until one is."
              rowActions={(k) => [{ label: 'De-authorize', danger: true, primary: true, onClick: () => deauthorize(k) }]} />
          </Card>
          <div className="form-grid">
            <Card title="Generate a new key" subtitle={data.keygenAvailable ? 'Uses ssh-keygen on the server.' : 'ssh-keygen is not installed on this server.'}>
              <Field label="Name" required><TextInput value={gen.name} onChange={(v) => setGen({ ...gen, name: v })} /></Field>
              <Field label="Type"><Select value={gen.type} onChange={(v) => setGen({ ...gen, type: v, bits: '' })} options={[{ value: 'ed25519', label: 'Ed25519 (recommended)' }, { value: 'rsa', label: 'RSA' }, { value: 'ecdsa', label: 'ECDSA' }]} /></Field>
              {bitsOptions.length > 0 && <Field label="Bits"><Select value={gen.bits} onChange={(v) => setGen({ ...gen, bits: v })} options={bitsOptions} placeholder="default" /></Field>}
              <Field label="Comment"><TextInput value={gen.comment} onChange={(v) => setGen({ ...gen, comment: v })} placeholder="root@server" /></Field>
              <Field label="Passphrase" help="Optional; protects the private key file at rest."><PasswordInput value={gen.passphrase} onChange={(v) => setGen({ ...gen, passphrase: v })} showStrength={false} allowGenerate={false} /></Field>
              <Field inline><Toggle checked={gen.authorize} onChange={(v) => setGen({ ...gen, authorize: v })} label="Authorize immediately" /></Field>
              <FormActions><Button variant="primary" loading={busy} disabled={!gen.name || !data.keygenAvailable} onClick={generate}>Generate key</Button></FormActions>
            </Card>
            <Card title="Import a public key" subtitle="Paste one OpenSSH public key line to authorize it for root.">
              <Field label="Public key"><Textarea value={imported} onChange={setImported} rows={4} mono placeholder="ssh-ed25519 AAAA… user@laptop" /></Field>
              <FormActions><Button variant="primary" loading={busy} disabled={!imported.trim()} onClick={importKey}>Authorize key</Button></FormActions>
            </Card>
          </div>
        </>
      )}
      <Modal open={Boolean(viewing)} title={`Private key: ${viewing?.name}`} onClose={() => setViewing(null)} size="lg"
        footer={<><Button onClick={() => navigator.clipboard?.writeText(viewing.privateKey).then(() => toast.success('Private key copied'))}>Copy</Button><Button variant="primary" onClick={() => setViewing(null)}>Close</Button></>}>
        {viewing && <><pre className="log" style={{ maxHeight: 360 }}>{viewing.privateKey}</pre><p className="muted">Public key: <code className="small">{viewing.publicKey}</code></p></>}
      </Modal>
    </>
  );
}
