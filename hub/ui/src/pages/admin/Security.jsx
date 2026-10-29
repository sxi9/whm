import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, ErrorBanner, Toggle } from '../../components/Form.jsx';
import { TotpEnrolment } from '../../components/QrCode.jsx';
import { api } from '../../api/client.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// Portal (vendor + reseller) account security: TOTP enrolment through
// POST /portal/2fa/enroll → /confirm (QR + secret + URI), disable with a
// current code, the password change (the hub destroys the session, so the
// user signs in again) and, for vendor admins, the portal-wide policy
// hub.require_totp_for_admins. Mounted at /admin/security and
// /reseller/security with `home` set per area.

export function PortalTotpPanel({ home = '/admin' }) {
  const { session, markTotpEnabled } = useAuth();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const enabled = Boolean(session?.totpEnabled);
  const required = Boolean(session?.totpEnrolRequired) && !enabled;
  const valid = /^\d{6}$/.test(code);
  const startEnrol = () => run(() => api.post('/portal/2fa/enroll', enabled && valid ? { code } : {}), { then: (r) => { setPending(r.data); setCode(''); } });
  const confirm = () => run(() => api.post('/portal/2fa/confirm', { code }), {
    success: 'Two-factor authentication enabled',
    then: () => { setPending(null); setCode(''); markTotpEnabled(true); if (required) navigate(home, { replace: true }); },
  });
  const disable = () => run(() => api.post('/portal/2fa/disable', { code }), { success: 'Two-factor authentication disabled', then: () => { setCode(''); markTotpEnabled(false); } });
  return (
    <>
      <ErrorBanner error={error} />
      <p><StatusPill status={enabled ? 'enabled' : 'disabled'} /> <span className="muted">Every sensitive action (signing keys, API keys, portal users, marketplace decisions, money) asks for a fresh code; without 2FA those actions are refused.</span></p>
      {!enabled && !pending && <Button variant="primary" loading={busy} onClick={startEnrol} data-testid="portal-totp-start">{required ? 'Enrol now' : 'Start enrolment'}</Button>}
      {pending && (
        <>
          <TotpEnrolment secret={pending.secret} uri={pending.uri} account={session?.user?.email} />
          <Field label="Code" htmlFor="portal-totp-confirm"><TextInput id="portal-totp-confirm" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus /></Field>
          <div className="inline-list">
            <Button variant="primary" loading={busy} disabled={!valid} onClick={confirm}>Confirm</Button>
            <Button onClick={() => { setPending(null); setCode(''); }}>Cancel</Button>
          </div>
        </>
      )}
      {enabled && !pending && (
        <>
          <Field label="Current code" htmlFor="portal-totp-code" help="Needed to disable 2FA or to replace the secret with a new one."><TextInput id="portal-totp-code" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></Field>
          <div className="inline-list">
            <Button loading={busy} disabled={!valid} onClick={startEnrol}>Replace secret</Button>
            <Button variant="danger" loading={busy} disabled={!valid} onClick={disable}>Disable 2FA</Button>
          </div>
        </>
      )}
    </>
  );
}

export function PortalPasswordPanel({ home = '/admin' }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = () => run(() => api.post('/portal/password', { current, next }), {
    success: 'Password changed; sign in again',
    then: async () => { await refresh(); navigate('/login', { replace: true, state: { from: home } }); },
  });
  return (
    <>
      <ErrorBanner error={error} />
      <Field label="Current password" htmlFor="portal-password-current"><TextInput id="portal-password-current" type="password" value={current} onChange={setCurrent} autoComplete="current-password" /></Field>
      <Field label="New password" htmlFor="portal-password-next" help="At least 10 characters. Every session of this account is signed out."><PasswordInput id="portal-password-next" value={next} onChange={setNext} /></Field>
      <Button variant="primary" loading={busy} disabled={!current || next.length < 10} onClick={change}>Change password</Button>
    </>
  );
}

// hub.require_totp_for_admins, vendor admins only. Loaded in an effect (not
// useApi) so the page renders without the policy while it is fetched; the
// PATCH is a step-up route, the API client re-prompts for the code.
export function PortalPolicyPanel() {
  const { session } = useAuth();
  const { run, busy, error } = useAction();
  const [policy, setPolicy] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const canEdit = session?.user?.role === 'vendor_admin' && session?.totpEnabled;
  useEffect(() => {
    if (!canEdit) return undefined;
    let alive = true;
    api.get('/portal/settings').then((r) => { if (alive) setPolicy(r.data); }, (err) => { if (alive) setLoadError(err); });
    return () => { alive = false; };
  }, [canEdit]);
  if (!canEdit) return null;
  const save = (value) => run(() => api.patch('/portal/settings', { require_totp_for_admins: value }), { success: value ? 'Authenticator apps are now required for every admin' : 'Authenticator apps are now optional for admins', then: (r) => setPolicy(r.data) });
  return (
    <Card title="Portal policy" subtitle="Applies to every vendor and reseller administrator of this hub, including sessions that are open right now.">
      <ErrorBanner error={error || loadError} />
      <Toggle checked={Boolean(policy?.require_totp_for_admins)} disabled={busy || !policy} onChange={save}
        label="Require an authenticator app for all admins" description="Vendor and reseller admins must enrol at their first sign-in; until they do, only the Security page answers. Support and staff roles may enrol voluntarily." />
    </Card>
  );
}

export default function PortalSecurity({ home = '/admin' }) {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const required = (Boolean(session?.totpEnrolRequired) || params.get('enrol') === '1') && !session?.totpEnabled;
  return (
    <>
      <PageHeader title="Security" description="Two-factor authentication and password for this portal account. Sensitive actions re-prompt for a code." home={home} />
      {required && <div className="banner banner-error" role="alert" data-testid="totp-enrol-required"><div><strong>An authenticator app is required for your role.</strong> This hub asks every admin to enrol before anything else: scan the code below, confirm it, and the portal opens.</div></div>}
      {!required && !session?.totpEnabled && <div className="banner banner-warning"><div>Two-factor authentication is off. Enrol below before signing keys, API keys, portal users or marketplace decisions: the hub refuses those actions until a code is confirmed.</div></div>}
      <div className="two-col">
        <Card title="Two-factor authentication"><PortalTotpPanel home={home} /></Card>
        <Card title="Password"><PortalPasswordPanel home={home} /></Card>
      </div>
      <PortalPolicyPanel />
    </>
  );
}
