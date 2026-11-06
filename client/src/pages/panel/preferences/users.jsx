import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus, Users, Info } from 'lucide-react';
import { Card, StatusPill, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, PasswordInput, Select, Toggle, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';

const MIN_STRENGTH = 65;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOME_RE = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[^\0\n]{1,512}$/;

export const EMPTY_FORM = { username: '', domain: '', fullName: '', contactEmail: '', password: '', email: false, quotaMb: null, ftp: false, homeDir: 'public_html', dav: false };

// Which services the form asks the server to create: the server requires the
// password whenever one of them switches on (or the FTP home moves).
export function needsPassword(current, next) {
  if (!current) return true;
  const s = current.services || {};
  if (!s.email?.enabled && next.email) return true;
  if (!s.ftp?.enabled && next.ftp) return true;
  if (s.ftp?.enabled && next.ftp && (next.homeDir || 'public_html') !== (s.ftp.homeDir || 'public_html')) return true;
  return false;
}

// Client-side shape checks; the server pins everything for real.
export function validateForm(form, current, t = untranslated) {
  const fields = {};
  if (!current) {
    if (!NAME_RE.test(form.username)) fields.username = [t('panel.users.name_rules', 'Lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, up to 32 characters')];
    if (!form.domain) fields.domain = [t('panel.users.domain_required', 'Choose a domain')];
  }
  if (form.contactEmail && !EMAIL_RE.test(form.contactEmail)) fields.contactEmail = [t('panel.users.email_invalid', 'Must be an email address')];
  if (form.ftp && !HOME_RE.test(form.homeDir.replace(/^\/+/, '') || 'public_html')) fields.homeDir = [t('panel.users.home_rules', 'A folder inside your home, without ".." segments')];
  const required = needsPassword(current, form);
  if ((required || form.password) && passwordStrength(form.password) < MIN_STRENGTH) fields.password = [required ? fill(t('panel.users.password_required', 'A password of strength {min} or more is required'), { min: MIN_STRENGTH }) : fill(t('panel.users.password_weak', 'Choose a stronger password (minimum strength {min})'), { min: MIN_STRENGTH })];
  return Object.keys(fields).length ? fields : null;
}

export function toBody(form, current) {
  const services = { email: { enabled: Boolean(form.email) }, ftp: { enabled: Boolean(form.ftp) }, dav: { enabled: Boolean(form.dav) } };
  if (form.email) services.email.quotaMb = form.quotaMb ?? null;
  if (form.ftp) services.ftp.homeDir = form.homeDir.trim().replace(/^\/+/, '') || 'public_html';
  const body = { fullName: form.fullName.trim(), contactEmail: form.contactEmail.trim() || null, services };
  if (!current) Object.assign(body, { username: form.username.trim(), domain: form.domain, password: form.password });
  else if (form.password) body.password = form.password;
  return body;
}

export function fromRow(row) {
  const s = row?.services || {};
  return { ...EMPTY_FORM, username: row?.username || '', domain: row?.domain || '', fullName: row?.fullName || '', contactEmail: row?.contactEmail || '', email: Boolean(s.email?.enabled), quotaMb: s.email?.quotaMb ?? null, ftp: Boolean(s.ftp?.enabled), homeDir: s.ftp?.homeDir || 'public_html', dav: Boolean(s.dav?.enabled) };
}

export function serviceBadges(row, t = untranslated) {
  const s = row?.services || {};
  const out = [];
  if (s.email?.enabled) out.push({ key: 'email', label: t('panel.users.badge_email', 'Email'), status: s.email.present === false ? 'warning' : 'ok' });
  if (s.ftp?.enabled) out.push({ key: 'ftp', label: t('panel.users.badge_ftp', 'FTP'), status: s.ftp.present === false ? 'warning' : 'ok' });
  if (s.dav?.enabled) out.push({ key: 'dav', label: t('panel.users.badge_dav', 'Calendars'), status: 'ok' });
  return out;
}

export function filterUsers(rows, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.login.toLowerCase().includes(needle) || (r.fullName || '').toLowerCase().includes(needle) || (r.contactEmail || '').toLowerCase().includes(needle));
}

