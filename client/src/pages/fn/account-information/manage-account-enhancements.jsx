import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatDate, KeyValue, Loading, EmptyState } from '../../../components/Common.jsx';
import { Button, Field, TextInput, Textarea, Toggle, Select, NumberInput, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountPicker } from '../../accounts/AccountPicker.jsx';
import { RequestError } from '../../account-info/Shared.jsx';

const LIMIT_PRESETS = ['max_email', 'max_db', 'max_ftp', 'max_subdomains', 'max_addons', 'max_parked', 'disk_mb', 'bandwidth_mb', 'max_email_per_hour', 'priority_support', 'cdn', 'dedicated_ip'];
const EMPTY = { name: '', id: '', description: '', enabled: true, limits: [] };

export default function ManageAccountEnhancements({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const t = useTableState({ sort: 'name' });
  const { data, meta, loading, error, refetch } = useApi(`/account-info/enhancements${queryString(t.state)}`);
  const [editing, setEditing] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const remove = async (e) => {
    if (!(await confirm({ title: `Delete "${e.name}"?`, message: `The enhancement is removed from ${e.assigned} account(s). Package limits are not affected.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/account-info/enhancements/${e.id}`); toast.success(`Deleted ${e.name}`); refetch(); setRefreshKey((k) => k + 1); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: 'Name', sortable: true, render: (e) => <><strong>{e.name}</strong>{e.description && <div className="muted" style={{ fontSize: 12 }}>{e.description}</div>}</> },
    { key: 'id', label: 'ID', sortable: true, render: (e) => <code>{e.id}</code> },
    { key: 'limits', label: 'Limits', render: (e) => <LimitChips limits={e.limits} /> },
    { key: 'assigned', label: 'Accounts', sortable: true, align: 'right' },
    { key: 'enabled', label: 'Status', render: (e) => <StatusPill status={e.enabled ? 'enabled' : 'disabled'}>{e.enabled ? 'Enabled' : 'Disabled'}</StatusPill> },
    { key: 'created_at', label: 'Created', sortable: true, render: (e) => formatDate(e.created_at) },
  ];
  const rowActions = (e) => isRoot ? [
    { label: 'Edit', primary: true, onClick: () => setEditing(e) },
    { label: e.enabled ? 'Disable' : 'Enable', onClick: async () => { try { await api.put(`/account-info/enhancements/${e.id}`, { enabled: !e.enabled }); toast.success(`${e.name} ${e.enabled ? 'disabled' : 'enabled'}`); refetch(); setRefreshKey((k) => k + 1); } catch (err) { toast.error(err); } } },
    { label: 'Delete', danger: true, onClick: () => remove(e) },
  ] : [];

  return (
    <>
      <PageHeader fn={fn} description="Enhancements are named bundles of extra limits (more mailboxes, a CDN, priority support…) sold on top of a package. Define them here, then assign any number of them to an account; the merged limits are exposed to the other panel functions."
        actions={isRoot && <Button variant="primary" icon={Plus} onClick={() => setEditing({ ...EMPTY })}>Create enhancement</Button>} />
      <RequestError error={error} onRetry={refetch} />
      <Card padded={false}>
        <DataTable columns={columns} rows={data || []} loading={loading} error={null} rowKey={(e) => e.id}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search enhancements…"
          rowActions={rowActions} emptyText={isRoot ? 'No enhancements defined yet. Create one to start assigning add-ons.' : 'No enhancements have been defined by the server administrator.'} />
      </Card>
      <AssignCard enhancements={data || []} refreshKey={refreshKey} />
      <EnhancementModal value={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); setRefreshKey((k) => k + 1); }} />
    </>
  );
}

function LimitChips({ limits }) {
  const entries = Object.entries(limits || {});
  if (!entries.length) return <span className="muted">none</span>;
  return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{entries.map(([k, v]) => <span key={k} className="pill pill-muted" style={{ textTransform: 'none' }}>{k}: {String(v)}</span>)}</span>;
}

function toRows(limits) { return Object.entries(limits || {}).map(([key, value]) => ({ key, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text', value })); }
function fromRows(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.key) continue;
    out[r.key] = r.type === 'number' ? Number(r.value ?? 0) : r.type === 'boolean' ? Boolean(r.value) : String(r.value ?? '');
  }
  return out;
}

function EnhancementModal({ value, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setForm(value ? { ...value, limits: Array.isArray(value.limits) ? value.limits : toRows(value.limits) } : null); setError(null); }, [value]);
  if (!form) return null;
  const isNew = !value?.created_at;
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (i, patch) => setForm((f) => ({ ...f, limits: f.limits.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const body = { name: form.name.trim(), description: form.description || '', enabled: Boolean(form.enabled), limits: fromRows(form.limits) };
      if (isNew) { if (form.id) body.id = form.id; await api.post('/account-info/enhancements', body); toast.success(`Created ${body.name}`); } else { await api.put(`/account-info/enhancements/${value.id}`, body); toast.success(`Saved ${body.name}`); }
      onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  return (
    <Modal open title={isNew ? 'Create enhancement' : `Edit ${value.name}`} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!form.name.trim()} onClick={save}>{isNew ? 'Create' : 'Save'}</Button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Name" required error={error?.fields?.name}><TextInput value={form.name} onChange={set('name')} maxLength={80} placeholder="Extra Mailboxes (50)" /></Field>
        <Field label="ID" help={isNew ? 'Lowercase slug; derived from the name when empty' : 'Cannot be changed'} error={error?.fields?.id}><TextInput value={isNew ? form.id : value.id} onChange={set('id')} disabled={!isNew} placeholder="extra-mailboxes-50" /></Field>
      </div>
      <Field label="Description"><Textarea value={form.description} onChange={set('description')} rows={2} maxLength={500} /></Field>
      <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" description="Disabled enhancements stay assigned but do not count towards an account's effective limits" /></Field>
      <Field label="Limits" help="Numbers merge by taking the highest value across an account's enhancements; booleans OR together" error={error?.fields && Object.keys(error.fields).filter((k) => k.startsWith('limits')).map((k) => error.fields[k]).flat()}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Key</th><th style={{ width: 120 }}>Type</th><th>Value</th><th style={{ width: 60 }} /></tr></thead>
            <tbody>
              {form.limits.map((r, i) => (
                <tr key={i}>
                  <td><TextInput value={r.key} onChange={(v) => setRow(i, { key: v.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} list="limit-presets" placeholder="max_email" /></td>
                  <td><Select value={r.type} onChange={(v) => setRow(i, { type: v, value: v === 'number' ? Number(r.value) || 0 : v === 'boolean' ? Boolean(r.value) : String(r.value ?? '') })} options={[{ value: 'number', label: 'Number' }, { value: 'boolean', label: 'Yes/No' }, { value: 'text', label: 'Text' }]} /></td>
                  <td>
                    {r.type === 'number' && <NumberInput value={r.value} onChange={(v) => setRow(i, { value: v ?? 0 })} nullable={false} />}
                    {r.type === 'boolean' && <Toggle checked={r.value} onChange={(v) => setRow(i, { value: v })} label={r.value ? 'Yes' : 'No'} />}
                    {r.type === 'text' && <TextInput value={r.value} onChange={(v) => setRow(i, { value: v })} maxLength={200} />}
                  </td>
                  <td><Button size="sm" variant="danger-ghost" onClick={() => setForm((f) => ({ ...f, limits: f.limits.filter((_, j) => j !== i) }))}>Remove</Button></td>
                </tr>
              ))}
              {form.limits.length === 0 && <tr><td colSpan={4} className="table-state">No limits yet; an enhancement may also be a plain entitlement flag.</td></tr>}
            </tbody>
          </table>
        </div>
        <datalist id="limit-presets">{LIMIT_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
        <FormActions><Button size="sm" icon={Plus} disabled={form.limits.length >= 50} onClick={() => setForm((f) => ({ ...f, limits: [...f.limits, { key: '', type: 'number', value: 0 }] }))}>Add limit</Button></FormActions>
      </Field>
    </Modal>
  );
}

function AssignCard({ enhancements, refreshKey }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const assigned = useApi(username ? `/account-info/accounts/${encodeURIComponent(username)}/enhancements` : null, { enabled: Boolean(username) });
  const effective = useApi(username ? `/account-info/accounts/${encodeURIComponent(username)}/enhancements/effective` : null, { enabled: Boolean(username) });
  useEffect(() => { if (assigned.data) setDraft(assigned.data.map((e) => e.id)); }, [assigned.data]);
  const { refetch: refetchAssigned } = assigned;
  const { refetch: refetchEffective } = effective;
  useEffect(() => { if (username) { refetchAssigned(); refetchEffective(); } }, [refreshKey, username, refetchAssigned, refetchEffective]);

  const current = (assigned.data || []).map((e) => e.id).sort().join(',');
  const dirty = draft && draft.slice().sort().join(',') !== current;
  const save = async () => {
    setSaving(true);
    try { await api.put(`/account-info/accounts/${username}/enhancements`, { enhancements: draft }); toast.success(`Enhancements updated for ${username}`); await assigned.refetch(); await effective.refetch(); } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Assign to an account" subtitle="Pick an account, tick the enhancements it is entitled to and save. Deep-link with ?username=.">
      <AccountPicker value={username} onChange={setUsername} />
      {username && (
        <>
          <RequestError error={assigned.error} onRetry={assigned.refetch} />
          {assigned.loading && !assigned.data && <Loading />}
          {draft && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(240px, 2fr)', gap: 20, marginTop: 8 }}>
              <div>
                {enhancements.length === 0 && <EmptyState title="No enhancements to assign">Create an enhancement first.</EmptyState>}
                {enhancements.map((e) => {
                  const on = draft.includes(e.id);
                  const info = (assigned.data || []).find((a) => a.id === e.id);
                  return (
                    <Field key={e.id} inline>
                      <Toggle checked={on} onChange={(v) => setDraft((d) => (v ? [...d, e.id] : d.filter((x) => x !== e.id)))}
                        label={<>{e.name} {!e.enabled && <StatusPill status="disabled">disabled</StatusPill>}</>}
                        description={<>{e.description && <span>{e.description} · </span>}<LimitChips limits={e.limits} />{info && <span className="muted"> · assigned {formatDate(info.assigned_at)}{info.assigned_by ? ` by ${info.assigned_by}` : ''}</span>}</>} />
                    </Field>
                  );
                })}
                <FormActions>
                  <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save assignments</Button>
                  <Button disabled={!dirty || saving} onClick={() => setDraft((assigned.data || []).map((e) => e.id))}>Reset</Button>
                </FormActions>
              </div>
              <div>
                <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Effective extra limits</h3>
                <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>Merged across the saved, enabled enhancements; applied on top of the package.</p>
                {effective.data && Object.keys(effective.data).length === 0 && <p className="muted">None.</p>}
                {effective.data && Object.keys(effective.data).length > 0 && <KeyValue items={Object.entries(effective.data).map(([k, v]) => [k, String(v)])} />}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
