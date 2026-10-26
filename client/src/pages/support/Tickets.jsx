import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, RefreshCw, Eye } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { Card, KeyValue, Loading, StatusPill, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { SeverityPill, DeliveryPill, RequestError, CopyButton, downloadText } from './Shared.jsx';

const CATEGORIES = ['general', 'accounts', 'email', 'dns', 'databases', 'web', 'ssl', 'security', 'backups', 'performance', 'licensing', 'other'];
const SEVERITIES = [
  { value: 'low', label: 'Low — question or cosmetic issue' },
  { value: 'normal', label: 'Normal — something is wrong but there is a workaround' },
  { value: 'high', label: 'High — a service or several accounts are affected' },
  { value: 'critical', label: 'Critical — the server or all accounts are down' },
];
const EMPTY = { subject: '', description: '', category: 'general', severity: 'normal', contactEmail: '', includeSnapshot: true };

export function TicketForm({ onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [preview, setPreview] = useState(false);
  const settings = useApi('/support/settings');
  const snapshot = useApi('/support/snapshot', { enabled: preview });
  const { mutate, loading, error, fieldErrors } = useMutation((body) => api.post('/support/tickets', body));
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const mailReady = settings.data?.email;

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { ...form };
      if (!body.contactEmail) delete body.contactEmail;
      const res = await mutate(body);
      const t = res.data;
      if (t.delivery.status === 'sent') toast.success(`Ticket ${t.reference} sent to ${t.delivery.to}`);
      else toast.warning(`Ticket ${t.reference} saved, but not emailed: ${t.delivery.detail}`, { timeout: 8000 });
      setForm(EMPTY);
      onCreated?.(t);
    } catch (err) { toast.error(err); }
  };

  return (
    <Card title="New ticket" subtitle="Saved on this server and emailed to the support address with a redacted snapshot of the system.">
      {settings.data && !mailReady && (
        <div className="banner banner-info"><div><strong>No support email address is configured</strong><p>The ticket will be stored here for your records but not emailed. Set the address under <Link to="/support/support-center">Support Center → Settings</Link>.</p></div></div>
      )}
      <form onSubmit={submit}>
        <ErrorBanner error={error && !fieldErrors ? error : null} />
        <Field label="Subject" required error={fieldErrors?.subject}><TextInput value={form.subject} onChange={set('subject')} maxLength={200} placeholder="One line that says what is wrong" /></Field>
        <div className="form-grid">
          <Field label="Severity" error={fieldErrors?.severity}><Select value={form.severity} onChange={set('severity')} options={SEVERITIES} /></Field>
          <Field label="Area" error={fieldErrors?.category}><Select value={form.category} onChange={set('category')} options={CATEGORIES} /></Field>
        </div>
        <Field label="Description" required error={fieldErrors?.description} help="What happened, since when, what you already tried, and which accounts or domains are affected."><Textarea value={form.description} onChange={set('description')} rows={8} /></Field>
        <Field label="Reply-to address" error={fieldErrors?.contactEmail} help="Where support should answer. Optional; defaults to the panel's contact settings."><TextInput value={form.contactEmail} onChange={set('contactEmail')} type="email" placeholder="you@example.com" /></Field>
        <Field error={fieldErrors?.includeSnapshot}>
          <Toggle checked={form.includeSnapshot} onChange={set('includeSnapshot')} label="Attach a system snapshot" description="Panel and OS versions, load, memory, disks, installed daemons and service states. No addresses, accounts or secrets." />
        </Field>
        <FormActions>
          <Button type="submit" variant="primary" icon={Send} loading={loading} disabled={!form.subject || form.description.length < 10}>Open ticket</Button>
          <Button icon={Eye} onClick={() => setPreview(true)}>Preview snapshot</Button>
        </FormActions>
      </form>
      <Modal open={preview} title="System snapshot (as attached)" onClose={() => setPreview(false)} size="lg" footer={<>{snapshot.data && <CopyButton text={JSON.stringify(snapshot.data, null, 2)} size={undefined} />}<Button onClick={() => setPreview(false)}>Close</Button></>}>
        <RequestError error={snapshot.error} onRetry={snapshot.refetch} />
        {snapshot.loading && !snapshot.data && <Loading />}
        {snapshot.data && <pre className="log" style={{ maxHeight: 480 }}>{JSON.stringify(snapshot.data, null, 2)}</pre>}
      </Modal>
    </Card>
  );
}

