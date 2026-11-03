import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Mail } from 'lucide-react';
import { queryString } from '../../../api/client.js';
import { Card, KeyValue, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, NumberInput, PasswordInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, AddressInput, useAccountDomains, fieldError, quotaText } from './parts/Shared.jsx';

export function usageOf(row) {
  const u = row.usage;
  const limitBytes = u?.limitBytes ?? (row.quotaMb ? row.quotaMb * 1024 * 1024 : null);
  const bytes = u?.bytes ?? null;
  const percent = percentOf(bytes, limitBytes);
  const text = bytes == null ? (limitBytes ? `Up to ${formatBytes(limitBytes)}` : 'Unlimited') : limitBytes ? `${formatBytes(bytes)} of ${formatBytes(limitBytes)}` : `${formatBytes(bytes)} · unlimited`;
  return { bytes, limitBytes, percent, text, messages: u?.messages ?? null };
}

export function QuotaMeter({ row }) {
  const u = usageOf(row);
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 13 }}>{u.text}{u.messages != null && <span className="muted"> · {u.messages} messages</span>}</div>
      <div className={`meter ${meterTone(u.percent)}`} aria-hidden={u.percent == null} style={{ marginTop: 5 }}><span style={{ width: `${u.percent ?? 0}%` }} /></div>
    </div>
  );
}

function QuotaFields({ quotaMb, onChange, defaultQuotaMb, error }) {
  const unlimited = quotaMb == null;
  return (
    <>
      <Field label="Storage quota" error={error} help={unlimited ? 'The mailbox can grow until the account runs out of disk space.' : `${quotaText(quotaMb)} of storage for this mailbox.`}>
        <div className="input-group">
          <NumberInput value={quotaMb} onChange={(v) => onChange(v == null ? null : Math.max(0, Math.floor(v)))} min={1} step={1} disabled={unlimited} aria-label="Quota in megabytes" placeholder={String(defaultQuotaMb || 1024)} />
          <span className="muted" style={{ alignSelf: 'center' }}>MB</span>
        </div>
      </Field>
      <Toggle checked={unlimited} onChange={(on) => onChange(on ? null : (defaultQuotaMb || 1024))} label="Unlimited" description="No limit on this mailbox." />
    </>
  );
}

export function CreateMailboxForm({ domains, defaultQuotaMb, onSubmit, onCancel, busy, error }) {
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] || '');
  const [password, setPassword] = useState('');
  const [quotaMb, setQuotaMb] = useState(defaultQuotaMb || 1024);
  const submit = (e) => { e.preventDefault(); onSubmit({ localPart: localPart.trim(), domain, password, quotaMb }); };
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      <AddressInput localPart={localPart} domain={domain} domains={domains} onLocalPart={setLocalPart} onDomain={setDomain} error={fieldError(error, 'localPart') || fieldError(error, 'domain')} help="Lowercase letters, digits, dots, underscores and hyphens." autoFocus />
      <Field label="Password" required error={fieldError(error, 'password')} help="At least 8 characters; use the generator for a strong one.">
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <QuotaFields quotaMb={quotaMb} onChange={setQuotaMb} defaultQuotaMb={defaultQuotaMb} error={fieldError(error, 'quotaMb')} />
      <FormActions align="right">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!localPart.trim() || !domain || !password}>Create mailbox</Button>
      </FormActions>
    </form>
  );
}

export function PasswordForm({ address, onSubmit, onCancel, busy, error }) {
  const [password, setPassword] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ password }); }}>
      <MutationError error={error} />
      <p>New password for <strong>{address}</strong>. Mail apps signed in with the old password stop syncing until they are updated.</p>
      <Field label="New password" required error={fieldError(error, 'password')}>
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <FormActions align="right"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!password}>Change password</Button></FormActions>
    </form>
  );
}

export function QuotaForm({ row, defaultQuotaMb, onSubmit, onCancel, busy, error }) {
  const [quotaMb, setQuotaMb] = useState(row.quotaMb ?? null);
  const u = usageOf(row);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ quotaMb }); }}>
      <MutationError error={error} />
      <p>Storage for <strong>{row.address}</strong>{u.bytes != null && <> — currently {formatBytes(u.bytes)} in use</>}.</p>
      <QuotaFields quotaMb={quotaMb} onChange={setQuotaMb} defaultQuotaMb={defaultQuotaMb} error={fieldError(error, 'quotaMb')} />
      {quotaMb != null && u.bytes != null && quotaMb * 1024 * 1024 < u.bytes && <p className="field-message">The new quota is below what the mailbox already holds; new mail bounces until space is freed.</p>}
      <FormActions align="right"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save quota</Button></FormActions>
    </form>
  );
}

