import { useState } from 'react';
import { ShieldCheck, ShieldOff, AlertTriangle, Copy } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, Digits } from './parts/shared.jsx';
import { QrCode } from '../../../components/QrCode.jsx';

export function statusText(state, t = untranslated) {
  if (!state) return '—';
  if (state.enabled) return t('panel.security.tfa_enabled', 'Enabled');
  if (state.pendingEnrollment) return t('panel.security.tfa_pending', 'Enrollment started');
  return t('panel.security.tfa_not_enabled', 'Not enabled');
}

export default function TwoFactor({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { refresh } = useAuth();
  const { me, reload } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/two-factor');
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(null);
  const actingAs = me?.actingAs;
  const required = Boolean(data?.required || me?.policy?.require2fa);
  const refreshAll = async () => { refetch(); await Promise.all([refresh?.(), Promise.resolve(reload?.())]); };
  const login = me?.user?.username || me?.account?.username;

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success(t('panel.security.copied', 'Copied')); } catch { toast.error(t('panel.security.copy_failed', 'Copy failed; select the text instead')); } };

  const enroll = async () => {
    setBusy(true); setFormError(null);
    try { const { data: res } = await panelApi.post('/security/two-factor/enroll', {}); setEnrollment(res); setCode(''); } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const confirmCode = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try { await panelApi.post('/security/two-factor/confirm', { code }); toast.success(t('panel.security.tfa_enabled_toast', 'Two-factor authentication enabled')); setEnrollment(null); setCode(''); await refreshAll(); } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const askDisable = async () => {
    const ok = await confirm({ title: t('panel.security.tfa_disable_title', 'Disable two-factor authentication?'), message: t('panel.security.tfa_disable_message', 'Sign-in goes back to password only. You can set it up again at any time.'), confirmLabel: t('panel.security.continue', 'Continue'), danger: true });
    if (ok) setDisabling({ password: '', code: '', error: null });
  };
  const submitDisable = async (e) => {
    e?.preventDefault?.();
    const body = disabling.code ? { code: disabling.code } : { password: disabling.password };
    setBusy(true);
    try { await panelApi.post('/security/two-factor/disable', body); toast.success(t('panel.security.tfa_disabled_toast', 'Two-factor authentication disabled')); setDisabling(null); await refreshAll(); } catch (err) { setDisabling((d) => ({ ...d, error: err })); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn}>
      <ImpersonationNotice actingAs={actingAs} what={t('panel.security.tfa_what', 'The second factor')} />
      {required && !data?.enabled && !actingAs && (
        <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>{t('panel.security.tfa_required_title', 'Two-factor authentication is required on this server')}</strong><p>{t('panel.security.tfa_required_text', 'Set it up below to use the rest of the account panel.')}</p></div></div>
      )}
      <div className="grid-2">
        <Card title={t('panel.security.tfa_signin_title', 'Your sign-in')} subtitle={fill(t('panel.security.tfa_signin_subtitle', 'A one-time code from an authenticator app protects the {account} login.'), { account: me?.account?.username || t('panel.security.account_lower', 'account') })}>
          <PanelCapabilityState error={error} onRetry={refetch} />
          <RequestError error={error} onRetry={refetch} />
          {loading && !data && <Loading text={t('common.loading', 'Loading…')} />}
          {data && (
            <KeyValue items={[
              [t('panel.security.col_status', 'Status'), <StatusPill key="s" status={data.enabled ? 'enabled' : data.pendingEnrollment ? 'pending' : 'warning'}>{statusText(data, t)}</StatusPill>],
              [t('panel.security.tfa_policy', 'Policy'), required ? t('panel.security.tfa_policy_required', 'Required for account users') : t('panel.security.tfa_policy_optional', 'Optional')],
            ]} />
          )}
          <PanelCapabilityState error={formError} />
          <RequestError error={formError} />
          {data && !data.enabled && !enrollment && (
            <FormActions><Button variant="primary" icon={ShieldCheck} loading={busy} disabled={busy || Boolean(actingAs)} onClick={enroll}>{t('panel.security.tfa_set_up', 'Set up two-factor authentication')}</Button></FormActions>
          )}
          {data?.enabled && (
            <FormActions>
              <Button variant="danger" icon={ShieldOff} disabled={Boolean(actingAs) || required} onClick={askDisable}>{t('panel.security.tfa_disable', 'Disable')}</Button>
              {required && <span className="muted small">{t('panel.security.tfa_cannot_disable', 'Cannot be disabled while the server requires it.')}</span>}
            </FormActions>
          )}
          {enrollment && (
            <form onSubmit={confirmCode} className="form-narrow" style={{ marginTop: 14 }}>
              <p>{t('panel.security.tfa_scan', 'Scan this code with an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator), or add the key by hand, then enter the 6-digit code it shows to finish.')}</p>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 14px' }}>
                <QrCode value={enrollment.otpauthUrl} label={fill(t('panel.security.tfa_qr_label', 'Enrolment code for {login}'), { login: login || t('panel.security.this_login', 'this login') })} fallback={<p className="muted small">{t('panel.security.tfa_qr_too_long', 'The setup link is too long for a QR code; add the secret key by hand.')}</p>} />
              </div>
              <KeyValue items={[
                [t('panel.security.tfa_secret', 'Secret key'), <span key="k" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><code>{enrollment.secret}</code><button type="button" className="icon-button" onClick={() => copy(enrollment.secret)} aria-label={t('panel.security.tfa_copy_secret', 'Copy secret key')}><Copy size={14} /></button></span>],
                [t('panel.security.account', 'Account'), login],
                [t('panel.security.col_type', 'Type'), t('panel.security.tfa_type_value', 'Time-based (TOTP), 6 digits, 30 seconds')],
              ]} />
              <p className="muted small" style={{ marginTop: 8 }}>{t('panel.security.tfa_link_apps', 'Apps that accept a link:')} <code className="small">{enrollment.otpauthUrl}</code> <button type="button" className="icon-button" onClick={() => copy(enrollment.otpauthUrl)} aria-label={t('panel.security.tfa_copy_link', 'Copy setup link')}><Copy size={14} /></button></p>
              <Field label={t('panel.security.tfa_code', 'Verification code')} required htmlFor="tf-code"><Digits id="tf-code" value={code} onChange={setCode} autoFocus /></Field>
              <FormActions>
                <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>{t('panel.security.tfa_enable', 'Enable')}</Button>
                <Button onClick={() => { setEnrollment(null); setCode(''); setFormError(null); }}>{t('common.cancel', 'Cancel')}</Button>
              </FormActions>
            </form>
          )}
        </Card>
        <Card title={t('panel.security.how_it_works', 'How it works')}>
          <KeyValue items={[
            [t('panel.security.tfa_at_signin', 'At sign-in'), t('panel.security.tfa_at_signin_value', 'Password first, then the current code from your app')],
            [t('panel.security.tfa_recovery', 'Recovery codes'), t('panel.security.tfa_recovery_value', 'Not issued on this server. If you lose the app, ask your hosting provider to reset the second factor (List Accounts › Reset 2FA) after checking who you are; you then sign in with your password and enrol again')],
            [t('panel.security.tokens_what', 'API tokens'), t('panel.security.tfa_tokens_value', 'Scripts keep working; tokens do not ask for a code')],
            [t('panel.security.tfa_admins', 'Administrators'), t('panel.security.tfa_admins_value', 'Cannot change this setting while logged in as you')],
          ]} />
        </Card>
      </div>

      <Modal open={Boolean(disabling)} title={t('panel.security.tfa_confirm_title', 'Confirm it is you')} onClose={() => setDisabling(null)} size="sm"
        footer={<><Button onClick={() => setDisabling(null)}>{t('common.cancel', 'Cancel')}</Button><Button variant="danger" loading={busy} onClick={submitDisable} disabled={!disabling?.password && disabling?.code?.length !== 6}>{t('panel.security.tfa_disable', 'Disable')}</Button></>}>
        <form onSubmit={submitDisable}>
          <p className="muted">{t('panel.security.tfa_disable_help', 'Turning the second factor off needs your current password or a code from your authenticator app.')}</p>
          <RequestError error={disabling?.error} />
          <Field label={t('panel.security.pw_current', 'Current password')} htmlFor="tf-pw"><TextInput id="tf-pw" type="password" autoComplete="current-password" value={disabling?.password || ''} onChange={(v) => setDisabling((d) => ({ ...d, password: v }))} autoFocus /></Field>
          <Field label={t('panel.security.tfa_or_code', 'Or a 6-digit code')} htmlFor="tf-dcode"><Digits id="tf-dcode" value={disabling?.code || ''} onChange={(v) => setDisabling((d) => ({ ...d, code: v }))} /></Field>
        </form>
      </Modal>
    </PanelPage>
  );
}
