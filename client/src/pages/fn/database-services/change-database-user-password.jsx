import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { EngineBanner, RequestError, DbUserSelect, useDbStatus } from '../../databases/Shared.jsx';

export default function ChangeDatabaseUserPassword({ fn }) {
  const toast = useToast();
  const status = useDbStatus();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (passwordStrength(password) < 65) { setError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const { data } = await api.put(`/databases/users/${encodeURIComponent(user)}/password`, { password });
      setResult(data);
      setPassword('');
      toast.success(`Password changed for ${user}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Reset the password of a database user at every host it exists at. Resellers can change users that belong to their own accounts." />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      <form onSubmit={submit}>
        <Card title="Select a user">
          <RequestError error={error} />
          <DbUserSelect value={user} onChange={setUser} />
          <Field label="New password" required><PasswordInput value={password} onChange={setPassword} /></Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!user || !password}>Change password</Button></FormActions>
          {result && <KeyValue items={[['Result', <StatusPill key="r" status="ok">changed</StatusPill>], ['User', <code key="u">{result.name}</code>], ['Hosts', result.hosts?.length ? result.hosts.join(', ') : 'server-wide'], result.account && ['Account', result.account]]} />}
        </Card>
      </form>
    </>
  );
}
