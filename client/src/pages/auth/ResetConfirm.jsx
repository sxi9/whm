import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Field, TextInput, PasswordInput, Button, ErrorBanner, passwordStrength } from '../../components/Form.jsx';
import { useBranding } from '../cpanel/branding.js';
import { BrandMark } from '../../components/Brand.jsx';
import { primeCsrf } from './ResetRequest.jsx';

const MIN_STRENGTH = 65;
const MIN_LENGTH = 8;

export function validateNewPassword(password, confirm) {
  if (password.length < MIN_LENGTH) return `At least ${MIN_LENGTH} characters`;
  if (passwordStrength(password) < MIN_STRENGTH) return `Choose a stronger password (minimum strength ${MIN_STRENGTH})`;
  if (confirm !== password) return 'The two entries do not match';
  return null;
}

export function ResetConfirmPage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const branding = useBranding();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const expired = error?.code === 'reset_token_invalid';

  const submit = async (e) => {
    e.preventDefault();
    const problem = validateNewPassword(password, confirm);
    if (problem) { setError({ message: problem }); return; }
    setLoading(true);
    setError(null);
    try {
      await primeCsrf();
      await api.post('/auth/reset/confirm', { token, password });
      navigate('/login?reset=done', { replace: true });
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
          <span>{branding.companyName} · {branding.tagline}</span>
        </div>
        <h1>Choose a new password</h1>
        <ErrorBanner error={error} />
        {expired ? (
          <div className="login-foot"><Link to="/login/reset">Request a new reset link</Link></div>
        ) : (
          <>
            <Field label="New password" htmlFor="new-password"><PasswordInput id="new-password" value={password} onChange={setPassword} autoComplete="new-password" required /></Field>
            <Field label="Confirm new password" htmlFor="confirm-password"><TextInput id="confirm-password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" required /></Field>
            <p className="muted">Every session of this login ends once the password is set; the FTP and SSH password of the account changes with it.</p>
            <Button type="submit" variant="primary" loading={loading} style={{ width: '100%', marginTop: 6 }}>Set password</Button>
            <div className="login-foot"><Link to="/login">Back to sign in</Link></div>
          </>
        )}
      </form>
    </div>
  );
}
