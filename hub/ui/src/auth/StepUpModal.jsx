import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal.jsx';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';

// Shown by AuthProvider when the API answered 403 totp_stepup_required: a
// fresh code re-arms the session (POST /portal/stepup or /dev/2fa/stepup) and
// the client retries the refused request once. `session` and `stepUp` come
// in as props so this file does not import the provider that renders it.
export function StepUpModal({ open, request, session, stepUp, onDone, onCancel }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const securityPath = session?.kind === 'developer' ? '/dev/security' : session?.user?.reseller_id ? '/reseller/security' : '/admin/security';

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await stepUp(code);
      setCode('');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Confirm your two-factor code" onClose={onCancel} size="sm"
      footer={<><Button onClick={onCancel}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} disabled={!/^\d{6}$/.test(code)}>Confirm</Button></>}>
      <form onSubmit={submit} className="stepup-form">
        <p className="muted">
          {request?.err?.message || 'This action needs a fresh two-factor confirmation.'}
          {request?.info?.path && <> <code>{request.info.method} {request.info.path}</code></>}
        </p>
        {!session?.totpEnabled && <div className="banner banner-warning"><div>Two-factor authentication is not enabled on this account; enable it under <Link to={securityPath} onClick={onCancel}>Security</Link> first.</div></div>}
        <ErrorBanner error={error} />
        <Field label="Authenticator code" htmlFor="stepup-code">
          <TextInput id="stepup-code" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
