import { useState } from 'react';
import { Modal } from '../components/Modal.jsx';
import { Field, TextInput, Button, ErrorBanner } from '../components/Form.jsx';
import { useAuth } from './AuthContext.jsx';

// Shown by AuthProvider when the API answered 403 totp_stepup_required: a
// fresh code re-arms the session (POST /portal/stepup or /dev/2fa/stepup) and
// the client retries the refused request once.
export function StepUpModal({ open, request, onDone, onCancel }) {
  const { stepUp, session } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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
        {!session?.totpEnabled && <div className="banner banner-warning">Two-factor authentication is not enabled on this account; enable it under Security first.</div>}
        <ErrorBanner error={error} />
        <Field label="Authenticator code" htmlFor="stepup-code">
          <TextInput id="stepup-code" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={6} autoFocus />
        </Field>
      </form>
    </Modal>
  );
}
