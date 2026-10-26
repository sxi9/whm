import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, KeyValue } from '../../../components/Common.jsx';
import { Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { ResellerPicker, useReseller, useResellerCatalog, AclEditor, NameserversEditor, ResellerStatusPill } from '../../resellers/Shared.jsx';

export default function EditResellerNameserversAndPrivileges({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const { reseller, error: loadError, refetch } = useReseller(username);
  const catalog = useResellerCatalog();
  const [acls, setAcls] = useState([]);
  const [nameservers, setNameservers] = useState([]);
  const [owns, setOwns] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (reseller) { setAcls(reseller.acls); setNameservers(reseller.limits.nameservers); setOwns(reseller.limits.owns_nameservers); } }, [reseller]);

  const save = async (e) => {
    e.preventDefault();
    if (acls.includes('all') && !reseller.acls.includes('all') && !(await confirm({ title: 'Grant root-level access?', message: `"All Features" gives ${username} every privilege on this server, including ones outside this list.`, confirmLabel: 'Grant', danger: true }))) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/resellers/${encodeURIComponent(username)}/privileges`, { acls, nameservers, ownsNameservers: owns });
      toast.success(`${data.username}: ${data.acls.length} privilege(s), ${data.limits.nameservers.length || 'default'} nameserver(s)`);
      refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const saveList = async (name, keys) => {
    try { await api.put(`/resellers/acl-lists/${name}`, { acls: keys }); toast.success(`ACL list "${name}" saved`); catalog.refetch(); } catch (err) { toast.error(err); }
  };
  const deleteList = async (name) => {
    if (!(await confirm({ title: `Delete ACL list "${name}"?`, message: 'Resellers keep the privileges they already have.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/resellers/acl-lists/${name}`); toast.success(`ACL list "${name}" deleted`); catalog.refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Choose which WHM functions a reseller may use, grouped as in WHM, and the nameservers its new accounts' DNS zones advertise. Save a selection as an ACL list to reuse it." />
      <Card title="Reseller"><ResellerPicker value={username} onChange={setUsername} /></Card>
      <ErrorBanner error={loadError || catalog.error} onRetry={() => { refetch(); catalog.refetch(); }} />
      {reseller && (
        <form onSubmit={save}>
          <Card title={`${reseller.username}`} subtitle={reseller.account ? `Hosting account ${reseller.account.domain}` : 'Standalone reseller login'}>
            <KeyValue items={[['Status', <ResellerStatusPill key="s" reseller={reseller} />], ['Accounts', reseller.usage.accounts], ['Current privileges', reseller.acls.length], ['Current nameservers', reseller.limits.nameservers.join(', ') || `server defaults (${(catalog.data?.defaultNameservers || []).join(', ')})`]]} />
          </Card>
          <Card title="Nameservers" subtitle="Blank entries fall back to the server's nameservers from Basic WebHost Manager Setup">
            <NameserversEditor value={nameservers} onChange={setNameservers} owns={owns} onOwnsChange={setOwns} defaults={catalog.data?.defaultNameservers || []} />
          </Card>
          <Card title="Privileges">
            <ErrorBanner error={error} />
            <AclEditor groups={catalog.data?.aclGroups || []} lists={catalog.data?.aclLists || []} value={acls} onChange={setAcls} onSaveList={saveList} onDeleteList={deleteList} />
            <FormActions><Button type="submit" variant="primary" loading={busy}>Save privileges and nameservers</Button></FormActions>
          </Card>
        </form>
      )}
    </>
  );
}
