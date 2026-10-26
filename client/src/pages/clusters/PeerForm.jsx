import { useState } from 'react';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';

export const ROLE_LABEL = { 'write-only': 'Write-only (receives zones)', sync: 'Sync (receives zones, may push back)', standalone: 'Standalone (linked, never synchronised)' };
export const ROLE_HELP = {
  'write-only': 'This server pushes its zones to the peer; the peer never pushes anything here.',
  sync: 'Zones are pushed to the peer, and the peer may push its zones to this server with a cluster token issued here.',
  standalone: 'The peer is registered (for configuration sharing or later use) but takes no part in DNS synchronisation.',
};

// Add/edit form for a cluster peer. The API token is write-only: an existing
// peer keeps its token unless a new one is typed.
export function PeerForm({ initial, roles, saving, error, onSubmit, onCancel, focus = 'dns' }) {
  const editing = Boolean(initial?.id);
  const [draft, setDraft] = useState({
    name: initial?.name || '', host: initial?.host || '', token: '', role: initial?.role || (focus === 'config' ? 'standalone' : 'sync'),
    enabled: initial?.enabled ?? true, verifyTls: initial?.verifyTls ?? true, configEnabled: initial?.configEnabled ?? (focus === 'config'),
  });
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const fields = error?.fields || {};

  const submit = (e) => {
    e.preventDefault();
    const body = { name: draft.name.trim(), host: draft.host.trim(), role: draft.role, enabled: draft.enabled, verifyTls: draft.verifyTls, configEnabled: draft.configEnabled };
    if (draft.token.trim()) body.token = draft.token.trim();
    else if (!editing) body.token = '';
    onSubmit(body);
  };

  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <div className="form-grid">
        <Field label="Name" required error={fields.name} help="How the peer appears in lists and logs."><TextInput value={draft.name} onChange={(v) => set('name', v)} placeholder="ns2" autoFocus /></Field>
        <Field label="Peer address" required error={fields.host} help="Hostname or IP of the other panel. Port 2087 (HTTPS) is assumed; use http://host:2086 for a plain-HTTP panel."><TextInput value={draft.host} onChange={(v) => set('host', v)} placeholder="ns2.example.com" /></Field>
      </div>
      <Field label={editing ? 'Replace API token' : 'API token'} required={!editing} error={fields.token} help={editing ? 'Leave blank to keep the current token.' : 'A cluster token issued on the peer under Clusters > DNS Cluster > "Tokens for remote panels" (or any root API token of the peer).'}>
        <TextInput value={draft.token} onChange={(v) => set('token', v)} type="password" autoComplete="off" placeholder={editing ? '(unchanged)' : 'whm_…'} />
      </Field>
      <Field label="DNS role" error={fields.role} help={ROLE_HELP[draft.role]}><Select value={draft.role} onChange={(v) => set('role', v)} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] || r }))} /></Field>
      <Field inline><Toggle checked={draft.configEnabled} onChange={(v) => set('configEnabled', v)} label="Configuration cluster" description="Pushes of shared settings from this server reach this peer." /></Field>
      <Field inline><Toggle checked={draft.verifyTls} onChange={(v) => set('verifyTls', v)} label="Verify TLS certificate" description="Turn off only for a peer with a self-signed panel certificate." /></Field>
      <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" description="Disabled peers are kept but skipped by every push." /></Field>
      <FormActions>
        <Button type="submit" variant="primary" loading={saving}>{editing ? 'Save peer' : 'Add peer'}</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </FormActions>
    </form>
  );
}
