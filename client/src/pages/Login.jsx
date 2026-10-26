import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api/client.js';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';

const EXTERNAL_ERRORS = {
  external_state: 'The sign-in with your identity provider could not be verified (expired or invalid state). Please try again.',
  external_not_linked: 'That external identity is not linked to a WHM user. Log in with your password, then link it under Security Center › Manage External Authentications.',
  external_denied: 'The identity provider denied the sign-in.',
  external_failed: 'Sign-in with the identity provider failed.',
};

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
  const [error, setError] = useState(() => {
    const key = params.get('error');
    return key ? { message: [EXTERNAL_ERRORS[key] || 'Sign-in failed.', params.get('message')].filter(Boolean).join(' ') } : null;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/auth/external').then(({ data }) => setProviders(data.providers || [])).catch(() => setProviders([]));
  }, []);

  if (ready && user) return <Navigate to={location.state?.from || '/'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (stage === 'credentials') {
        const result = await login(username.trim(), password);
        if (result.requires2fa) { setStage('2fa'); return; }
      } else {
        await verify2fa(code.trim());
      }
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><span className="brand-mark">WHM</span><span>WebHost Manager</span></div>
        <h1>{stage === 'credentials' ? 'Log in' : 'Two-factor authentication'}</h1>
        <ErrorBanner error={error} />
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
        <Button type="submit" variant="primary" loading={loading} style={{ width: '100%' }}>{stage === 'credentials' ? 'Log in' : 'Verify'}</Button>
        {stage === '2fa' && <button type="button" className="link-button" onClick={() => { setStage('credentials'); setCode(''); setError(null); }}>Back</button>}
        {stage === 'credentials' && providers.length > 0 && (
          <div className="login-external">
            <div className="login-divider"><span>or</span></div>
            {providers.map((p) => (
              <a key={p.name} className="btn" style={{ width: '100%', justifyContent: 'center' }} href={`/api/auth/external/${encodeURIComponent(p.name)}/start`}>Log in with {p.displayName}</a>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}
