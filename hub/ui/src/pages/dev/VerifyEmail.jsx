import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Loading } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';

// /dev/verify-email?token=… — the link from the registration mail.
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState({ busy: Boolean(token), result: null, error: null });
  useEffect(() => {
    if (!token) return;
    let alive = true;
    api.post('/dev/verify-email', { token }).then(({ data }) => alive && setState({ busy: false, result: data, error: null }), (error) => alive && setState({ busy: false, result: null, error }));
    return () => { alive = false; };
  }, [token]);
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand"><ShieldCheck size={20} /> <span>WHM Marketplace</span></div>
        <h1>E-mail verification</h1>
        {!token && <div className="banner banner-warning"><div>This page needs the <code>token</code> from your verification mail.</div></div>}
        {state.busy && <Loading text="Verifying…" />}
        <ErrorBanner error={state.error} />
        {state.result && <div className="banner banner-success"><div><strong>E-mail verified.</strong> Next: sign in, enable two-factor authentication and claim your namespace.</div></div>}
        <Link className="btn btn-primary" to="/dev/login">Sign in</Link>
      </div>
    </div>
  );
}
