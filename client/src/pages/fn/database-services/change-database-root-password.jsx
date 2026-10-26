import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { EngineBanner, RequestError, ProfileSummary, useDbStatus } from '../../databases/Shared.jsx';

export default function ChangeDatabaseRootPassword({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useDbStatus();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const profile = status.data?.profile;
  const superuser = profile?.engine === 'postgres' ? 'postgres' : 'root';

  const submit = async (e) => {
    e.preventDefault();
    if (passwordStrength(password) < 65) { setError({ message: 'Choose a stronger password (minimum strength 65)' }); return; }
    const ok = await confirm({ title: `Change the ${superuser} password?`, message: `The ${superuser} password is changed at every host it exists at${profile?.is_local && superuser === 'root' ? ' and /root/.my.cnf is rewritten so root tooling keeps working' : ''}. Anything else using the old password (backups, phpMyAdmin control user, remote tools) must be updated.`, confirmLabel: 'Change password', danger: true });
    if (!ok) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { data } = await api.put('/databases/root-password', { password });
      setResult(data);
      setPassword('');
      toast.success(`${superuser} password changed on ${data.profile}`);
      status.refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Rotate the database superuser password on the active profile. The panel keeps its own stored credentials in sync so account provisioning keeps working." />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      <form onSubmit={submit}>
        <Card title={`New ${superuser} password`}>
          <RequestError error={error} />
          <ProfileSummary profile={profile} />
          <Field label="New password" required help="Minimum strength 65; use the generator for a random password."><PasswordInput value={password} onChange={setPassword} /></Field>
          <FormActions><Button type="submit" variant="danger" loading={busy} disabled={!password || !profile}>Change {superuser} password</Button></FormActions>
          {result && <KeyValue items={[['Result', <StatusPill key="r" status="ok">changed</StatusPill>], ['Hosts updated', result.hosts?.join(', ')], ['/root/.my.cnf', result.myCnfUpdated ? 'rewritten (0600)' : 'not changed'], ['Stored profile credentials', result.profileUpdated ? 'updated' : 'not applicable']]} />}
        </Card>
      </form>
    </>
  );
}
