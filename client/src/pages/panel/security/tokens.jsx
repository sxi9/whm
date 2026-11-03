import { useState } from 'react';
import { RefreshCw, Plus, Copy, KeySquare, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { PANEL_PATHS } from '../../../panel/nav.js';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isFeatureDisabled, TOKEN_SCOPES, scopeLabel, expiryState, toIsoOrNull } from './parts/shared.jsx';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,63}$/;

export function tokenRows(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows || [];
  return (rows || []).filter((t) => t.name.toLowerCase().includes(needle) || (t.scopes || []).some((s) => s.includes(needle)));
}

export default function Tokens({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/tokens');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', scopes: ['panel:read'], expires: '' });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);
  const [q, setQ] = useState('');
  const actingAs = me?.actingAs;
  const planOff = me?.account?.features?.api === false;
  const rows = tokenRows(data, q);
  const needs2fa = Boolean(me?.policy?.apiTokensRequire2fa) && !me?.user?.totpEnabled;

  if (planOff || isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const toggleScope = (scope) => setForm((f) => ({ ...f, scopes: f.scopes.includes(scope) ? f.scopes.filter((s) => s !== scope) : [...f.scopes, scope] }));
  const create = async (e) => {
    e?.preventDefault?.();
    const name = form.name.trim();
    if (!NAME_RE.test(name)) { setFormError({ message: 'Check the name', fields: { name: ['Letters, digits, spaces, ".", "_", "-", "(", ")" or "/"; up to 64 characters'] } }); return; }
    const expiresAt = toIsoOrNull(form.expires);
    if (form.expires && (!expiresAt || new Date(expiresAt).getTime() <= Date.now())) { setFormError({ message: 'Check the expiry', fields: { expiresAt: ['Choose a date and time in the future'] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name, scopes: form.scopes };
      if (expiresAt) body.expiresAt = expiresAt;
      const { data: res } = await panelApi.post('/tokens', body);
      setIssued(res);
      setOpen(false);
      setForm({ name: '', scopes: ['panel:read'], expires: '' });
      toast.success(`Token ${res.name} created`);
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const revoke = async (row) => {
    const ok = await confirm({ title: `Revoke ${row.name}?`, message: 'Scripts using this token stop working immediately. This cannot be undone; create a new token instead.', confirmLabel: 'Revoke token', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/tokens/${row.id}`); toast.success(`${row.name} revoked`); refetch(); } catch (err) { toast.error(err); }
  };

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Token copied'); } catch { toast.error('Copy failed; select the text instead'); } };

  return (
    <PanelPage fn={fn} actions={<><Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button><Button variant="primary" icon={Plus} disabled={Boolean(actingAs)} onClick={() => { setFormError(null); setOpen(true); }}>Create token</Button></>}>
      <ImpersonationNotice actingAs={actingAs} what="API tokens" />
      {needs2fa && !actingAs && (
        <div className="banner banner-warning" role="alert"><ShieldAlert size={18} /><div><strong>Two-factor authentication is needed before tokens can be issued</strong><p>The server policy asks for it. <Link to={PANEL_PATHS.twoFactor}>Set it up</Link>, then create tokens here.</p></div></div>
      )}
      <Card title="API tokens" subtitle={data?.length ? `${data.length} token${data.length === 1 ? '' : 's'} for ${me?.user?.username || 'this login'}` : 'Tokens let scripts and tools use the panel API as this login, limited to the scopes you choose.'} padded={false}>
        {isCapabilityError(error) && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'name', label: 'Name', render: (t) => <strong>{t.name}</strong> },
            { key: 'prefix', label: 'Starts with', render: (t) => <code className="small">{t.prefix}…</code> },
            { key: 'scopes', label: 'Scopes', render: (t) => (t.scopes || []).map((s) => <span key={s} className="pill pill-muted" style={{ marginRight: 4 }}>{scopeLabel(s)}</span>) },
            { key: 'expiresAt', label: 'Expires', render: (t) => { const st = expiryState(t.expiresAt); return st === 'never' ? <span className="muted">Never</span> : st === 'expired' ? <StatusPill status="warning">expired {formatDate(t.expiresAt)}</StatusPill> : formatDate(t.expiresAt); } },
            { key: 'lastUsedAt', label: 'Last used', render: (t) => (t.lastUsedAt ? formatDate(t.lastUsedAt) : <span className="muted">Never</span>) },
            { key: 'createdAt', label: 'Created', render: (t) => formatDate(t.createdAt) },
          ]}
          rows={rows} loading={loading} error={isCapabilityError(error) ? null : error} rowKey={(t) => t.id} dense
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder="Search tokens"
          rowActions={(t) => [{ label: 'Revoke', danger: true, primary: true, disabled: Boolean(actingAs), onClick: () => revoke(t) }]}
          emptyText={q ? 'No token matches the search.' : 'No API tokens yet. Create one to let a script or tool work with this account; it appears here with its scopes, expiry and last use.'}
        />
      </Card>
      <Card title="Using a token">
        <KeyValue items={[
          ['Header', <code key="h" className="small">Authorization: Bearer &lt;token&gt;</code>],
          ['Base URL', <code key="b" className="small">{typeof window !== 'undefined' ? window.location.origin : ''}/api/panel</code>],
          ['Example', <code key="e" className="small">curl -H "Authorization: Bearer $TOKEN" {typeof window !== 'undefined' ? window.location.origin : ''}/api/panel/me</code>],
          ['Scopes', 'Reads need panel:read; each group of writes needs its own scope'],
          ['Not possible with a token', 'Changing the password, the second factor, SSH keys or other tokens'],
        ]} />
      </Card>

      <Modal open={open} title="Create an API token" onClose={() => setOpen(false)} size="md"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={busy || !form.name.trim() || !form.scopes.length} onClick={create}>Create token</Button></>}>
        <form onSubmit={create}>
          <RequestError error={formError} />
          <Field label="Name" required error={formError?.fields?.name} help="What the token is for, e.g. the script or machine that uses it" htmlFor="tok-name">
            <TextInput id="tok-name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} maxLength={64} placeholder="Deploy script on build server" autoFocus />
          </Field>
          <Field label="Scopes" required error={formError?.fields?.scopes} help="Grant only what the script needs">
            <div className="radio-group">
              {TOKEN_SCOPES.map(([scope, label, help]) => (
                <label key={scope} className="radio">
                  <input type="checkbox" checked={form.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                  <span><strong>{label} <code className="small">{scope}</code></strong><small>{help}</small></span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Expires" error={formError?.fields?.expiresAt} help="Leave empty for a token that lasts until you revoke it" htmlFor="tok-exp">
            <TextInput id="tok-exp" type="datetime-local" value={form.expires} onChange={(v) => setForm((f) => ({ ...f, expires: v }))} />
          </Field>
        </form>
      </Modal>

      <Modal open={Boolean(issued)} title="Copy your new token" onClose={() => setIssued(null)} size="md" footer={<Button variant="primary" onClick={() => setIssued(null)}>I have saved it</Button>}>
        <div className="banner banner-warning"><KeySquare size={18} /><div><strong>Shown once</strong><p>The panel keeps only a hash of it. If you lose it, revoke this token and create another.</p></div></div>
        <Field label={issued?.name} htmlFor="tok-secret">
          <div className="input-group">
            <input id="tok-secret" className="input mono" readOnly value={issued?.token || ''} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={() => copy(issued?.token)}><Copy size={16} /> Copy</button>
          </div>
        </Field>
        <KeyValue items={[['Scopes', (issued?.scopes || []).map(scopeLabel).join(', ')], ['Expires', issued?.expiresAt ? formatDate(issued.expiresAt) : 'Never']]} />
      </Modal>
    </PanelPage>
  );
}