export function DeleteForm({ row, onSubmit, onCancel, busy, error }) {
  const [removeMail, setRemoveMail] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ removeMail }); }}>
      <MutationError error={error} />
      <p>The mailbox <strong>{row.address}</strong> stops receiving mail and its login no longer works.</p>
      <Toggle checked={removeMail} onChange={setRemoveMail} label="Also delete the stored messages" description="Removes the mailbox folder from your account. Leave this off to keep the messages on disk." />
      <FormActions align="right"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="danger" loading={busy}>Delete mailbox</Button></FormActions>
    </form>
  );
}

function ServerRow({ label, srv }) {
  if (!srv) return null;
  return [label, (
    <span key={label}>
      <code>{srv.host}</code> port <strong>{srv.port}</strong> ({srv.ssl ? 'SSL/TLS' : 'plain'})
      {srv.alternative && <span className="muted"> · or port {srv.alternative.port}{srv.alternative.starttls ? ' with STARTTLS' : ''}</span>}
    </span>
  )];
}

export function ClientSettings({ settings }) {
  if (!settings) return null;
  return (
    <>
      <KeyValue items={[
        ['Username', <code key="u">{settings.username}</code>],
        ['Password', 'The mailbox password'],
        ['Mail server', <code key="h">{settings.hostname}</code>],
      ]} />
      <h3 style={{ marginTop: 16 }}>Incoming mail</h3>
      <KeyValue items={[
        ServerRow({ label: 'IMAP (keeps mail on the server)', srv: settings.imap }),
        ServerRow({ label: 'POP3 (downloads mail)', srv: settings.pop3 }),
        !settings.imap && !settings.pop3 && ['Incoming', 'Neither IMAP nor POP3 is enabled on this server.'],
      ]} />
      <h3 style={{ marginTop: 16 }}>Outgoing mail</h3>
      <KeyValue items={[
        ServerRow({ label: 'SMTP', srv: settings.smtp }),
        ['Authentication', 'Required — same username and password'],
      ]} />
      {settings.webmail && <p style={{ marginTop: 12 }}><a className="btn btn-sm" href={settings.webmail} target="_blank" rel="noopener noreferrer">Open webmail</a></p>}
    </>
  );
}

function ClientSettingsSheet({ row, onClose }) {
  const { data, error, loading, refetch } = usePanelApi(row ? `/email/accounts/${row.id}/client-settings` : null);
  return (
    <Modal open={Boolean(row)} title={row ? `Connect ${row.address}` : ''} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <PanelRequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      <ClientSettings settings={data} />
    </Modal>
  );
}

