import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AclEditor, NameserversEditor, LimitsFields, PackagePicker, UsageBar, ResellerStatusPill, Summary, useResellerCatalog } from '../../resellers/Shared.jsx';

const EMPTY = { username: '', fromAccount: true, password: '', email: '', maxAccounts: null, maxDiskMb: null, maxBandwidthMb: null, oversellDisk: false, oversellBandwidth: false, aclList: 'standard', nameservers: [], ownsNameservers: false, sharedIp: '', allowedPackages: [] };

export default function ResellerCenter({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const t = useTableState({ sort: 'username' });
  const { data, meta, loading, error, refetch } = useApi(`/resellers${queryString(t.state)}`);
  const catalog = useResellerCatalog();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const rows = data || [];

  const act = async (label, fnc) => { try { await fnc(); toast.success(label); refetch(); } catch (err) { toast.error(err); } };

  const columns = [
    { key: 'username', label: 'Reseller', sortable: true, render: (r) => <><code>{r.username}</code>{r.account && <small className="muted" style={{ display: 'block' }}>{r.account.domain}</small>}</> },
    { key: 'email', label: 'Email' },
    { key: 'accounts', label: 'Accounts', align: 'right', render: (r) => `${r.usage.accounts}${r.limits.max_accounts != null ? ` / ${r.limits.max_accounts}` : ''}` },
    { key: 'disk', label: 'Disk allocated', render: (r) => r.limits.max_disk_mb != null ? <UsageBar used={r.usage.disk_allocated_mb} max={r.limits.max_disk_mb} /> : <span className="muted">{formatMb(r.usage.disk_allocated_mb)} / unlimited</span> },
    { key: 'acl_count', label: 'Privileges', align: 'right' },
    { key: 'shared_ip', label: 'Shared IP', render: (r) => r.limits.shared_ip || <span className="muted">server default</span> },
    { key: 'last_login_at', label: 'Last login', sortable: true, render: (r) => formatDate(r.last_login_at) },
    { key: 'status', label: 'Status', render: (r) => <ResellerStatusPill reseller={r} /> },
  ];

  const rowActions = (r) => [
    { label: 'Edit', primary: true, onClick: () => setEditing(r.username) },
    { label: 'Privileges & nameservers', onClick: () => navigate(`/resellers/edit-reseller-nameservers-and-privileges?username=${r.username}`) },
    { label: 'IP delegation', onClick: () => navigate(`/resellers/manage-resellers-ip-delegation?username=${r.username}`) },
    { label: 'Accounts', onClick: () => navigate(`/resellers/show-reseller-accounts?username=${r.username}`) },
    { label: 'Usage', onClick: () => navigate(`/resellers/view-reseller-usage-and-manage-account-status?username=${r.username}`) },
    r.suspended
      ? { label: 'Restore privileges', onClick: () => act(`${r.username}: reseller privileges restored`, () => api.post(`/resellers/${r.username}/unsuspend`)) }
      : { label: 'Suspend privileges', danger: true, onClick: async () => { if (await confirm({ title: `Suspend ${r.username}'s reseller privileges?`, message: 'The reseller can no longer log in to WHM or use the API. Its hosting accounts keep running.', confirmLabel: 'Suspend', danger: true })) act(`${r.username}: reseller privileges suspended`, () => api.post(`/resellers/${r.username}/suspend`, { reason: 'Suspended from Reseller Center' })); } },
    { label: 'Remove reseller status', danger: true, onClick: async () => { if (await confirm({ title: `Remove reseller status from ${r.username}?`, message: `Privileges, limits and delegated IPs are removed and ${r.usage.accounts} account(s) move to root. The login stays.`, confirmLabel: 'Reset reseller', danger: true, typeToConfirm: r.username })) act(`${r.username} is no longer a reseller`, () => api.post('/resellers/reset', { usernames: [r.username] })); } },
  ];

  return (
    <>
      <PageHeader fn={fn} description="Resellers are panel logins that own hosting accounts. Give an existing account reseller status or add a standalone login, then set its limits, privileges, packages, nameservers and shared IP." actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>Add reseller</Button>} />
      <Summary items={[['Resellers', meta?.total], ['Suspended', data ? rows.filter((r) => r.suspended).length : null], ['Accounts owned', data ? rows.reduce((n, r) => n + r.usage.accounts, 0) : null], ['Over limits', data ? rows.filter((r) => r.usage.over_accounts || r.usage.over_disk || r.usage.over_bandwidth).length : null]]} />
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={rows} loading={loading} rowKey={(r) => r.username} total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort} searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search reseller or email…" rowActions={rowActions}
          emptyText="No resellers yet. Add one from an existing account or as a standalone login." />
      </Card>
      <CreateResellerModal open={creating} onClose={() => setCreating(false)} catalog={catalog.data} onCreated={() => { setCreating(false); refetch(); catalog.refetch(); }} />
      {editing && <EditResellerModal username={editing} catalog={catalog.data} onClose={() => setEditing(null)} onSaved={() => { refetch(); }} />}
      <p className="muted" style={{ marginTop: 12 }}>Bulk actions live on their own pages: <Link to="/resellers/change-ownership-of-multiple-accounts">change ownership</Link>, <Link to="/resellers/reset-resellers">reset resellers</Link>, <Link to="/resellers/email-all-resellers">email all resellers</Link>.</p>
    </>
  );
}

