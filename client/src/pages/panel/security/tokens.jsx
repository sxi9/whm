import { useState } from 'react';
import { RefreshCw, Plus, Copy, KeySquare, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { PANEL_PATHS } from '../../../panel/nav.js';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isFeatureDisabled, TOKEN_SCOPES, scopeKey, scopeLabel, expiryState, toIsoOrNull } from './parts/shared.jsx';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,63}$/;

export function tokenRows(rows, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows || [];
  return (rows || []).filter((t) => t.name.toLowerCase().includes(needle) || (t.scopes || []).some((s) => s.includes(needle)));
}

export default function Tokens({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
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
  const never = t('panel.security.never', 'Never');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  if (planOff || isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const toggleScope = (scope) => setForm((f) => ({ ...f, scopes: f.scopes.includes(scope) ? f.scopes.filter((s) => s !== scope) : [...f.scopes, scope] }));
  const create = async (e) => {
    e?.preventDefault?.();
    const name = form.name.trim();
    if (!NAME_RE.test(name)) { setFormError({ message: t('panel.security.token_check_name', 'Check the name'), fields: { name: [t('panel.security.token_name_rules', 'Letters, digits, spaces, ".", "_", "-", "(", ")" or "/"; up to 64 characters')] } }); return; }
    const expiresAt = toIsoOrNull(form.expires);
    if (form.expires && (!expiresAt || new Date(expiresAt).getTime() <= Date.now())) { setFormError({ message: t('panel.security.token_check_expiry', 'Check the expiry'), fields: { expiresAt: [t('panel.security.token_expiry_future', 'Choose a date and time in the future')] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name, scopes: form.scopes };
      if (expiresAt) body.expiresAt = expiresAt;
      const { data: res } = await panelApi.post('/tokens', body);
      setIssued(res);
      setOpen(false);
      setForm({ name: '', scopes: ['panel:read'], expires: '' });
      toast.success(fill(t('panel.security.token_created', 'Token {name} created'), { name: res.name }));
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const revoke = async (row) => {
    const ok = await confirm({ title: fill(t('panel.security.token_revoke_title', 'Revoke {name}?'), { name: row.name }), message: t('panel.security.token_revoke_message', 'Scripts using this token stop working immediately. This cannot be undone; create a new token instead.'), confirmLabel: t('panel.security.token_revoke_confirm', 'Revoke token'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/tokens/${row.id}`); toast.success(fill(t('panel.security.token_revoked', '{name} revoked'), { name: row.name })); refetch(); } catch (err) { toast.error(err); }
  };

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success(t('panel.security.token_copied', 'Token copied')); } catch { toast.error(t('panel.security.copy_failed', 'Copy failed; select the text instead')); } };

  return (
    <PanelPage fn={fn} actions={<><Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button><Button variant="primary" icon={Plus} disabled={Boolean(actingAs)} onClick={() => { setFormError(null); setOpen(true); }}>{t('panel.security.token_create', 'Create token')}</Button></>}>
      <ImpersonationNotice actingAs={actingAs} what={t('panel.security.tokens_what', 'API tokens')} />
      {needs2fa && !actingAs && (
        <div className="banner banner-warning" role="alert"><ShieldAlert size={18} /><div><strong>{t('panel.security.token_needs_2fa_title', 'Two-factor authentication is needed before tokens can be issued')}</strong><p>{t('panel.security.token_needs_2fa_text', 'The server policy asks for it.')} <Link to={PANEL_PATHS.twoFactor}>{t('panel.security.token_set_it_up', 'Set it up')}</Link>{t('panel.security.token_then_create', ', then create tokens here.')}</p></div></div>
      )}
      <Card title={t('panel.security.tokens_title', 'API tokens')} subtitle={data?.length ? plural(t, 'panel.security.tokens_count', data.length, '{count} token for {login}', '{count} tokens for {login}', { login: me?.user?.username || t('panel.security.this_login', 'this login') }) : t('panel.security.tokens_subtitle', 'Tokens let scripts and tools use the panel API as this login, limited to the scopes you choose.')} padded={false}>
        {isCapabilityError(error) && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'name', label: t('panel.security.col_name', 'Name'), render: (tk) => <strong>{tk.name}</strong> },
            { key: 'prefix', label: t('panel.security.col_starts_with', 'Starts with'), render: (tk) => <code className="small">{tk.prefix}…</code> },
            { key: 'scopes', label: t('panel.security.col_scopes', 'Scopes'), render: (tk) => (tk.scopes || []).map((s) => <span key={s} className="pill pill-muted" style={{ marginRight: 4 }}>{scopeLabel(s, t)}</span>) },
            { key: 'expiresAt', label: t('panel.security.col_expires', 'Expires'), render: (tk) => { const st = expiryState(tk.expiresAt); return st === 'never' ? <span className="muted">{never}</span> : st === 'expired' ? <StatusPill status="warning">{t('panel.security.token_expired', 'expired')} {formatDate(tk.expiresAt)}</StatusPill> : formatDate(tk.expiresAt); } },
            { key: 'lastUsedAt', label: t('panel.security.col_last_used', 'Last used'), render: (tk) => (tk.lastUsedAt ? formatDate(tk.lastUsedAt) : <span className="muted">{never}</span>) },
            { key: 'createdAt', label: t('panel.security.col_created', 'Created'), render: (tk) => formatDate(tk.createdAt) },
          ]}
          rows={rows} loading={loading} error={isCapabilityError(error) ? null : error} rowKey={(tk) => tk.id} dense
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder={t('panel.security.tokens_search', 'Search tokens')}
          rowActions={(tk) => [{ label: t('panel.security.token_revoke', 'Revoke'), danger: true, primary: true, disabled: Boolean(actingAs), onClick: () => revoke(tk) }]}
          emptyText={q ? t('panel.security.tokens_empty_search', 'No token matches the search.') : t('panel.security.tokens_empty', 'No API tokens yet. Create one to let a script or tool work with this account; it appears here with its scopes, expiry and last use.')}
        />
      </Card>
      <Card title={t('panel.security.token_using_title', 'Using a token')}>
        <KeyValue items={[
          [t('panel.security.token_header', 'Header'), <code key="h" className="small">Authorization: Bearer &lt;token&gt;</code>],
          [t('panel.security.token_base_url', 'Base URL'), <code key="b" className="small">{origin}/api/panel</code>],
          [t('panel.security.token_example', 'Example'), <code key="e" className="small">curl -H "Authorization: Bearer $TOKEN" {origin}/api/panel/me</code>],
          [t('panel.security.col_scopes', 'Scopes'), t('panel.security.token_scopes_value', 'Reads need panel:read; each group of writes needs its own scope')],
          [t('panel.security.token_not_possible', 'Not possible with a token'), t('panel.security.token_not_possible_value', 'Changing the password, the second factor, SSH keys or other tokens')],
        ]} />
      </Card>

      <Modal open={open} title={t('panel.security.token_create_title', 'Create an API token')} onClose={() => setOpen(false)} size="md"
        footer={<><Button onClick={() => setOpen(false)}>{t('common.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} disabled={busy || !form.name.trim() || !form.scopes.length} onClick={create}>{t('panel.security.token_create', 'Create token')}</Button></>}>
        <form onSubmit={create}>
          <RequestError error={formError} />
          <Field label={t('panel.security.col_name', 'Name')} required error={formError?.fields?.name} help={t('panel.security.token_name_help', 'What the token is for, e.g. the script or machine that uses it')} htmlFor="tok-name">
            <TextInput id="tok-name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} maxLength={64} placeholder={t('panel.security.token_name_placeholder', 'Deploy script on build server')} autoFocus />
          </Field>
          <Field label={t('panel.security.col_scopes', 'Scopes')} required error={formError?.fields?.scopes} help={t('panel.security.token_scopes_help', 'Grant only what the script needs')}>
            <div className="radio-group">
              {TOKEN_SCOPES.map(([scope, label, help]) => (
                <label key={scope} className="radio">
                  <input type="checkbox" checked={form.scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                  <span><strong>{t(scopeKey(scope), label)} <code className="small">{scope}</code></strong><small>{t(`${scopeKey(scope)}_help`, help)}</small></span>
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('panel.security.col_expires', 'Expires')} error={formError?.fields?.expiresAt} help={t('panel.security.token_expires_help', 'Leave empty for a token that lasts until you revoke it')} htmlFor="tok-exp">
            <TextInput id="tok-exp" type="datetime-local" value={form.expires} onChange={(v) => setForm((f) => ({ ...f, expires: v }))} />
          </Field>
        </form>
      </Modal>

      <Modal open={Boolean(issued)} title={t('panel.security.token_copy_title', 'Copy your new token')} onClose={() => setIssued(null)} size="md" footer={<Button variant="primary" onClick={() => setIssued(null)}>{t('panel.security.token_saved_it', 'I have saved it')}</Button>}>
        <div className="banner banner-warning"><KeySquare size={18} /><div><strong>{t('panel.security.token_shown_once', 'Shown once')}</strong><p>{t('panel.security.token_shown_once_text', 'The panel keeps only a hash of it. If you lose it, revoke this token and create another.')}</p></div></div>
        <Field label={issued?.name} htmlFor="tok-secret">
          <div className="input-group">
            <input id="tok-secret" className="input mono" readOnly value={issued?.token || ''} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={() => copy(issued?.token)}><Copy size={16} /> {t('common.copy', 'Copy')}</button>
          </div>
        </Field>
        <KeyValue items={[[t('panel.security.col_scopes', 'Scopes'), (issued?.scopes || []).map((s) => scopeLabel(s, t)).join(', ')], [t('panel.security.col_expires', 'Expires'), issued?.expiresAt ? formatDate(issued.expiresAt) : never]]} />
      </Modal>
    </PanelPage>
  );
}
