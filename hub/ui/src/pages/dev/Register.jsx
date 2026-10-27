import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Field, TextInput, PasswordInput, Button, ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';

// §18.2 step 1: open self-service sign-up → 202 + verification mail. The
// account exists as `pending`; nothing is publishable before vendor review.
export default function Register() {
  const [form, setForm] = useState({ email: '', password: '', display_name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const { data } = await api.post('/dev/register', form); setDone(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><ShieldCheck size={20} /> <span>WHM Marketplace</span></div>
        <h1>Register as a developer</h1>
        {done ? (
          <>
            <div className="banner banner-success"><div><strong>Check your inbox.</strong> We sent a verification link to {form.email} (valid 24 h). Your account is <code>{done.status}</code> until the vendor verifies your identity and namespaces.</div></div>
            <Link className="btn btn-primary" to="/dev/login">Go to sign-in</Link>
          </>
        ) : (
          <>
            <p className="muted">Anyone can register. Publishing requires e-mail verification, two-factor authentication, a claimed namespace with evidence and a vendor review.</p>
            <ErrorBanner error={error} />
            <Field label="Display name" required error={error?.fields?.display_name}><TextInput value={form.display_name} onChange={set('display_name')} placeholder="Acme Hosting" /></Field>
            <Field label="E-mail" required error={error?.fields?.email}><TextInput type="email" value={form.email} onChange={set('email')} autoComplete="username" /></Field>
            <Field label="Password" required help="At least 10 characters" error={error?.fields?.password}><PasswordInput value={form.password} onChange={set('password')} /></Field>
            <Button type="submit" variant="primary" loading={busy} disabled={!form.email || form.password.length < 10 || form.display_name.length < 2}>Create account</Button>
            <p className="muted" style={{ marginTop: 10 }}>Already registered? <Link to="/dev/login">Sign in</Link></p>
          </>
        )}
      </form>
    </div>
  );
}
