import { useEffect, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { renderMarkdown } from '../../plugins/PluginPage.jsx';
import { useAuth } from '../../../auth/AuthContext.jsx';

// `own` reaches the accounts the author owns: the only audience a reseller
// (with the Modify News privilege) can publish to.
const AUDIENCES = [{ value: 'all', label: 'Everyone (root, resellers and users)' }, { value: 'resellers', label: 'Resellers and root' }, { value: 'root', label: 'Root only' }, { value: 'own', label: 'Accounts I own' }];
const SEVERITIES = [{ value: 'info', label: 'Information' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical (cannot be dismissed)' }];
const EMPTY = { title: '', body: '', audience: 'all', severity: 'info', enabled: true, startsAt: '', endsAt: '' };

// <input type="datetime-local"> works in local time; the API stores UTC.
const toLocalInput = (sql) => { if (!sql) return ''; const d = new Date(sql.replace(' ', 'T') + 'Z'); const pad = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function Editor({ item, onClose, onSaved, isRoot }) {
  const toast = useToast();
  const audiences = isRoot ? AUDIENCES : AUDIENCES.filter((a) => a.value === 'own');
  const [draft, setDraft] = useState(EMPTY);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setDraft(item ? { ...item, startsAt: toLocalInput(item.startsAt), endsAt: toLocalInput(item.endsAt) } : { ...EMPTY, audience: isRoot ? 'all' : 'own' }); setError(null); }, [item, isRoot]);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { title: draft.title, body: draft.body, audience: draft.audience, severity: draft.severity, enabled: draft.enabled, startsAt: fromLocalInput(draft.startsAt), endsAt: fromLocalInput(draft.endsAt) };
      if (item?.id) await api.put(`/cpanel/news/${item.id}`, body); else await api.post('/cpanel/news', body);
      toast.success(item?.id ? 'News item saved' : 'News item published');
      onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <Modal open title={item?.id ? `Edit “${item.title}”` : 'New news item'} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button onClick={() => setPreview((p) => !p)}>{preview ? 'Edit' : 'Preview'}</Button><Button variant="primary" loading={saving} disabled={!draft.title.trim()} onClick={save}>{item?.id ? 'Save' : 'Publish'}</Button></>}>
      <ErrorBanner error={error} />
      {preview ? (
        <div className={`banner ${draft.severity === 'critical' ? 'banner-error' : draft.severity === 'warning' ? 'banner-warning' : 'banner-info'}`}>
          <Megaphone size={18} />
          <div><strong>{draft.title || 'Untitled'}</strong><div className="markdown">{renderMarkdown(draft.body)}</div></div>
        </div>
      ) : (
        <>
          <Field label="Title" required error={error?.fields?.title}><TextInput value={draft.title} onChange={set('title')} maxLength={160} autoFocus /></Field>
          <Field label="Body" help="Markdown: headings, lists, **bold**, `code` and http(s) links. HTML is shown as text." error={error?.fields?.body}><Textarea value={draft.body} onChange={set('body')} rows={8} /></Field>
          <div className="form-grid">
            <Field label="Audience" help={isRoot ? undefined : 'Shown on the dashboards of the accounts you own.'}><Select value={draft.audience} onChange={set('audience')} options={audiences} /></Field>
            <Field label="Severity"><Select value={draft.severity} onChange={set('severity')} options={SEVERITIES} /></Field>
            <Field label="Show from" help="Empty = immediately" error={error?.fields?.startsAt}><TextInput type="datetime-local" value={draft.startsAt} onChange={set('startsAt')} /></Field>
            <Field label="Show until" help="Empty = until disabled" error={error?.fields?.endsAt}><TextInput type="datetime-local" value={draft.endsAt} onChange={set('endsAt')} /></Field>
          </div>
          <Field inline><Toggle checked={draft.enabled} onChange={set('enabled')} label="Enabled" description="Disabled items are kept but never shown." /></Field>
        </>
      )}
    </Modal>
  );
}

export default function ModifyNews({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useApi(`/cpanel/news${queryString({ status, q, pageSize: 200 })}`);
  const [editing, setEditing] = useState(undefined);
  const rows = list.data || [];

  const toggle = async (n) => {
    try { await api.put(`/cpanel/news/${n.id}`, { enabled: !n.enabled }); toast.success(n.enabled ? 'Hidden' : 'Shown'); list.refetch(); } catch (err) { toast.error(err); }
  };
  const remove = async (n) => {
    if (!(await confirm({ title: `Delete “${n.title}”?`, message: 'The item disappears from every dashboard immediately.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/cpanel/news/${n.id}`); toast.success('Deleted'); list.refetch(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'title', label: 'Title', render: (n) => <><strong>{n.title}</strong><br /><span className="muted small">{n.body ? `${n.body.slice(0, 80)}${n.body.length > 80 ? '…' : ''}` : 'No body'}</span></> },
    { key: 'status', label: 'Status', render: (n) => <StatusPill status={n.status === 'active' ? 'active' : n.status === 'scheduled' ? 'pending' : n.status === 'expired' ? 'inactive' : 'disabled'}>{n.status}</StatusPill> },
    { key: 'audience', label: 'Audience', render: (n) => AUDIENCES.find((a) => a.value === n.audience)?.label.split(' (')[0] },
    { key: 'severity', label: 'Severity', render: (n) => <StatusPill status={n.severity === 'critical' ? 'failed' : n.severity === 'warning' ? 'warning' : 'queued'}>{n.severity}</StatusPill> },
    { key: 'window', label: 'Window', render: (n) => <span className="small">{n.startsAt ? formatDate(n.startsAt) : 'now'} → {n.endsAt ? formatDate(n.endsAt) : 'open'}</span> },
    { key: 'updatedAt', label: 'Updated', render: (n) => <span className="small">{formatDate(n.updatedAt)}{n.createdBy ? ` by ${n.createdBy}` : ''}</span> },
  ];
  const rowActions = (n) => [
    { label: 'Edit', primary: true, onClick: () => setEditing(n) },
    { label: n.enabled ? 'Hide' : 'Show', onClick: () => toggle(n) },
    { label: 'Delete', danger: true, onClick: () => remove(n) },
  ];

  return (
    <>
      <PageHeader fn={fn} actions={<Button variant="primary" onClick={() => setEditing(null)}>New item</Button>}>
        <p className="muted small">{isRoot ? 'Items appear at the top of the Home dashboard for the chosen audience while they are enabled and inside their time window.' : 'Items appear at the top of the Home dashboard of the accounts you own while they are enabled and inside their time window (Modify News privilege).'} Users can dismiss information and warnings per browser; critical items stay until you hide them.</p>
      </PageHeader>
      <Card padded={false} title="News items" actions={(
        <Select value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'expired', label: 'Expired' }, { value: 'disabled', label: 'Disabled' }]} placeholder="All statuses" />
      )}>
        <DataTable columns={columns} rows={rows} loading={list.loading} error={list.error} rowActions={rowActions} searchable q={q} onSearch={setQ} searchPlaceholder="Search title or body" emptyText="No news items" />
        {!list.loading && !list.error && rows.length === 0 && !q && !status && (
          <div className="card-body"><EmptyState icon={Megaphone} title="Nothing published yet"><p>Create an item to announce maintenance windows, policy changes or new features to resellers and users.</p></EmptyState></div>
        )}
      </Card>
      {editing !== undefined && <Editor item={editing} isRoot={isRoot} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); list.refetch(); }} />}
    </>
  );
}
