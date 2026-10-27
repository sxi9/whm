import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, StatusPill } from '../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// Portal (vendor + reseller) account security: TOTP enrolment through
// POST /portal/2fa/enroll → /confirm, disable with a current code, and the
// password change (the hub destroys the session, so the user signs in again).
// Mounted at /admin/security and /reseller/security with `home` set per area.

export function PortalTotpPanel() {
  const { session, markTotpEnabled } = useAuth();
  const { run, busy, error } = useAction();
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const enabled = Boolean(session?.totpEnabled);
  const valid = /^\d{6}$/.test(code);
  const startEnrol = () => run(() => api.post('/portal/2fa/enroll', enabled && valid ? { code } : {}), { then: (r) => { setPending(r.data); setCode(''); } });
  const confirm = () => run(() => api.post('/portal/2fa/confirm', { code }), { success: 'Two-factor authentication enabled', then: () => { setPending(null); setCode(''); markTotpEnabled(true); } });
  const disable = () => run(() => api.post('/portal/2fa/disable', { code }), { success: 'Two-factor authentication disabled', then: () => { setCode(''); markTotpEnabled(false); } });
  return (
    <>
      <ErrorBanner error={error} />
      <p><StatusPill status={enabled ? 'enabled' : 'disabled'} /> <span className="muted">Every sensitive action (signing keys, API keys, portal users, marketplace decisions, money) asks for a fresh code; without 2FA those actions are refused.</span></p>
      {!enabled && !pending && <Button variant="primary" loading={busy} onClick={startEnrol}>Start enrolment</Button>}
      {pending && (
        <>
          <p>Add this secret to your authenticator app, then confirm with a code:</p>
          <pre className="code-block">{pending.secret}</pre>
          <p className="muted"><code className="small">{pending.uri}</code></p>
          <Field label="Code" htmlFor="portal-totp-confirm"><TextInput id="portal-totp-confirm" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} /></Field>
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

export default function PortalSecurity({ home = '/admin' }) {
  const { session } = useAuth();
  return (
    <>
      <PageHeader title="Security" description="Two-factor authentication and password for this portal account. Sensitive actions re-prompt for a code." home={home} />
      {!session?.totpEnabled && <div className="banner banner-warning"><div>Two-factor authentication is off. Enrol below before signing keys, API keys, portal users or marketplace decisions: the hub refuses those actions until a code is confirmed.</div></div>}
      <div className="two-col">
        <Card title="Two-factor authentication"><PortalTotpPanel /></Card>
        <Card title="Password"><PortalPasswordPanel home={home} /></Card>
      </div>
    </>
  );
}
