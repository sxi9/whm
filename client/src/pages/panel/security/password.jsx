import { useState } from 'react';
import { KeyRound, AlertTriangle, Info } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isFeatureDisabled } from './parts/shared.jsx';

const MIN_STRENGTH = 65;
const MIN_LENGTH = 8;

export function validatePassword({ currentPassword, newPassword, confirm }, t = untranslated) {
  const fields = {};
  if (!currentPassword) fields.currentPassword = [t('panel.security.pw_enter_current', 'Enter your current password')];
  if (newPassword.length < MIN_LENGTH) fields.newPassword = [fill(t('panel.security.pw_min_length', 'At least {min} characters'), { min: MIN_LENGTH })];
  else if (passwordStrength(newPassword) < MIN_STRENGTH) fields.newPassword = [fill(t('panel.security.pw_weak', 'Choose a stronger password (minimum strength {min})'), { min: MIN_STRENGTH })];
  else if (newPassword === currentPassword) fields.newPassword = [t('panel.security.pw_must_differ', 'The new password must differ from the current one')];
  if (confirm !== newPassword) fields.confirm = [t('panel.security.pw_mismatch', 'The two entries do not match')];
  return Object.keys(fields).length ? { message: t('panel.security.pw_check_fields', 'Check the highlighted fields'), fields } : null;
}

export default function Password({ fn }) {
  const toast = useToast();
  const { t } = useT();
  const { refresh } = useAuth();
  const { me, reload } = usePanelMe();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const actingAs = me?.actingAs;
  const forced = Boolean(me?.account?.forcePasswordChange || me?.user?.mustChangePassword);
  const disabledPlan = me?.account?.features?.passwordchange === false;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  if (disabledPlan || isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const submit = async (e) => {
    e.preventDefault();
    const invalid = validatePassword(form, t);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/security/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      if (data.csrfToken) api.setCsrfToken(data.csrfToken);
      setResult(data);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      toast.success(t('panel.security.pw_changed_toast', 'Password changed. Other sessions of this login were signed out.'));
      await Promise.all([refresh?.(), Promise.resolve(reload?.())]);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn}>
      <ImpersonationNotice actingAs={actingAs} what={t('panel.security.pw_what', 'The password')} />
      {forced && !actingAs && (
        <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>{t('panel.security.pw_required_title', 'A new password is required')}</strong><p>{t('panel.security.pw_required_text', 'Your hosting provider asked for the password to be changed before the rest of the account panel can be used.')}</p></div></div>
      )}
      <div className="grid-2">
        <form onSubmit={submit}>
          <Card title={t('panel.security.pw_change_title', 'Change password')} subtitle={fill(t('panel.security.pw_change_subtitle', 'The password for {account}: panel sign-in, FTP main login and, where enabled, SSH.'), { account: me?.account?.username || t('panel.security.this_account', 'this account') })}>
            <PanelCapabilityState error={error} />
            <RequestError error={error} />
            <Field label={t('panel.security.pw_current', 'Current password')} required error={error?.fields?.currentPassword} htmlFor="pw-current">
              <TextInput id="pw-current" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} disabled={Boolean(actingAs)} />
            </Field>
            <Field label={t('panel.security.pw_new', 'New password')} required error={error?.fields?.newPassword} help={fill(t('panel.security.pw_new_help', 'At least {min} characters; mix letters, digits and symbols'), { min: MIN_LENGTH })} htmlFor="pw-new">
              <PasswordInput id="pw-new" value={form.newPassword} onChange={set('newPassword')} minStrength={MIN_STRENGTH} disabled={Boolean(actingAs)} />
            </Field>
            <Field label={t('panel.security.pw_repeat', 'Repeat new password')} required error={error?.fields?.confirm} htmlFor="pw-confirm">
              <TextInput id="pw-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} disabled={Boolean(actingAs)} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={busy || Boolean(actingAs) || !form.currentPassword || !form.newPassword || !form.confirm}>{t('panel.security.pw_change_title', 'Change password')}</Button>
              {result && <span className="muted small">{t('panel.security.pw_changed', 'Changed')} <PendingPill result={result.host} />{result.host?.applied === false && ` · ${t('panel.security.pw_host_pending', 'the server-side login follows once the host is ready')}`}</span>}
            </FormActions>
          </Card>
        </form>
        <Card title={t('panel.security.pw_used_title', 'Where this password is used')}>
          <KeyValue items={[
            [t('panel.security.pw_used_panel', 'Account panel'), t('panel.security.pw_used_panel_value', 'Signing in here')],
            [t('panel.security.pw_used_ftp', 'FTP main login'), me?.account?.username ? <code key="u">{me.account.username}</code> : null],
            ['SSH', me?.account?.shell && !/nologin|false$/.test(me.account.shell) ? t('panel.security.pw_ssh_enabled', 'Enabled on this account') : <StatusPill key="s" status="disabled">{t('panel.security.not_enabled', 'not enabled')}</StatusPill>],
            [t('panel.security.pw_server_login', 'Server login'), me?.policy?.passwordSynced === false ? <StatusPill key="p" status="warning">{t('panel.security.pw_not_synced', 'not synced yet')}</StatusPill> : t('panel.security.pw_in_sync', 'Kept in sync')],
          ]} />
          <div className="banner banner-info" style={{ marginTop: 14, marginBottom: 0 }}><Info size={18} /><div>{t('panel.security.pw_other_passwords', 'Mailbox, FTP and database users have their own passwords; change those on their screens. After a change you stay signed in here, every other session of this login is signed out.')}</div></div>
        </Card>
      </div>
    </PanelPage>
  );
}
