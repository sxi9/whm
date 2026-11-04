import { useState } from 'react';
import { ShieldCheck, ShieldOff, AlertTriangle, Copy } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, Digits } from './parts/shared.jsx';

export function statusText(state) {
  if (!state) return '—';
  if (state.enabled) return 'Enabled';
  if (state.pendingEnrollment) return 'Enrollment started';
  return 'Not enabled';
}

export default function TwoFactor({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
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

  const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Copy failed; select the text instead'); } };

  const enroll = async () => {
    setBusy(true); setFormError(null);
    try { const { data: res } = await panelApi.post('/security/two-factor/enroll', {}); setEnrollment(res); setCode(''); } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const confirmCode = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try { await panelApi.post('/security/two-factor/confirm', { code }); toast.success('Two-factor authentication enabled'); setEnrollment(null); setCode(''); await refreshAll(); } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const askDisable = async () => {
    const ok = await confirm({ title: 'Disable two-factor authentication?', message: 'Sign-in goes back to password only. You can set it up again at any time.', confirmLabel: 'Continue', danger: true });
    if (ok) setDisabling({ password: '', code: '', error: null });
  };
  const submitDisable = async (e) => {
    e?.preventDefault?.();
    const body = disabling.code ? { code: disabling.code } : { password: disabling.password };
    setBusy(true);
    try { await panelApi.post('/security/two-factor/disable', body); toast.success('Two-factor authentication disabled'); setDisabling(null); await refreshAll(); } catch (err) { setDisabling((d) => ({ ...d, error: err })); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn}>
      <ImpersonationNotice actingAs={actingAs} what="The second factor" />
      {required && !data?.enabled && !actingAs && (
        <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>Two-factor authentication is required on this server</strong><p>Set it up below to use the rest of the account panel.</p></div></div>
      )}
      <div className="grid-2">
        <Card title="Your sign-in" subtitle={`A one-time code from an authenticator app protects the ${me?.account?.username || 'account'} login.`}>
          <PanelCapabilityState error={error} onRetry={refetch} />
          <RequestError error={error} onRetry={refetch} />
          {loading && !data && <Loading />}
          {data && (
            <KeyValue items={[
              ['Status', <StatusPill key="s" status={data.enabled ? 'enabled' : data.pendingEnrollment ? 'pending' : 'warning'}>{statusText(data)}</StatusPill>],
              ['Policy', required ? 'Required for account users' : 'Optional'],
            ]} />
          )}
          <PanelCapabilityState error={formError} />
          <RequestError error={formError} />
          {data && !data.enabled && !enrollment && (
            <FormActions><Button variant="primary" icon={ShieldCheck} loading={busy} disabled={busy || Boolean(actingAs)} onClick={enroll}>Set up two-factor authentication</Button></FormActions>
          )}
          {data?.enabled && (
            <FormActions>
              <Button variant="danger" icon={ShieldOff} disabled={Boolean(actingAs) || required} onClick={askDisable}>Disable</Button>
              {required && <span className="muted small">Cannot be disabled while the server requires it.</span>}
            </FormActions>
          )}
          {enrollment && (
            <form onSubmit={confirmCode} className="form-narrow" style={{ marginTop: 14 }}>
              <p>Add this key to an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator), then enter the 6-digit code it shows to finish.</p>
              <KeyValue items={[
                ['Secret key', <span key="k" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><code>{enrollment.secret}</code><button type="button" className="icon-button" onClick={() => copy(enrollment.secret)} aria-label="Copy secret key"><Copy size={14} /></button></span>],
                ['Account', me?.user?.username || me?.account?.username],
                ['Type', 'Time-based (TOTP), 6 digits, 30 seconds'],
              ]} />
              <p className="muted small" style={{ marginTop: 8 }}>Apps that accept a link: <code className="small">{enrollment.otpauthUrl}</code> <button type="button" className="icon-button" onClick={() => copy(enrollment.otpauthUrl)} aria-label="Copy setup link"><Copy size={14} /></button></p>
              <Field label="Verification code" required htmlFor="tf-code"><Digits id="tf-code" value={code} onChange={setCode} autoFocus /></Field>
              <FormActions>
                <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Enable</Button>
                <Button onClick={() => { setEnrollment(null); setCode(''); setFormError(null); }}>Cancel</Button>
              </FormActions>
            </form>
          )}
        </Card>
        <Card title="How it works">
          <KeyValue items={[
            ['At sign-in', 'Password first, then the current code from your app'],
            ['If you lose the app', 'Your hosting provider can reset the second factor from its console (List Accounts › Reset 2FA) after checking who you are; you then sign in with your password and enrol again'],
            ['API tokens', 'Scripts keep working; tokens do not ask for a code'],
            ['Administrators', 'Cannot change this setting while logged in as you'],
          ]} />
        </Card>
      </div>

      <Modal open={Boolean(disabling)} title="Confirm it is you" onClose={() => setDisabling(null)} size="sm"
        footer={<><Button onClick={() => setDisabling(null)}>Cancel</Button><Button variant="danger" loading={busy} onClick={submitDisable} disabled={!disabling?.password && disabling?.code?.length !== 6}>Disable</Button></>}>
        <form onSubmit={submitDisable}>
          <p className="muted">Turning the second factor off needs your current password or a code from your authenticator app.</p>
          <RequestError error={disabling?.error} />
          <Field label="Current password" htmlFor="tf-pw"><TextInput id="tf-pw" type="password" autoComplete="current-password" value={disabling?.password || ''} onChange={(v) => setDisabling((d) => ({ ...d, password: v }))} autoFocus /></Field>
          <Field label="Or a 6-digit code" htmlFor="tf-dcode"><Digits id="tf-dcode" value={disabling?.code || ''} onChange={(v) => setDisabling((d) => ({ ...d, code: v }))} /></Field>
        </form>
      </Modal>
    </PanelPage>
  );
}
