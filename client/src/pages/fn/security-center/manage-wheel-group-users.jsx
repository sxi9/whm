import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../security/Shared.jsx';

export default function ManageWheelGroupUsers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/wheel');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try { await api.post('/security/wheel', { username: pick }); toast.success(`${pick} added to ${data.group}`); setPick(''); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const remove = async (username) => {
    if (!(await confirm({ title: `Remove ${username} from ${data.group}?`, message: 'The user will no longer be able to su to root.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/security/wheel/${username}`); toast.success(`${username} removed`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Members of the wheel (or sudo) group may become root with su. Keep this list as short as possible." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.exists && <Card><EmptyState title="No wheel or sudo group exists">Create one with <code>groupadd wheel</code> and configure pam_wheel before managing members here.</EmptyState></Card>}
      {data && data.exists && (
        <>
          <Card title={`Add a user to ${data.group}`}>
            <div className="form-grid">
              <Field label="User"><Select value={pick} onChange={setPick} options={data.candidates} placeholder="Choose a user…" /></Field>
            </div>
            <FormActions><Button variant="primary" onClick={add} disabled={!pick} loading={busy}>Add to {data.group}</Button></FormActions>
          </Card>
          <Card title={`Current members of ${data.group}`} padded={false}>
            <DataTable columns={[{ key: 'username', label: 'User', render: (r) => <code>{r.username}</code> }]} rows={data.members.map((username) => ({ username }))} rowKey={(r) => r.username}
              rowActions={(r) => [{ label: 'Remove', danger: true, primary: true, onClick: () => remove(r.username) }]} emptyText="Nobody may su to root yet." dense />
          </Card>
        </>
      )}
    </>
  );
}
