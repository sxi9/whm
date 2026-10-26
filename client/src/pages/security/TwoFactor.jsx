import { useState } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue } from '../../components/Common.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner, Toggle } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export default function TwoFactor({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user, refresh } = useAuth();
  const { data: settings, refetch } = useApi(user.role === 'root' ? '/system/settings?prefix=security.2fa' : null, { enabled: user.role === 'root' });
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const enroll = async () => { setBusy(true); try { const { data } = await api.post('/auth/2fa/enroll'); setEnrollment(data); } catch (err) { toast.error(err); } finally { setBusy(false); } };
  const confirmCode = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/auth/2fa/confirm', { code }); toast.success('Two-factor authentication enabled'); setEnrollment(null); setCode(''); await refresh(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const disable = async () => {
    if (!(await confirm({ title: 'Disable two-factor authentication?', message: 'Your account will be protected by password only.', confirmLabel: 'Disable', danger: true }))) return;
    try { await api.post('/auth/2fa/disable'); toast.success('Two-factor authentication disabled'); await refresh(); } catch (err) { toast.error(err); }
  };
  const setPolicy = async (v) => { try { await api.put('/system/settings', { 'security.2fa.required_for_root': v }); toast.success('Policy saved'); refetch(); } catch (err) { toast.error(err); } };

  return (
    <>
      <PageHeader fn={fn} />
      {user.mustEnroll2fa && (
        <div className="banner banner-warning" role="alert">
          <strong>Two-factor authentication is required for your role.</strong>
          <p>The server security policy requires it before you can use the rest of the panel. Set it up below to continue.</p>
        </div>
      )}
      <Card title="Your account" subtitle={`Signed in as ${user.username}`}>
        <KeyValue items={[['Status', <StatusPill key="s" status={user.totpEnabled ? 'ok' : 'warning'}>{user.totpEnabled ? 'Enabled' : 'Not enabled'}</StatusPill>]]} />
        {!user.totpEnabled && !enrollment && <FormActions><Button variant="primary" loading={busy} onClick={enroll}>Set up two-factor authentication</Button></FormActions>}
        {user.totpEnabled && <FormActions><Button variant="danger" onClick={disable}>Disable</Button></FormActions>}
        {enrollment && (
          <form onSubmit={confirmCode} className="form-narrow" style={{ marginTop: 14 }}>
            <p>Add this key to your authenticator app (Google Authenticator, Authy, 1Password…), then enter the current 6-digit code to finish.</p>
            <KeyValue items={[['Secret key', <code key="k">{enrollment.secret}</code>], ['Account', user.username]]} />
            <p className="muted" style={{ marginTop: 8 }}>Or paste this URI into an app that supports it: <code className="small">{enrollment.otpauthUrl}</code></p>
            <ErrorBanner error={error} />
            <Field label="Verification code" required><TextInput value={code} onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoFocus /></Field>
            <FormActions><Button type="submit" variant="primary" loading={busy}>Enable</Button><Button onClick={() => setEnrollment(null)}>Cancel</Button></FormActions>
          </form>
        )}
      </Card>
      {user.role === 'root' && settings && (
        <Card title="Server policy">
          <Field inline><Toggle checked={Boolean(settings['security.2fa.required_for_root'])} onChange={setPolicy} label="Require two-factor authentication for the root user" description="Root cannot log in without an authenticator once enabled." /></Field>
        </Card>
      )}
    </>
  );
}
