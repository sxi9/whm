import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// TOTP enrol/disable, password change, session + event list; also the public
// password-reset flow (mode="reset", /dev/password-reset?token=…).
export function TotpPanel() {
  const { session, markTotpEnabled } = useAuth();
  const { run, busy, error } = useAction();
  const [pending, setPending] = useState(null);
  const [code, setCode] = useState('');
  const enabled = session?.totpEnabled;
  return (
    <>
      <ErrorBanner error={error} />
      <p><StatusPill status={enabled ? 'enabled' : 'disabled'} /> <span className="muted">Required before namespace claims, signing keys, API keys, e-mail/payout changes and publishing. Disabling it revokes every API key.</span></p>
      {!enabled && !pending && <Button variant="primary" loading={busy} onClick={() => run(() => api.post('/dev/2fa/start'), { then: (r) => setPending(r.data) })}>Start enrolment</Button>}
      {pending && (
        <>
          <p>Add this secret to your authenticator app, then confirm with a code:</p>
          <pre className="code-block">{pending.secret}</pre>
          <p className="muted"><code className="small">{pending.uri}</code></p>
          <Field label="Code"><TextInput value={code} onChange={setCode} inputMode="numeric" maxLength={6} /></Field>
          <Button variant="primary" loading={busy} disabled={!/^\d{6}$/.test(code)} onClick={() => run(() => api.post('/dev/2fa/confirm', { code }), { success: 'Two-factor authentication enabled', then: () => { setPending(null); setCode(''); markTotpEnabled(true); } })}>Confirm</Button>
        </>
      )}
      {enabled && (
        <>
          <Field label="Current code (to disable)"><TextInput value={code} onChange={setCode} inputMode="numeric" maxLength={6} /></Field>
          <Button variant="danger" loading={busy} disabled={!/^\d{6}$/.test(code)} onClick={() => run(() => api.post('/dev/2fa/disable', { code }), { success: 'Two-factor authentication disabled; API keys revoked', then: () => { setCode(''); markTotpEnabled(false); } })}>Disable 2FA</Button>
        </>
      )}
    </>
  );
}

function PasswordPanel() {
  const { refresh } = useAuth();
  const { run, busy, error } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  return (
    <>
      <ErrorBanner error={error} />
      <Field label="Current password"><TextInput type="password" value={current} onChange={setCurrent} autoComplete="current-password" /></Field>
      <Field label="New password" help="At least 10 characters. Every session and API key is invalidated."><PasswordInput value={next} onChange={setNext} /></Field>
      <Button variant="primary" loading={busy} disabled={!current || next.length < 10} onClick={() => run(() => api.post('/dev/password/change', { current_password: current, password: next }), { success: 'Password changed; sign in again', then: refresh })}>Change password</Button>
    </>
  );
}

function SessionsPanel() {
  const { data, error, refetch } = useApi('/dev/sessions');
  const { run } = useAction();
  const confirm = useConfirm();
  const { refresh } = useAuth();
  return (
    <>
      <ErrorBanner error={error} onRetry={refetch} />
      <h3>Sessions</h3>
      <ul className="timeline">{(data?.sessions || []).map((s) => <li key={s.id}><time>{formatDate(s.created_at)}</time><span><code className="small">{s.id}</code> · expires {formatDate(s.expires_at)}<span className={`pill ${s.stepped_up ? 'pill-ok' : 'pill-muted'}`} style={{ marginLeft: 6 }}>{s.stepped_up ? 'stepped up' : 'not stepped up'}</span></span></li>)}{!(data?.sessions || []).length && <li><span className="muted">No sessions.</span></li>}</ul>
      <Button size="sm" variant="danger" onClick={async () => { if (await confirm({ title: 'Sign out everywhere', message: 'Every developer session is revoked, including this one.', danger: true })) run(() => api.delete('/dev/sessions'), { success: 'All sessions revoked', then: refresh }); }}>Sign out everywhere</Button>
      <h3 style={{ marginTop: 16 }}>Security events</h3>
      <ul className="timeline">{(data?.events || []).slice(0, 30).map((e, i) => <li key={i}><time>{formatDate(e.ts || e.created_at)}</time><span>{e.event || e.kind} {e.detail && <span className="muted">{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)}</span>}</span></li>)}{!(data?.events || []).length && <li><span className="muted">No events yet.</span></li>}</ul>
    </>
  );
}

export function PasswordResetPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand"><ShieldCheck size={20} /> <span>WHM Marketplace</span></div>
        <h1>{token ? 'Choose a new password' : 'Reset your password'}</h1>
        <ErrorBanner error={error} />
        {done && <div className="banner banner-success"><div>{token ? 'Password reset. Sign in with the new password.' : 'If that address exists, a reset link is on its way (valid 15 minutes).'}</div></div>}
        {!done && !token && (
          <>
            <Field label="E-mail"><TextInput type="email" value={email} onChange={setEmail} /></Field>
            <Button variant="primary" loading={busy} disabled={!email} onClick={() => run(() => api.post('/dev/password/reset', { email }), { then: () => setDone(true), silent: true })}>Send reset link</Button>
          </>
        )}
        {!done && token && (
          <>
            <Field label="New password"><PasswordInput value={password} onChange={setPassword} /></Field>
            <Field label="Two-factor code (if enabled)"><TextInput value={totp} onChange={setTotp} inputMode="numeric" maxLength={6} /></Field>
            <Button variant="primary" loading={busy} disabled={password.length < 10} onClick={() => run(() => api.post(`/dev/password/reset/${token}`, { password, ...(totp ? { totp } : {}) }), { then: () => setDone(true), silent: true })}>Reset password</Button>
          </>
        )}
        <p className="muted" style={{ marginTop: 10 }}><Link to="/dev/login">Back to sign-in</Link></p>
      </div>
    </div>
  );
}

export default function Security({ mode = null }) {
  if (mode === 'reset') return <PasswordResetPage />;
  return (
    <>
      <PageHeader title="Security" description="Two-factor authentication, password, sessions and security events. Sensitive actions re-prompt for a code." home="/dev" />
      <div className="two-col">
        <Card title="Two-factor authentication"><TotpPanel /></Card>
        <Card title="Password"><PasswordPanel /></Card>
      </div>
      <Card title="Sessions & events"><SessionsPanel /></Card>
    </>
  );
}
