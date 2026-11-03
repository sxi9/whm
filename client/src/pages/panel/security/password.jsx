import { useState } from 'react';
import { KeyRound, AlertTriangle, Info } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isFeatureDisabled } from './parts/shared.jsx';

const MIN_STRENGTH = 65;
const MIN_LENGTH = 8;

export function validatePassword({ currentPassword, newPassword, confirm }) {
  const fields = {};
  if (!currentPassword) fields.currentPassword = ['Enter your current password'];
  if (newPassword.length < MIN_LENGTH) fields.newPassword = [`At least ${MIN_LENGTH} characters`];
  else if (passwordStrength(newPassword) < MIN_STRENGTH) fields.newPassword = [`Choose a stronger password (minimum strength ${MIN_STRENGTH})`];
  else if (newPassword === currentPassword) fields.newPassword = ['The new password must differ from the current one'];
  if (confirm !== newPassword) fields.confirm = ['The two entries do not match'];
  return Object.keys(fields).length ? { message: 'Check the highlighted fields', fields } : null;
}

export default function Password({ fn }) {
  const toast = useToast();
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
    const invalid = validatePassword(form);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await panelApi.post('/security/password', { currentPassword: form.currentPassword, newPassword: form.newPassword });
      if (data.csrfToken) api.setCsrfToken(data.csrfToken);
      setResult(data);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      toast.success('Password changed. Other sessions of this login were signed out.');
      await Promise.all([refresh?.(), Promise.resolve(reload?.())]);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn}>
      <ImpersonationNotice actingAs={actingAs} what="The password" />
      {forced && !actingAs && (
        <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>A new password is required</strong><p>Your hosting provider asked for the password to be changed before the rest of the account panel can be used.</p></div></div>
      )}
      <div className="grid-2">
        <form onSubmit={submit}>
          <Card title="Change password" subtitle={`The password for ${me?.account?.username || 'this account'}: panel sign-in, FTP main login and, where enabled, SSH.`}>
            <PanelCapabilityState error={error} />
            <RequestError error={error} />
            <Field label="Current password" required error={error?.fields?.currentPassword} htmlFor="pw-current">
              <TextInput id="pw-current" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} disabled={Boolean(actingAs)} />
            </Field>
            <Field label="New password" required error={error?.fields?.newPassword} help={`At least ${MIN_LENGTH} characters; mix letters, digits and symbols`} htmlFor="pw-new">
              <PasswordInput id="pw-new" value={form.newPassword} onChange={set('newPassword')} minStrength={MIN_STRENGTH} disabled={Boolean(actingAs)} />
            </Field>
            <Field label="Repeat new password" required error={error?.fields?.confirm} htmlFor="pw-confirm">
              <TextInput id="pw-confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} disabled={Boolean(actingAs)} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={busy || Boolean(actingAs) || !form.currentPassword || !form.newPassword || !form.confirm}>Change password</Button>
              {result && <span className="muted small">Changed <PendingPill result={result.host} />{result.host?.applied === false && ' · the server-side login follows once the host is ready'}</span>}
            </FormActions>
          </Card>
        </form>
        <Card title="Where this password is used">
          <KeyValue items={[
            ['Account panel', 'Signing in here'],
            ['FTP main login', me?.account?.username ? <code key="u">{me.account.username}</code> : null],
            ['SSH', me?.account?.shell && !/nologin|false$/.test(me.account.shell) ? 'Enabled on this account' : <StatusPill key="s" status="disabled">not enabled</StatusPill>],
            ['Server login', me?.policy?.passwordSynced === false ? <StatusPill key="p" status="warning">not synced yet</StatusPill> : 'Kept in sync'],
          ]} />
          <div className="banner banner-info" style={{ marginTop: 14, marginBottom: 0 }}><Info size={18} /><div>Mailbox, FTP and database users have their own passwords; change those on their screens. After a change you stay signed in here, every other session of this login is signed out.</div></div>
        </Card>
      </div>
    </PanelPage>
  );
}
