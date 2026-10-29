import { useState } from 'react';
import { Mails } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, CapabilityNotice, EmptyState, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { BRAND } from '../../../brand.js';

const isCapabilityError = (err) => err && (err.code === 'capability_missing' || err.code === 'binary_not_found' || err.status === 501);

export default function ResetMailmanPassword({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/cpanel/mailman/lists');
  const [list, setList] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [site, setSite] = useState({ password: '', creator: false, busy: false, error: null });
  const lists = data?.lists || [];

  const reset = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Reset the administrator password of “${list}”?`, message: 'The current list administrator password stops working immediately. Hand the new one to the list owner over a secure channel.', confirmLabel: 'Reset password', danger: true }))) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.post(`/cpanel/mailman/lists/${encodeURIComponent(list)}/password`, { password });
      toast.success(`Password reset for ${list}`);
      setPassword('');
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const setSitePassword = async (e) => {
    e.preventDefault();
    setSite((s) => ({ ...s, busy: true, error: null }));
    try {
      await api.post('/cpanel/mailman/site-password', { password: site.password, creator: site.creator });
      toast.success(site.creator ? 'List-creator password set' : 'Site password set');
      setSite({ password: '', creator: false, busy: false, error: null });
    } catch (err) { setSite((s) => ({ ...s, busy: false, error: err })); }
  };

  const columns = [
    { key: 'name', label: 'List', render: (l) => <code>{l.name}</code> },
    { key: 'description', label: 'Description', render: (l) => l.description || <span className="muted">—</span> },
  ];
  const rowActions = (l) => [{ label: 'Reset password', primary: true, disabled: data?.canResetPassword === false, onClick: () => { setList(l.name); document.getElementById('mailman-password')?.focus(); } }];

  return (
    <>
      <PageHeader fn={fn} actions={<Button onClick={refetch}>Refresh</Button>} />
      <CapabilityNotice error={error} onRetry={refetch} />
      {error && !isCapabilityError(error) && <ErrorBanner error={error} onRetry={refetch} />}
      {data && (
        <>
          <Card title="Mailing lists" subtitle={data.flavor === 'mailman3' ? 'Mailman 3: list administration is per user; per-list passwords do not exist' : 'Every Mailman 2 list on this server, advertised or not (list_lists)'} padded={false}>
            <DataTable columns={columns} rows={lists} loading={loading} rowActions={rowActions} rowKey={(l) => l.name} emptyText="No mailing lists exist" />
            {lists.length === 0 && !loading && <div className="card-body"><EmptyState icon={Mails} title="No mailing lists"><p>Lists are created from a hosting account's {BRAND.product} (Mailing Lists) or with Mailman's <code>newlist</code> tool.</p></EmptyState></div>}
          </Card>
          <Card title="Reset a list administrator password" subtitle="Runs Mailman's change_pw for the selected list">
            {data.canResetPassword === false ? (
              <p className="muted">Mailman 3 manages owners and moderators through Postorius or <code>mailman members</code>; there is no per-list administrator password to reset.</p>
            ) : (
              <form onSubmit={reset} className="form-narrow">
                <Field label="Mailing list" required help="Pick a list from the table or type its name" error={formError?.fields?.list}>
                  <TextInput value={list} onChange={(v) => setList(v.trim().toLowerCase())} list="mailman-list-names" className="input mono" placeholder="announce" maxLength={64} autoComplete="off" />
                  <datalist id="mailman-list-names">{lists.map((l) => <option key={l.name} value={l.name} />)}</datalist>
                </Field>
                <Field label="New administrator password" required help="At least 8 characters; must not start with a dash." error={formError?.fields?.password} htmlFor="mailman-password">
                  <PasswordInput id="mailman-password" value={password} onChange={setPassword} minStrength={50} />
                </Field>
                <ErrorBanner error={formError && !formError.fields ? formError : null} />
                <CapabilityNotice error={formError} />
                <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(list) || password.length < 8}>Reset password</Button></FormActions>
              </form>
            )}
          </Card>
          {data.flavor === 'mailman2' && (
            <Card title="Site password" subtitle="mmsitepass: the Mailman site password unlocks every list's administration pages; the list-creator password only allows creating lists">
              <form onSubmit={setSitePassword} className="form-narrow">
                <Field label="New password" required error={site.error?.fields?.password}><PasswordInput value={site.password} onChange={(v) => setSite((s) => ({ ...s, password: v }))} minStrength={50} /></Field>
                <Field inline><Toggle checked={site.creator} onChange={(v) => setSite((s) => ({ ...s, creator: v }))} label="Set the list-creator password instead of the site password" /></Field>
                <ErrorBanner error={site.error && !site.error.fields ? site.error : null} />
                <FormActions><Button type="submit" variant="primary" loading={site.busy} disabled={site.password.length < 8}>Set password</Button></FormActions>
              </form>
            </Card>
          )}
          <Card title="About">
            <KeyValue items={[['Mailman flavour', data.flavor], ['Lists', String(lists.length)], ['Audit', 'Every reset is recorded in the audit log without the password.']]} />
          </Card>
        </>
      )}
    </>
  );
}
