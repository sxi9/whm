import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Field, PasswordInput, TextInput, Button, FormActions, ErrorBanner, passwordStrength } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export default function ChangeRootPassword({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirmPw) { setError({ message: 'Passwords do not match' }); return; }
    if (passwordStrength(password) < 65) { setError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    if (!(await confirm({ title: 'Change the server root password?', message: 'This changes the Linux root account used for SSH and console access. Make sure you record the new password.', confirmLabel: 'Change', danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/system/root-password', { password });
      toast.success('Server root password changed');
      setPassword(''); setConfirmPw('');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Changes the operating system's root password used for SSH and console access. Your WHM login password is separate." />
      <Card>
        <p className="muted">Looking for your panel login password? <Link to="/change-password">Change panel password</Link>.</p>
        <form onSubmit={submit} className="form-narrow">
          <ErrorBanner error={error} />
          <Field label="New root password" required><PasswordInput value={password} onChange={setPassword} /></Field>
          <Field label="Confirm" required><TextInput type="password" value={confirmPw} onChange={setConfirmPw} autoComplete="new-password" /></Field>
          <FormActions><Button type="submit" variant="danger" loading={busy}>Change root password</Button></FormActions>
        </form>
      </Card>
    </>
  );
}