export default function EmailAccounts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const table = useTableState({ pageSize: 25 });
  const [domainFilter, setDomainFilter] = useState('');
  const query = queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q, sort: table.state.sort, dir: table.state.sort ? table.state.dir : undefined, domain: domainFilter });
  const { data, meta, error, loading, refetch } = usePanelApi(`/email/accounts${query}`);
  const domains = useAccountDomains(meta?.domains);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState({});

  const used = meta?.used ?? (data?.length || 0);
  const limit = meta?.limits?.max_email;
  const atLimit = limit != null && limit > 0 && used >= limit;
  const defaultQuotaMb = meta?.defaultQuotaMb ?? 1024;

  const open = (kind, row = null) => { setMutationError(null); setDialog({ kind, row }); };
  const close = () => { setDialog(null); setMutationError(null); };

  const run = async (fnc, success) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await fnc();
      if (success) toast.success(success);
      const warnings = res?.meta?.warnings || [];
      for (const w of warnings) toast.warning(w.message);
      close();
      refetch();
      return res;
    } catch (err) {
      setMutationError(err);
      return null;
    } finally { setBusy(false); }
  };

  const create = (body) => run(() => panelApi.post('/email/accounts', body), `Mailbox ${body.localPart}@${body.domain} created`);
  const setPassword = (row, body) => run(() => panelApi.put(`/email/accounts/${row.id}/password`, body), `Password changed for ${row.address}`);
  const setQuota = (row, body) => run(() => panelApi.put(`/email/accounts/${row.id}/quota`, body), `Quota saved for ${row.address}`);
  const remove = (row, { removeMail }) => run(() => panelApi.delete(`/email/accounts/${row.id}${queryString({ removeMail: removeMail ? 1 : undefined })}`), `Mailbox ${row.address} deleted`);

  const toggleSuspend = async (row) => {
    const suspend = !row.suspended;
    if (suspend && !(await confirm({ title: `Suspend ${row.address}?`, message: 'The mailbox keeps its messages but cannot sign in or receive mail until it is unsuspended.', confirmLabel: 'Suspend', danger: true }))) return;
    setBusy(true);
    try {
      const res = await panelApi.patch(`/email/accounts/${row.id}`, { suspended: suspend });
      if (res?.data?.applied === false) setPending((p) => ({ ...p, [row.id]: res.data }));
      toast.success(`${row.address} ${suspend ? 'suspended' : 'unsuspended'}`);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const columns = useMemo(() => [
    { key: 'address', label: 'Address', sortable: true, render: (r) => <><code>{r.address}</code>{pending[r.id] && <> <PendingPill result={pending[r.id]} /></>}</> },
    { key: 'usage', label: 'Storage', render: (r) => <QuotaMeter row={r} /> },
    { key: 'quota_mb', label: 'Quota', sortable: true, align: 'right', render: (r) => quotaText(r.quotaMb) },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={r.suspended ? 'suspended' : 'active'} /> },
    { key: 'created_at', label: 'Created', sortable: true, render: (r) => <span className="muted">{formatDate(r.createdAt)}</span> },
  ], [pending]);

  const featureOff = error && error.status === 403 && error.code === 'feature_disabled';

  return (
    <PanelPage fn={fn} actions={!featureOff && <Button variant="primary" icon={Plus} onClick={() => open('create')} disabled={atLimit || !domains.length} title={atLimit ? 'Your plan limit for mailboxes is reached' : undefined}>Create mailbox</Button>}>
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat">
              <div className="label">Mailboxes</div>
              <div className="value">{limit != null && limit > 0 ? `${used} of ${limit}` : `${used}`}</div>
              <div className={`meter ${meterTone(percentOf(used, limit))}`} aria-hidden={limit == null || limit <= 0}><span style={{ width: `${percentOf(used, limit) ?? 0}%` }} /></div>
            </div>
            <div className="stat"><div className="label">Domains with mail</div><div className="value">{domains.length}</div></div>
            <div className="stat"><div className="label">Default quota</div><div className="value">{quotaText(defaultQuotaMb)}</div></div>
          </div>
          {atLimit && <div className="banner banner-warning"><Mail size={18} /><div><strong>Plan limit reached</strong><p>Your plan allows {limit} mailbox{limit === 1 ? '' : 'es'}. Delete one you no longer need, or ask your hosting provider about a larger plan.</p></div></div>}
          <Card padded={false}>
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {!error && (
              <DataTable
                columns={columns} rows={data || []} loading={loading}
                total={meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
                sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
                searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search addresses"
                toolbar={domains.length > 1 && <select className="input select" value={domainFilter} onChange={(e) => { setDomainFilter(e.target.value); table.setPage(1); }} aria-label="Filter by domain"><option value="">All domains</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
                emptyText={table.state.q || domainFilter ? 'No mailboxes match this filter.' : 'No mailboxes yet. Create one to receive mail at your domain; it appears here with its storage and status.'}
                rowActions={(r) => [
                  { label: 'Connect', primary: true, onClick: () => open('settings', r) },
                  { label: 'Change password', onClick: () => open('password', r) },
                  { label: 'Change quota', onClick: () => open('quota', r) },
                  { label: r.suspended ? 'Unsuspend' : 'Suspend', onClick: () => toggleSuspend(r), disabled: busy },
                  { label: 'Delete', danger: true, onClick: () => open('delete', r) },
                ]}
              />
            )}
          </Card>
          <p className="muted">Mail apps connect with the settings behind <strong>Connect</strong>. Forwarding and automatic replies live under <Link to="/panel/email/forwarders">Forwarders</Link> and <Link to="/panel/email/autoresponders">Autoresponders</Link>.</p>
        </>
      )}

      <Modal open={dialog?.kind === 'create'} title="Create mailbox" onClose={close}>
        {dialog?.kind === 'create' && <CreateMailboxForm domains={domains} defaultQuotaMb={defaultQuotaMb} onSubmit={create} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'password'} title="Change password" onClose={close} size="sm">
        {dialog?.kind === 'password' && <PasswordForm address={dialog.row.address} onSubmit={(b) => setPassword(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'quota'} title="Change quota" onClose={close} size="sm">
        {dialog?.kind === 'quota' && <QuotaForm row={dialog.row} defaultQuotaMb={defaultQuotaMb} onSubmit={(b) => setQuota(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'delete'} title="Delete mailbox" onClose={close} size="sm">
        {dialog?.kind === 'delete' && <DeleteForm row={dialog.row} onSubmit={(b) => remove(dialog.row, b)} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      {dialog?.kind === 'settings' && <ClientSettingsSheet row={dialog.row} onClose={close} />}
    </PanelPage>
  );
}