function UserSheet({ open, current, meta, onClose, onSaved, canDav }) {
  const { t } = useT();
  const toast = useToast();
  const { me } = usePanelMe();
  const [form, setForm] = useState(() => (current ? fromRow(current) : { ...EMPTY_FORM, domain: meta?.domains?.[0] || me?.account?.domain || '' }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const required = needsPassword(current, form);
  const login = `${form.username || '…'}@${form.domain || '…'}`;
  const emailOn = meta?.features?.email !== false;
  const ftpOn = meta?.features?.ftp !== false;
  const home = `${me?.account?.homeDir || `/home/${me?.account?.username || ''}`}/`;

  const save = async (e) => {
    e.preventDefault();
    const fields = validateForm(form, current, t);
    if (fields) { setError({ message: t('panel.users.check_form', 'Check the form'), fields }); return; }
    setBusy(true); setError(null);
    try {
      const body = toBody(form, current);
      const res = current ? await panelApi.put(`/users/${current.id}`, body) : await panelApi.post('/users', body);
      toast.success(current ? fill(t('panel.users.saved', '{login} saved'), { login: res.data.login }) : fill(t('panel.users.created', '{login} created'), { login: res.data.login }));
      for (const w of res.meta?.warnings || []) toast.info?.(w.message || w.code);
      onSaved(res.data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={current ? fill(t('panel.users.edit_title', 'Edit {login}'), { login: current.login }) : t('panel.users.add_title', 'Add a user')} onClose={onClose} size="md" footer={<><Button onClick={onClose}>{t('panel.users.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} onClick={save} disabled={busy}>{current ? t('panel.users.save', 'Save') : t('panel.users.create', 'Create user')}</Button></>}>
      <form onSubmit={save}>
        <PanelCapabilityState error={isCapabilityError(error) ? error : null} />
        <RequestError error={error} />
        {!current && (
          <Field label={t('panel.users.username', 'User name')} required error={error?.fields?.username} help={form.username ? <>{t('panel.users.signs_in_as', 'Signs in as')} <code>{login}</code></> : t('panel.users.name_help', 'Lowercase letters, digits, ".", "_" or "-"')} htmlFor="su-name">
            <div className="input-group">
              <TextInput id="su-name" value={form.username} onChange={(v) => set({ username: v.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} placeholder="jane" maxLength={32} autoCapitalize="none" spellCheck={false} />
              <span className="input" style={{ flex: '0 0 auto' }}>@</span>
              <Select id="su-domain" value={form.domain} onChange={(v) => set({ domain: v })} options={(meta?.domains || []).map((d) => ({ value: d, label: d }))} />
            </div>
          </Field>
        )}
        <Field label={t('panel.users.full_name', 'Full name')} error={error?.fields?.fullName} htmlFor="su-fullname"><TextInput id="su-fullname" value={form.fullName} onChange={(v) => set({ fullName: v })} maxLength={128} /></Field>
        <Field label={t('panel.users.contact_email', 'Contact email')} error={error?.fields?.contactEmail} help={t('panel.users.contact_help', 'Where this person can be reached; not a mailbox on this account')} htmlFor="su-contact"><TextInput id="su-contact" type="email" value={form.contactEmail} onChange={(v) => set({ contactEmail: v })} maxLength={254} /></Field>

        <h4 style={{ margin: '18px 0 8px' }}>{t('panel.users.services', 'Services')}</h4>
        <Toggle checked={form.email} onChange={(v) => set({ email: v })} disabled={!emailOn} label={t('panel.users.service_email', 'Email')} description={emailOn ? fill(t('panel.users.service_email_help', 'A mailbox {login} with its own webmail login'), { login }) : t('panel.users.not_in_plan', 'Not included in your plan')} />
        {form.email && (
          <Field label={t('panel.users.quota', 'Mailbox size (MB)')} error={error?.fields?.quotaMb} help={t('panel.users.quota_help', 'Leave empty for the default mailbox size')} htmlFor="su-quota"><NumberInput id="su-quota" value={form.quotaMb} onChange={(v) => set({ quotaMb: v })} min={0} placeholder={t('panel.users.default', 'Default')} /></Field>
        )}
        <Toggle checked={form.ftp} onChange={(v) => set({ ftp: v })} disabled={!ftpOn} label={t('panel.users.service_ftp', 'FTP')} description={ftpOn ? fill(t('panel.users.service_ftp_help', 'An FTP login {login} limited to one folder of your account'), { login }) : t('panel.users.not_in_plan', 'Not included in your plan')} />
        {form.ftp && (
          <Field label={t('panel.users.home_dir', 'Folder')} required error={error?.fields?.homeDir} help={t('panel.users.home_help', 'The login sees this folder and everything below it; it is created if missing')} htmlFor="su-home">
            <div className="input-group">
              <input className="input" value={home} readOnly tabIndex={-1} aria-label={t('panel.users.home_prefix', 'Home directory')} style={{ flex: '0 0 auto', width: `calc(${home.length}ch + 32px)` }} />
              <TextInput id="su-home" value={form.homeDir} onChange={(v) => set({ homeDir: v })} placeholder="public_html" spellCheck={false} />
            </div>
          </Field>
        )}
        {canDav && <Toggle checked={form.dav} onChange={(v) => set({ dav: v })} label={t('panel.users.service_dav', 'Calendars and contacts')} description={fill(t('panel.users.service_dav_help', 'A CalDAV/CardDAV login {login}; its password is set on the Calendars page'), { login })} />}

        <Field label={current ? t('panel.users.password_edit', 'Password') : t('panel.users.password', 'Password')} required={required} error={error?.fields?.password} help={current ? (required ? t('panel.users.password_needed_help', 'Needed to switch a service on: the same password works for every service') : t('panel.users.password_keep_help', 'Leave empty to keep the current password')) : t('panel.users.password_help', 'One password for every service of this user')} htmlFor="su-password">
          <PasswordInput id="su-password" value={form.password} onChange={(v) => set({ password: v })} minStrength={MIN_STRENGTH} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

export default function UserManager({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { hasFeature } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/users');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(null);
  const [pwFor, setPwFor] = useState(null);
  const [pw, setPw] = useState('');
  const [pwError, setPwError] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => filterUsers(data || [], q), [data, q]);
  const capability = isCapabilityError(error);
  const limitReached = meta?.max != null && (data?.length ?? 0) >= meta.max;
  const canDav = typeof hasFeature === 'function' ? hasFeature('caldav') : false;

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const remove = async (row) => {
    const badges = serviceBadges(row, t).map((b) => b.label).join(', ');
    const ok = await confirm({ title: fill(t('panel.users.delete_title', 'Delete {login}?'), { login: row.login }), message: badges ? fill(t('panel.users.delete_message', 'Its services ({services}) are removed with it, including the mailbox and its messages.'), { services: badges }) : t('panel.users.delete_message_plain', 'This user has no services; only the entry is removed.'), confirmLabel: t('panel.users.delete', 'Delete user'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/users/${row.id}`); toast.success(fill(t('panel.users.deleted', '{login} deleted'), { login: row.login })); refetch(); } catch (err) { toast.error(err); }
  };

  const changePassword = async () => {
    if (passwordStrength(pw) < MIN_STRENGTH) { setPwError({ message: fill(t('panel.users.password_weak', 'Choose a stronger password (minimum strength {min})'), { min: MIN_STRENGTH }) }); return; }
    setBusy(true); setPwError(null);
    try {
      const { data: res } = await panelApi.put(`/users/${pwFor.id}/password`, { password: pw });
      toast.success(res.applied?.length ? fill(t('panel.users.password_changed', 'Password changed for {login} ({services})'), { login: pwFor.login, services: res.applied.join(', ') }) : fill(t('panel.users.password_changed_none', '{login} has no service to apply the password to'), { login: pwFor.login }));
      setPwFor(null); setPw('');
    } catch (err) { setPwError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn} actions={<><Button icon={RefreshCw} onClick={() => refetch()}>{t('panel.users.refresh', 'Refresh')}</Button><Button variant="primary" icon={Plus} onClick={() => setSheet({ current: null })} disabled={limitReached || capability}>{t('panel.users.add', 'Add user')}</Button></>}>
      {limitReached && <div className="banner banner-info"><Info size={18} /><div>{fill(t('panel.users.limit', 'Your plan allows {max} users and all of them exist. Delete one you no longer need or ask your hosting provider about a larger plan.'), { max: meta.max })}</div></div>}
      <Card title={t('panel.users.title', 'Users')} subtitle={t('panel.users.subtitle', 'People who use this account\'s services with their own login: a mailbox, an FTP folder, calendars. They never sign in to this panel.')} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {!capability && !loading && !error && !data?.length && !q ? (
          <div className="card-body"><EmptyState icon={Users} title={t('panel.users.empty_title', 'No users yet')}>{t('panel.users.empty', 'Add a user to give someone a mailbox and an FTP folder with one password, and switch services on or off later.')}</EmptyState></div>
        ) : (
          <DataTable
            columns={[
              { key: 'login', label: t('panel.users.col_user', 'User'), render: (r) => <><code>{r.login}</code>{r.fullName && <div className="muted small">{r.fullName}</div>}</> },
              { key: 'services', label: t('panel.users.col_services', 'Services'), render: (r) => { const b = serviceBadges(r, t); return b.length ? <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>{b.map((x) => <StatusPill key={x.key} status={x.status}>{x.label}</StatusPill>)}</span> : <span className="muted">{t('panel.users.no_services', 'None')}</span>; } },
              { key: 'contactEmail', label: t('panel.users.col_contact', 'Contact'), render: (r) => r.contactEmail || <span className="muted">—</span> },
              { key: 'createdAt', label: t('panel.users.col_created', 'Created'), render: (r) => (r.createdAt ? formatDate(r.createdAt) : <span className="muted">—</span>) },
            ]}
            rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
            searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder={t('panel.users.search', 'Search users')}
            rowActions={(r) => [
              { label: t('panel.users.edit', 'Edit'), primary: true, onClick: () => setSheet({ current: r }) },
              { label: t('panel.users.change_password', 'Change password'), onClick: () => { setPwFor(r); setPw(''); setPwError(null); } },
              { label: t('panel.users.delete', 'Delete user'), danger: true, onClick: () => remove(r) },
            ]}
            emptyText={q ? t('panel.users.no_match', 'No user matches the search.') : t('panel.users.empty', 'Add a user to give someone a mailbox and an FTP folder with one password, and switch services on or off later.')}
          />
        )}
      </Card>
      <p className="muted small">{t('panel.users.footnote', 'A user\'s mailbox also appears under')} <Link to="/panel/email/accounts">{t('panel.email/accounts.label', 'Email accounts')}</Link> {t('panel.users.footnote_and', 'and its FTP login under')} <Link to="/panel/ftp/accounts">{t('panel.ftp/accounts.label', 'FTP accounts')}</Link>{t('panel.users.footnote_end', ', where you can also change them.')}</p>

      {sheet && <UserSheet open current={sheet.current} meta={meta} canDav={canDav} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); refetch(); }} />}

      <Modal open={Boolean(pwFor)} title={pwFor ? fill(t('panel.users.password_title', 'Change password of {login}'), { login: pwFor.login }) : ''} onClose={() => setPwFor(null)} size="sm" footer={<><Button onClick={() => setPwFor(null)}>{t('panel.users.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} onClick={changePassword} disabled={!pw}>{t('panel.users.change_password', 'Change password')}</Button></>}>
        <PanelCapabilityState error={pwError} />
        <RequestError error={pwError} />
        <Field label={t('panel.users.new_password', 'New password')} required htmlFor="su-newpw"><PasswordInput id="su-newpw" value={pw} onChange={setPw} minStrength={MIN_STRENGTH} /></Field>
        <p className="muted">{pwFor ? fill(t('panel.users.password_applies', 'Applies to: {services}.'), { services: serviceBadges(pwFor, t).map((b) => b.label).join(', ') || t('panel.users.no_services', 'None') }) : ''} {t('panel.users.password_note', 'Anyone using this login needs the new password from now on.')}</p>
      </Modal>
    </PanelPage>
  );
}
