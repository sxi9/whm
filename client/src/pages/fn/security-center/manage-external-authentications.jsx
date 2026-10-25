import { useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../security/Shared.jsx';

const EMPTY = { name: '', displayName: '', issuerUrl: '', clientId: '', clientSecret: '', scopes: 'openid email profile', enabled: true };

function ProviderForm({ initial, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState(initial || EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const editing = Boolean(initial);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { displayName: form.displayName, issuerUrl: form.issuerUrl, clientId: form.clientId, scopes: form.scopes, enabled: form.enabled, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) };
      if (editing) await api.put(`/security/external-auth/${initial.name}`, body); else await api.post('/security/external-auth', { name: form.name, ...body });
      toast.success(editing ? 'Provider updated' : 'Provider added');
      onDone(true);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        {!editing && <Field label="Identifier" required help="Lowercase; used in URLs" error={error?.fields?.name}><TextInput value={form.name} onChange={set('name')} placeholder="okta" /></Field>}
        <Field label="Display name" required error={error?.fields?.displayName}><TextInput value={form.displayName} onChange={set('displayName')} placeholder="Company SSO" /></Field>
        <Field label="Issuer URL" required help="The OpenID Connect issuer; discovery reads <issuer>/.well-known/openid-configuration" error={error?.fields?.issuerUrl}><TextInput value={form.issuerUrl} onChange={set('issuerUrl')} placeholder="https://login.example.com" /></Field>
        <Field label="Client ID" required error={error?.fields?.clientId}><TextInput value={form.clientId} onChange={set('clientId')} /></Field>
        <Field label="Client secret" help={editing ? 'Leave empty to keep the stored secret' : 'Stored encrypted with the panel master key'} error={error?.fields?.clientSecret}><PasswordInput value={form.clientSecret} onChange={set('clientSecret')} showStrength={false} allowGenerate={false} autoComplete="off" /></Field>
        <Field label="Scopes" error={error?.fields?.scopes}><TextInput value={form.scopes} onChange={set('scopes')} /></Field>
      </div>
      <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" /></Field>
      <FormActions><Button type="submit" variant="primary" loading={busy}>{editing ? 'Save' : 'Add provider'}</Button><Button onClick={() => onDone(false)}>Cancel</Button></FormActions>
    </form>
  );
}

export default function ManageExternalAuthentications({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/external-auth');
  const { data: settings, refetch: refetchSettings } = useApi('/system/settings?prefix=security.external_auth');
  const [modal, setModal] = useState(null);

  const setSetting = async (key, value) => { try { await api.put('/system/settings', { [key]: value }); toast.success('Saved'); refetchSettings(); } catch (err) { toast.error(err); } };
  const discover = async (p) => { try { const { data: d } = await api.post(`/security/external-auth/${p.name}/discover`); toast.success(`Discovered ${d.discovery.issuer || p.issuerUrl}`); refetch(); } catch (err) { toast.error(err); } };
  const toggle = async (p) => { try { await api.put(`/security/external-auth/${p.name}`, { enabled: !p.enabled }); refetch(); } catch (err) { toast.error(err); } };
  const remove = async (p) => {
    if (!(await confirm({ title: `Delete provider "${p.displayName}"?`, message: `${p.links} linked user${p.links === 1 ? '' : 's'} will lose the ability to sign in through it.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/security/external-auth/${p.name}`); toast.success('Provider deleted'); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setModal({ mode: 'create' })}>Add provider</Button>} description="OpenID Connect providers (Okta, Azure AD, Keycloak, Google Workspace…) that panel users may link to their account and sign in with." />
      <RequestError error={error} onRetry={refetch} />
      {settings && (
        <Card title="Policy">
          <Field inline><Toggle checked={Boolean(settings['security.external_auth.enabled'])} onChange={(v) => setSetting('security.external_auth.enabled', v)} label="Allow external authentication on the login page" /></Field>
          <Field inline><Toggle checked={Boolean(settings['security.external_auth.auto_link_by_email'])} onChange={(v) => setSetting('security.external_auth.auto_link_by_email', v)} label="Automatically link identities whose verified email matches a panel user" description="Otherwise users must link a provider while signed in." /></Field>
        </Card>
      )}
      {loading && !data && <Loading />}
      {data && (
        <Card title="Providers" padded={false}>
          <DataTable columns={[
            { key: 'displayName', label: 'Provider', render: (p) => <><div>{p.displayName}</div><small className="muted"><code>{p.name}</code></small></> },
            { key: 'issuerUrl', label: 'Issuer', render: (p) => <a href={p.issuerUrl} target="_blank" rel="noreferrer">{p.issuerUrl}</a> },
            { key: 'clientId', label: 'Client ID', render: (p) => <code className="small">{p.clientId}</code> },
            { key: 'discovery', label: 'Discovery', render: (p) => (p.discovery ? <StatusPill status="ok">fetched {formatDate(p.discovery.fetchedAt)}</StatusPill> : <StatusPill status="warning">not run</StatusPill>) },
            { key: 'links', label: 'Linked users', align: 'right' },
            { key: 'enabled', label: 'Status', render: (p) => <StatusPill status={p.enabled ? 'enabled' : 'disabled'} /> },
          ]} rows={data} rowKey={(p) => p.name} emptyText="No identity providers configured."
            rowActions={(p) => [
              { label: 'Discover', primary: true, onClick: () => discover(p) },
              { label: 'Edit', onClick: () => setModal({ mode: 'edit', provider: p }) },
              { label: p.enabled ? 'Disable' : 'Enable', onClick: () => toggle(p) },
              { label: 'Delete', danger: true, onClick: () => remove(p) },
            ]} />
        </Card>
      )}
      <Modal open={Boolean(modal)} title={modal?.mode === 'edit' ? `Edit ${modal.provider.displayName}` : 'Add an identity provider'} onClose={() => setModal(null)} size="lg">
        {modal && <ProviderForm initial={modal.mode === 'edit' ? { ...modal.provider, clientSecret: '' } : null} onDone={(changed) => { setModal(null); if (changed) refetch(); }} />}
      </Modal>
    </>
  );
}
