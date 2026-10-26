import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError, InterfaceSelect } from '../../ip/Shared.jsx';

const EMPTY = { name: '', range: '', interface: '', enabled: true, notes: '' };

export default function Ipv6Ranges({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/ip/ipv6/ranges');
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [mapping, setMapping] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim(), range: form.range.trim(), enabled: form.enabled };
      if (form.interface) body.interface = form.interface;
      if (form.notes.trim()) body.notes = form.notes.trim();
      const { data: res } = await api.post('/ip/ipv6/ranges', body);
      toast.success(`Range "${res.name}" created (${res.range_cidr})`);
      setForm(EMPTY);
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const toggle = async (r) => {
    try { await api.put(`/ip/ipv6/ranges/${r.id}`, { enabled: !r.enabled }); toast.success(`${r.name} ${r.enabled ? 'disabled' : 'enabled'}`); refetch(); } catch (err) { toast.error(err); }
  };
  const remove = async (r) => {
    if (!(await confirm({ title: `Delete range "${r.name}"?`, message: `${r.range_cidr} is removed from the panel. Addresses already bound from it are not touched; ranges with assigned addresses cannot be deleted.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/ip/ipv6/ranges/${r.id}`); toast.success('Range deleted'); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="IPv6 ranges are networks delegated to this server (for example a /64 from your provider). Enabled ranges feed Assign IPv6 Address; map a range to accounts to let their resellers draw from it." />
      <IpRequestError error={error} onRetry={refetch} />
      <form onSubmit={create}>
        <Card title="Add a range">
          <ErrorBanner error={formError && !formError.fields ? formError : null} />
          <div className="form-grid">
            <Field label="Name" required error={formError?.fields?.name}><TextInput value={form.name} onChange={set('name')} placeholder="customers" /></Field>
            <Field label="Range (CIDR)" required help="/16 to /126; the network address is never assigned" error={formError?.fields?.range}><TextInput value={form.range} onChange={set('range')} placeholder="2001:db8:1::/64" /></Field>
            <InterfaceSelect value={form.interface} onChange={set('interface')} family={6} help="Interface addresses from this range are bound to; blank uses the IPv6 default route" error={formError?.fields?.interface} />
            <Field label="Notes" error={formError?.fields?.notes}><TextInput value={form.notes} onChange={set('notes')} placeholder="optional" /></Field>
          </div>
          <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" description="Disabled ranges keep their assignments but hand out no new addresses" /></Field>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.name || !form.range}>Add range</Button></FormActions>
        </Card>
      </form>
      <Card title="IPv6 ranges" padded={false} actions={<Link className="btn btn-sm" to="/ip-functions/assign-ipv6-address">Assign addresses</Link>}>
        <DataTable
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'range_cidr', label: 'Range', render: (r) => <code>{r.range_cidr}</code> },
            { key: 'enabled', label: 'State', render: (r) => <StatusPill status={r.enabled ? 'enabled' : 'disabled'}>{r.enabled ? 'enabled' : 'disabled'}</StatusPill> },
            { key: 'interface', label: 'Interface', render: (r) => r.interface || <span className="muted">auto</span> },
            { key: 'assigned_count', label: 'Assigned', align: 'right' },
            { key: 'account_count', label: 'Accounts allowed', align: 'right', render: (r) => r.account_count ? <span title={r.accounts.join(', ')}>{r.account_count}</span> : <span className="muted">any (root only)</span> },
            { key: 'notes', label: 'Notes', render: (r) => <span className="muted">{r.notes || ''}</span> },
          ]}
          rows={data || []} loading={loading} rowKey={(r) => r.id}
          rowActions={(r) => [
            { label: 'Edit', primary: true, onClick: () => setEditing(r) },
            { label: 'Accounts', onClick: () => setMapping(r) },
            { label: r.enabled ? 'Disable' : 'Enable', onClick: () => toggle(r) },
            { label: 'Delete', danger: true, disabled: r.assigned_count > 0, onClick: () => remove(r) },
          ]}
          emptyText="No IPv6 ranges defined."
        />
      </Card>
      <EditRangeModal range={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); }} />
      <RangeAccountsModal range={mapping} onClose={() => setMapping(null)} onSaved={() => { setMapping(null); refetch(); }} />
    </>
  );
}

function EditRangeModal({ range, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: preview } = useApi(range ? `/ip/ipv6/ranges/${range.id}/preview?count=5` : null, { enabled: Boolean(range) });
  useEffect(() => { if (range) { setForm({ name: range.name, range: range.range_cidr, interface: range.interface || '', enabled: range.enabled, notes: range.notes || '' }); setError(null); } }, [range]);
  if (!range || !form) return null;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { name: form.name.trim(), enabled: form.enabled, interface: form.interface || null, notes: form.notes.trim() || null };
      if (form.range.trim() !== range.range_cidr) body.range = form.range.trim();
      await api.put(`/ip/ipv6/ranges/${range.id}`, body);
      toast.success('Range saved');
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Edit range "${range.name}"`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <Field label="Name" error={error?.fields?.name}><TextInput value={form.name} onChange={set('name')} /></Field>
      <Field label="Range (CIDR)" help={range.assigned_count ? 'Cannot change while addresses are assigned from it' : undefined} error={error?.fields?.range}><TextInput value={form.range} onChange={set('range')} disabled={range.assigned_count > 0} /></Field>
      <InterfaceSelect value={form.interface} onChange={set('interface')} family={6} error={error?.fields?.interface} />
      <Field label="Notes" error={error?.fields?.notes}><Textarea value={form.notes} onChange={set('notes')} rows={3} /></Field>
      <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" /></Field>
      <KeyValue items={[['First / last', <span key="fl"><code>{range.first_address}</code> … <code>{range.last_address}</code></span>], ['Size', range.size_text], ['Next free', preview ? preview.next.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : '…']]} />
    </Modal>
  );
}

function RangeAccountsModal({ range, onClose, onSaved }) {
  const toast = useToast();
  const { data: accounts } = useApi(range ? '/accounts?pageSize=500&sort=username' : null, { enabled: Boolean(range) });
  const [selected, setSelected] = useState([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (range) setSelected(range.accounts || []); }, [range]);
  const rows = useMemo(() => (accounts || []).filter((a) => !filter || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(filter.toLowerCase())), [accounts, filter]);
  if (!range) return null;
  const save = async () => {
    setBusy(true);
    try { await api.put(`/ip/ipv6/ranges/${range.id}/accounts`, { accounts: selected }); toast.success(`${selected.length} account(s) may use "${range.name}"`); onSaved(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Accounts allowed to use "${range.name}"`} onClose={onClose} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <p className="muted">Root can assign from any enabled range. Resellers can only assign addresses to their accounts from ranges listed here.</p>
      <DataTable
        columns={[{ key: 'username', label: 'Account' }, { key: 'domain', label: 'Domain' }, { key: 'owner', label: 'Owner' }, { key: 'ip', label: 'IPv4', render: (a) => <code>{a.ip || '—'}</code> }]}
        rows={rows} rowKey={(a) => a.username} selectable selected={selected} onSelectedChange={setSelected} dense
        searchable q={filter} onSearch={setFilter} searchPlaceholder="Filter accounts" emptyText="No accounts"
      />
    </Modal>
  );
}
