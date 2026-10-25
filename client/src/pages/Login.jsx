import { useState } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';

export function LoginPage() {
  const { user, ready, login, verify2fa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('credentials');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

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
      </form>
    </div>
  );
}
