import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader, Card } from '../components/Common.jsx';
import { Field, TextInput, PasswordInput, Button, ErrorBanner, FormActions, passwordStrength } from '../components/Form.jsx';
import { useToast } from '../components/Toast.jsx';

export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const forced = Boolean(user?.mustChangePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (next !== confirm) { setError({ message: 'Passwords do not match' }); return; }
    if (passwordStrength(next) < 65) { setError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    setLoading(true);
    setError(null);
    try {
      await changePassword(forced ? null : current, next);
      toast.success('Password changed');
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageHeader title="Change password" description={forced ? 'You must set a new password before continuing.' : 'Change the password for your panel login.'} />
      <Card>
        <form onSubmit={submit} className="form-narrow">
          <ErrorBanner error={error} />
          {!forced && <Field label="Current password"><TextInput type="password" value={current} onChange={setCurrent} autoComplete="current-password" required /></Field>}
          <Field label="New password" required><PasswordInput value={next} onChange={setNext} /></Field>
          <Field label="Confirm new password" required><TextInput type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" required /></Field>
          <FormActions><Button type="submit" variant="primary" loading={loading}>Change password</Button></FormActions>
        </form>
      </Card>
    </>
  );
}