export function TicketDetail({ id, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi(id ? `/support/tickets/${id}` : null, { enabled: Boolean(id) });
  const [busy, setBusy] = useState(false);
  const act = async (fn, okMessage) => {
    setBusy(true);
    try { const res = await fn(); toast.success(typeof okMessage === 'function' ? okMessage(res.data) : okMessage); refetch(); onChanged?.(); return res; } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const t = data;
  return (
    <Modal open={Boolean(id)} title={t ? `${t.reference} — ${t.subject}` : 'Ticket'} onClose={onClose} size="lg"
      footer={t && (
        <>
          <Button icon={RefreshCw} loading={busy} onClick={() => act(() => api.post(`/support/tickets/${t.id}/resend`), (d) => (d.delivery.status === 'sent' ? `Sent to ${d.delivery.to}` : `Not sent: ${d.delivery.detail}`))}>Send again</Button>
          {t.hasSnapshot && <Button onClick={() => downloadText(`${t.reference}-snapshot.json`, JSON.stringify(t.snapshot, null, 2), 'application/json')}>Download snapshot</Button>}
          {t.status === 'open'
            ? <Button loading={busy} onClick={() => act(() => api.patch(`/support/tickets/${t.id}`, { status: 'closed' }), 'Ticket closed')}>Close ticket</Button>
            : <Button loading={busy} onClick={() => act(() => api.patch(`/support/tickets/${t.id}`, { status: 'open' }), 'Ticket reopened')}>Reopen</Button>}
          <Button variant="danger" loading={busy} onClick={async () => { if (await confirm({ title: 'Delete ticket', message: `Delete ${t.reference} and its snapshot from this server? Anything already emailed to support is unaffected.`, danger: true, confirmLabel: 'Delete' })) { await act(() => api.delete(`/support/tickets/${t.id}`), 'Ticket deleted'); onClose(); } }}>Delete</Button>
        </>
      )}>
      <RequestError error={error} onRetry={refetch} />
      {loading && !t && <Loading />}
      {t && (
        <>
          <KeyValue items={[
            ['Status', <StatusPill status={t.status === 'open' ? 'active' : 'done'}>{t.status}</StatusPill>],
            ['Severity', <SeverityPill severity={t.severity} />],
            ['Area', t.category],
            ['Opened', `${formatDate(t.createdAt)} by ${t.createdBy || '—'}`],
            t.closedAt && ['Closed', formatDate(t.closedAt)],
            ['Reply-to', t.contactEmail || '—'],
            ['Email delivery', <span><DeliveryPill delivery={t.delivery} /> {t.delivery.to ? `→ ${t.delivery.to}` : ''}{t.delivery.at ? ` at ${formatDate(t.delivery.at)}` : ''}</span>],
            t.delivery.detail && ['Delivery detail', t.delivery.detail],
          ]} />
          <h3 style={{ marginTop: 16 }}>Description</h3>
          <pre className="log" style={{ fontFamily: 'inherit', maxHeight: 260 }}>{t.description}</pre>
          {t.hasSnapshot && (
            <details style={{ marginTop: 12 }}>
              <summary>System snapshot</summary>
              <pre className="log" style={{ maxHeight: 360, marginTop: 8 }}>{JSON.stringify(t.snapshot, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

export function TicketList({ refreshKey = 0, onOpen }) {
  const table = useTableState({ pageSize: 25 });
  const [status, setStatus] = useState('');
  const { data, meta, loading, error, refetch } = useApi(`/support/tickets${queryString({ ...table.state, status: status || undefined, r: refreshKey })}`);
  const columns = [
    { key: 'reference', label: 'Reference', render: (r) => <button className="link-button" onClick={() => onOpen(r.id)}><code>{r.reference}</code></button> },
    { key: 'subject', label: 'Subject', sortable: true },
    { key: 'severity', label: 'Severity', sortable: true, render: (r) => <SeverityPill severity={r.severity} /> },
    { key: 'category', label: 'Area' },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusPill status={r.status === 'open' ? 'active' : 'done'}>{r.status}</StatusPill> },
    { key: 'delivery', label: 'Email', render: (r) => <DeliveryPill delivery={r.delivery} /> },
    { key: 'created_at', label: 'Opened', sortable: true, render: (r) => formatDate(r.createdAt) },
  ];
  return (
    <Card title="Tickets" subtitle="Every ticket opened from this server, whether or not it could be emailed." actions={<Button size="sm" icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <RequestError error={error} onRetry={refetch} />
      <DataTable columns={columns} rows={data || []} loading={loading} total={meta?.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
        sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search subject or reference…"
        emptyText="No tickets yet"
        toolbar={<Select value={status} onChange={(v) => { setStatus(v); table.setPage(1); }} options={[{ value: '', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />}
        rowActions={(r) => [{ label: 'View', primary: true, onClick: () => onOpen(r.id) }]} />
    </Card>
  );
}