function CreateResellerModal({ open, onClose, catalog, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const fieldErr = (k) => error?.fields?.[k];
  useEffect(() => { if (open) { setForm({ ...EMPTY, aclList: catalog?.defaultAclList || 'standard' }); setError(null); setResult(null); } }, [open, catalog]);
  const candidates = catalog?.candidateAccounts || [];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { username: form.username, fromAccount: form.fromAccount, maxAccounts: form.maxAccounts, maxDiskMb: form.maxDiskMb, maxBandwidthMb: form.maxBandwidthMb, oversellDisk: form.oversellDisk, oversellBandwidth: form.oversellBandwidth, aclList: form.aclList || undefined, ownsNameservers: form.ownsNameservers, nameservers: form.nameservers, allowedPackages: form.allowedPackages };
      if (form.password) body.password = form.password;
      if (form.email) body.email = form.email;
      if (form.sharedIp) body.sharedIp = form.sharedIp;
      const { data } = await api.post('/resellers', body);
      setResult(data);
      toast.success(`${data.username} is now a reseller`);
      if (!data.initialPassword) onCreated();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="Add a reseller" onClose={onClose} size="lg" footer={result?.initialPassword ? <Button variant="primary" onClick={onCreated}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit} disabled={!form.username}>Create reseller</Button></>}>
      {result?.initialPassword ? (
        <div>
          <div className="banner banner-success"><div><strong>{result.username} created.</strong> No password was given, so one was generated. It is shown once; the reseller must change it at first login.</div></div>
          <KeyValue items={[['Username', <code key="u">{result.username}</code>], ['Initial password', <code key="p">{result.initialPassword}</code>], ['Privileges', result.acls.length], ['Owned accounts', result.usage.accounts]]} />
        </div>
      ) : (
        <form onSubmit={submit}>
          <ErrorBanner error={error} />
          <Field inline><Toggle checked={form.fromAccount} onChange={(v) => setForm((f) => ({ ...f, fromAccount: v, username: '' }))} label="Create from an existing hosting account" description="The account becomes owned by itself and its contact email is used; otherwise a standalone WHM login is created" /></Field>
          <div className="form-grid">
            {form.fromAccount
              ? <Field label="Account" required error={fieldErr('username')}><Select value={form.username} onChange={set('username')} options={candidates.map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}` }))} placeholder={candidates.length ? 'Select an account' : 'Every account is already a reseller'} /></Field>
              : <Field label="Username" required error={fieldErr('username')} help="Lowercase, starts with a letter"><TextInput value={form.username} onChange={set('username')} placeholder="reseller1" /></Field>}
            <Field label="Email" error={fieldErr('email')} help={form.fromAccount ? 'Blank uses the account contact email' : undefined}><TextInput type="email" value={form.email} onChange={set('email')} /></Field>
            <Field label="Password" required={!form.fromAccount} error={fieldErr('password')} help={form.fromAccount ? 'Blank generates one, shown once after creation' : undefined}><PasswordInput value={form.password} onChange={set('password')} /></Field>
            <Field label="Privileges (ACL list)" help="Fine-tune later under Edit Reseller Nameservers and Privileges"><Select value={form.aclList} onChange={set('aclList')} options={(catalog?.aclLists || []).map((l) => ({ value: l.name, label: `${l.name} — ${l.acls.length} privilege(s)` }))} placeholder="None" /></Field>
            <Field label="Shared IP" help="Blank uses the server's shared IP" error={fieldErr('sharedIp')}><Select value={form.sharedIp} onChange={set('sharedIp')} options={(catalog?.addresses || []).filter((a) => !a.reserved).map((a) => ({ value: a.address, label: `${a.address}${a.is_main ? ' (main)' : ''}${a.server_shared ? ' (server shared)' : ''}` }))} placeholder="Server default" /></Field>
          </div>
          <h3 style={{ margin: '14px 0 6px' }}>Limits</h3>
          <LimitsFields form={form} set={set} fieldErr={fieldErr} />
          <h3 style={{ margin: '14px 0 6px' }}>Nameservers</h3>
          <NameserversEditor value={form.nameservers} onChange={set('nameservers')} owns={form.ownsNameservers} onOwnsChange={set('ownsNameservers')} defaults={catalog?.defaultNameservers || []} />
          <h3 style={{ margin: '14px 0 6px' }}>Allowed packages</h3>
          <PackagePicker packages={catalog?.packages || []} value={form.allowedPackages} onChange={set('allowedPackages')} />
        </form>
      )}
    </Modal>
  );
}

function EditResellerModal({ username, catalog, onClose, onSaved }) {
  const toast = useToast();
  const { data: reseller, error: loadError, refetch } = useApi(`/resellers/${encodeURIComponent(username)}`);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const fieldErr = (k) => error?.fields?.[k];
  useEffect(() => {
    if (!reseller) return;
    const l = reseller.limits;
    setForm({ email: reseller.email || '', maxAccounts: l.max_accounts, maxDiskMb: l.max_disk_mb, maxBandwidthMb: l.max_bandwidth_mb, oversellDisk: l.oversell_disk, oversellBandwidth: l.oversell_bandwidth, nameservers: l.nameservers, ownsNameservers: l.owns_nameservers, sharedIp: l.shared_ip || '', allowedPackages: l.allowed_packages, acls: reseller.acls, notes: l.notes || '' });
  }, [reseller]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/resellers/${encodeURIComponent(username)}`, { email: form.email || null, maxAccounts: form.maxAccounts, maxDiskMb: form.maxDiskMb, maxBandwidthMb: form.maxBandwidthMb, oversellDisk: form.oversellDisk, oversellBandwidth: form.oversellBandwidth, nameservers: form.nameservers, ownsNameservers: form.ownsNameservers, sharedIp: form.sharedIp || null, allowedPackages: form.allowedPackages, acls: form.acls, notes: form.notes || null });
      toast.success(`${data.username} saved: ${data.acls.length} privilege(s), ${data.limits.max_accounts ?? 'unlimited'} account(s)`);
      onSaved(); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open title={`Edit reseller ${username}`} onClose={onClose} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={!form}>Save</Button></>}>
      <ErrorBanner error={loadError} onRetry={refetch} />
      <ErrorBanner error={error} />
      {reseller && form && (
        <>
          <KeyValue items={[['Status', <ResellerStatusPill key="s" reseller={reseller} />], ['Accounts', `${reseller.usage.accounts} (${reseller.usage.suspended} suspended)`], ['Disk allocated / used', `${formatMb(reseller.usage.disk_allocated_mb)} / ${formatMb(reseller.usage.disk_used_mb)}`], ['Delegated IPs', reseller.delegated_ips.join(', ') || '—'], reseller.account && ['Hosting account', `${reseller.account.username} (${reseller.account.domain})`]]} />
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Email" error={fieldErr('email')}><TextInput type="email" value={form.email} onChange={set('email')} /></Field>
            <Field label="Shared IP" help="Default IP for accounts the reseller creates" error={fieldErr('sharedIp')}><Select value={form.sharedIp} onChange={set('sharedIp')} options={(catalog?.addresses || []).filter((a) => !a.reserved).map((a) => ({ value: a.address, label: `${a.address}${a.is_main ? ' (main)' : ''}${a.server_shared ? ' (server shared)' : ''}${a.delegated_to ? ` (delegated to ${a.delegated_to})` : ''}` }))} placeholder="Server default" /></Field>
            <Field label="Notes"><TextInput value={form.notes} onChange={set('notes')} /></Field>
          </div>
          <h3 style={{ margin: '14px 0 6px' }}>Limits</h3>
          <LimitsFields form={form} set={set} fieldErr={fieldErr} />
          <h3 style={{ margin: '14px 0 6px' }}>Nameservers</h3>
          <NameserversEditor value={form.nameservers} onChange={set('nameservers')} owns={form.ownsNameservers} onOwnsChange={set('ownsNameservers')} defaults={catalog?.defaultNameservers || []} />
          <h3 style={{ margin: '14px 0 6px' }}>Allowed packages</h3>
          <PackagePicker packages={catalog?.packages || []} value={form.allowedPackages} onChange={set('allowedPackages')} />
          <h3 style={{ margin: '14px 0 6px' }}>Privileges</h3>
          <AclEditor groups={catalog?.aclGroups || []} lists={catalog?.aclLists || []} value={form.acls} onChange={set('acls')} />
          <FormActions><span className="muted">Changes apply on Save.</span></FormActions>
        </>
      )}
    </Modal>
  );
}
