import { useState } from 'react';
import { api } from '../../api/client.js';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Field, PasswordInput, Button, FormActions, ErrorBanner, passwordStrength } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { AccountPicker } from './AccountPicker.jsx';

export default function PasswordModification({ fn }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (passwordStrength(password) < 65) { setError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/accounts/${username}/password`, { password });
      toast.success(`Password changed for ${username}`);
      setPassword('');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {username && (
        <Card title={`New password for ${username}`} subtitle="Changes the Linux user password used for SSH/FTP and the account's panel login.">
          <form onSubmit={submit} className="form-narrow">
            <ErrorBanner error={error} />
            <Field label="New password" required error={error?.fields?.password}><PasswordInput value={password} onChange={setPassword} /></Field>
            <FormActions><Button type="submit" variant="primary" loading={busy}>Change password</Button></FormActions>
          </form>
        </Card>
      )}
    </>
  );
}
