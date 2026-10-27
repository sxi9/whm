import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth, homeOf } from './AuthContext.jsx';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';

function nextOf(search, fallback) {
  const next = new URLSearchParams(search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

// Shared password + TOTP form. The hub answers 401 totp_required when the
// account has 2FA and no code was sent; the form then asks for the code.
export function LoginForm({ title, subtitle, onLogin, footer }) {
  const [form, setForm] = useState({ email: '', password: '', totp: '' });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin({ email: form.email, password: form.password, totp: needsTotp && form.totp ? form.totp : undefined });
    } catch (err) {
      if (err.code === 'totp_required') setNeedsTotp(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><ShieldCheck size={20} /> <span>WHM Hub</span></div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        <ErrorBanner error={error} />
        {needsTotp ? (
          <Field label="Two-factor code" help="Enter the 6-digit code from your authenticator app." htmlFor="login-totp">
            <TextInput id="login-totp" value={form.totp} onChange={set('totp')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
          </Field>
        ) : (
          <>
            <Field label="E-mail" htmlFor="login-email"><TextInput id="login-email" type="email" value={form.email} onChange={set('email')} autoComplete="username" autoFocus /></Field>
            <Field label="Password" htmlFor="login-password"><TextInput id="login-password" type="password" value={form.password} onChange={set('password')} autoComplete="current-password" /></Field>
          </>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={needsTotp ? !/^\d{6}$/.test(form.totp) : !form.email || !form.password}>{needsTotp ? 'Verify code' : 'Sign in'}</Button>
        {footer && <div className="login-external">{footer}</div>}
      </form>
    </div>
  );
}

export function PortalLoginPage() {
  const { session, ready, loginPortal } = useAuth();
  const location = useLocation();
  if (ready && session) return <Navigate to={nextOf(location.search, homeOf(session))} replace />;
  return (
    <LoginForm title="Vendor & reseller portal" subtitle="Sign in with your portal account. Two-factor authentication is required for sensitive actions."
      onLogin={loginPortal}
      footer={<p className="muted">Plugin developer? <Link to="/dev/login">Developer sign-in</Link> · <Link to="/dev/register">Register</Link></p>} />
  );
}

export function DeveloperLoginPage() {
  const { session, ready, loginDeveloper } = useAuth();
  const location = useLocation();
  if (ready && session) return <Navigate to={nextOf(location.search, homeOf(session))} replace />;
  return (
    <LoginForm title="Developer portal" subtitle="Publish plugins to the WHM Marketplace."
      onLogin={loginDeveloper}
      footer={<p className="muted">No account yet? <Link to="/dev/register">Register as a developer</Link> · <Link to="/dev/password-reset">Forgot password</Link> · <Link to="/login">Vendor portal</Link></p>} />
  );
}
