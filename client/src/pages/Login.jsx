import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api/client.js';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';
import { useBranding, isPanelShell } from '../pages/cpanel/branding.js';
import { BrandMark } from '../components/Brand.jsx';
import { landingFor } from '../auth/home.js';
import { renderMarkdown } from '../pages/plugins/PluginPage.jsx';

const EXTERNAL_ERRORS = {
  external_state: 'The sign-in with your identity provider could not be verified (expired or invalid state). Please try again.',
  external_not_linked: 'That external identity is not linked to a panel user. Log in with your password, then link it under Security Center › Manage External Authentications.',
  external_denied: 'The identity provider denied the sign-in.',
  external_failed: 'Sign-in with the identity provider failed.',
  wrong_port: 'Administrators and resellers sign in on the administration port.',
};

// The account-panel listener refuses administrator and reseller logins; the
// server names the admin sign-in URL (`error.adminUrl` on the JSON error, the
// branding's `adminUrl` after an external login redirect) so the person is
// sent to the right port instead of retrying here. The URL is never read
// from the page's own query string.
export function WrongPortBanner({ error, fallbackUrl }) {
  const candidate = error?.adminUrl || fallbackUrl || '';
  const href = /^https?:\/\//i.test(candidate) ? candidate : null;
  return (
    <div className="banner banner-error" role="alert">
      <div>
        <strong>{error.message}</strong>
        {href && <div><a href={href}>Go to the administration sign-in</a> <small>({href})</small></div>}
        {error.requestId && <small>Request ID: {error.requestId}</small>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, ready, login, verify2fa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState(params.get('stage') === '2fa' ? '2fa' : 'credentials');
  const [providers, setProviders] = useState([]);
  // Forgot-password exists only for account users, and only while the account
  // panel is on and the server can send mail (GET /api/auth/reset).
  const [resetEnabled, setResetEnabled] = useState(false);
  const resetDone = params.get('reset') === 'done';
  const [error, setError] = useState(() => {
    const key = params.get('error');
    if (!key) return null;
    if (key === 'wrong_port') return { code: 'wrong_port', message: params.get('message') || EXTERNAL_ERRORS.wrong_port };
    return { message: [EXTERNAL_ERRORS[key] || 'Sign-in failed.', params.get('message')].filter(Boolean).join(' ') };
  });
  const [loading, setLoading] = useState(false);
  const branding = useBranding();
  const shell = isPanelShell(branding) ? 'panel' : 'admin';

  useEffect(() => {
    api.get('/auth/external').then(({ data }) => setProviders(data.providers || [])).catch(() => setProviders([]));
    api.get('/auth/reset').then(({ data }) => setResetEnabled(Boolean(data.enabled))).catch(() => setResetEnabled(false));
  }, []);

  if (ready && user) return <Navigate to={landingFor(user, location.state?.from, shell)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      let signedIn;
      if (stage === 'credentials') {
        const result = await login(username.trim(), password);
        if (result.requires2fa) { setStage('2fa'); return; }
        signedIn = result.user;
      } else {
        signedIn = await verify2fa(code.trim());
      }
      navigate(landingFor(signedIn, location.state?.from, shell), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <BrandMark size={56} />
          <span>{branding.companyName} · {shell === 'panel' ? 'Account panel' : branding.tagline}</span>
        </div>
        <h1>{stage === 'credentials' ? (shell === 'panel' ? 'Sign in to your account' : 'Sign in') : 'Two-factor authentication'}</h1>
        {branding.loginNotice && <div className="banner banner-info login-notice"><div className="markdown">{renderMarkdown(branding.loginNotice)}</div></div>}
        {resetDone && stage === 'credentials' && !error && <div className="banner banner-info">Your password was changed. Sign in with the new one.</div>}
        {error?.code === 'wrong_port' ? <WrongPortBanner error={error} fallbackUrl={branding.adminUrl} /> : <ErrorBanner error={error} />}
        {stage === 'credentials' ? (
          <>
            <Field label="Username" htmlFor="username"><TextInput id="username" value={username} onChange={setUsername} autoComplete="username" autoFocus required /></Field>
            <Field label="Password" htmlFor="password"><TextInput id="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required /></Field>
          </>
        ) : (
          <Field label="Verification code" help="Enter the 6-digit code from your authenticator app." htmlFor="code">
            <TextInput id="code" value={code} onChange={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
          </Field>
        )}
        <Button type="submit" variant="primary" loading={loading} style={{ width: '100%', marginTop: 6 }}>{stage === 'credentials' ? 'Sign in' : 'Verify'}</Button>
        {stage === '2fa' && <button type="button" className="link-button" onClick={() => { setStage('credentials'); setCode(''); setError(null); }}>Back</button>}
        {stage === 'credentials' && resetEnabled && <div className="login-foot"><Link to="/login/reset">Forgot password?</Link></div>}
        {stage === 'credentials' && providers.length > 0 && (
          <div className="login-external">
            <div className="login-divider"><span>or</span></div>
            {providers.map((p) => (
              <a key={p.name} className="btn" style={{ width: '100%', justifyContent: 'center' }} href={`/api/auth/external/${encodeURIComponent(p.name)}/start`}>Continue with {p.displayName}</a>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
