import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { Field, TextInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { useBranding } from '../cpanel/branding.js';
import { BrandMark } from '../../components/Brand.jsx';

// What POST /api/auth/reset/request receives for what the person typed.
export function resetRequestBody(identifier) {
  const value = String(identifier || '').trim();
  return value.includes('@') ? { email: value.toLowerCase() } : { username: value.toLowerCase() };
}

// Public mutations carry the CSRF token of a session-less cookie session.
export async function primeCsrf() {
  const { data } = await api.get('/auth/csrf');
  api.setCsrfToken(data.csrfToken);
}

export function ResetRequestPage() {
  const branding = useBranding();
  const [identifier, setIdentifier] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await primeCsrf();
      await api.post('/auth/reset/request', resetRequestBody(identifier));
      setSent(true);
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
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <div className="banner banner-info">If that login belongs to a hosting account with a contact e-mail address, a message with a reset link is on its way. The link works for 30 minutes and can be used once.</div>
            <p className="muted">No message? Check the spam folder, make sure the account has a contact address, or ask your hosting provider to set a new password for you.</p>
          </>
        ) : (
          <>
            <p className="muted">Enter the username of your hosting account or its contact e-mail address. Administrator logins are reset from the console (<code>whm-cli reset-password</code>), not here.</p>
            <ErrorBanner error={error} />
            <Field label="Username or e-mail address" htmlFor="identifier">
              <TextInput id="identifier" value={identifier} onChange={setIdentifier} autoComplete="username" autoFocus required />
            </Field>
            <Button type="submit" variant="primary" loading={loading} style={{ width: '100%', marginTop: 6 }}>Send reset link</Button>
          </>
        )}
        <div className="login-foot"><Link to="/login">Back to sign in</Link></div>
      </form>
    </div>
  );
}
