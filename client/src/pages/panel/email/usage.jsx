import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Card, StatusPill, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Select, NumberInput, Field } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, quotaText, useEmailT, tr } from './parts/Shared.jsx';

export const WINDOWS = [{ value: '1', label: 'Last hour' }, { value: '6', label: 'Last 6 hours' }, { value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' }];
export const STATUSES = [{ value: '', label: 'Any status' }, { value: 'delivered', label: 'Delivered' }, { value: 'failed', label: 'Failed' }, { value: 'deferred', label: 'Deferred' }, { value: 'rejected', label: 'Rejected' }, { value: 'queued', label: 'Queued' }, { value: 'completed', label: 'Completed' }];
export const PAGE_SIZE = 25;
export const EMPTIABLE = ['Trash', 'Junk'];
export const MIN_OLDER_THAN_DAYS = 7;

const STATUS = { delivered: 'ok', completed: 'ok', failed: 'failed', rejected: 'failed', deferred: 'warning', queued: 'pending' };
const windowOptions = (t) => WINDOWS.map((w) => ({ ...w, label: t(`panel.email.usage.window_${w.value}`, w.label) }));
const statusOptions = (t) => STATUSES.map((s) => ({ ...s, label: t(`panel.email.usage.status_${s.value || 'any'}`, s.label) }));

export function DeliveryPill({ status }) {
  return <StatusPill status={STATUS[status] || 'unknown'}>{status}</StatusPill>;
}

// The query string of GET /email/usage/messages for a filter state.
export function messagesQuery({ hours, q, status, page }) {
  const params = new URLSearchParams({ sinceHours: String(hours), page: String(page || 1), pageSize: String(PAGE_SIZE) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  return `/email/usage/messages?${params.toString()}`;
}

export function Totals({ totals, storage }) {
  const { t } = useEmailT();
  const tiles = [
    [t('panel.email.usage.messages', 'Messages'), totals.messages], [t('panel.email.usage.sent', 'Sent'), totals.sent], [t('panel.email.usage.received', 'Received'), totals.received], [t('panel.email.usage.status_delivered', 'Delivered'), totals.delivered],
    [t('panel.email.usage.status_failed', 'Failed'), totals.failed, totals.failed ? 'bad' : null], [t('panel.email.usage.status_deferred', 'Deferred'), totals.deferred, totals.deferred ? 'warn' : null], [t('panel.email.usage.status_queued', 'Queued'), totals.queued, totals.queued ? 'warn' : null],
  ];
  return (
    <div className="stat-grid" style={{ marginBottom: 18 }}>
      {tiles.map(([label, value, tone]) => (
        <div className="stat" key={label}><div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{tone && <span className={`dot dot-${tone}`} />}{label}</div><div className="value">{value ?? 0}</div></div>
      ))}
      {storage && (
        <div className="stat"><div className="label">{t('panel.email.common.mailboxes', 'Mailboxes')}</div><div className="value">{storage.limit != null && storage.limit > 0 ? t('panel.email.common.n_of_m', '{n} of {m}', { n: storage.mailboxes, m: storage.limit }) : storage.mailboxes}</div><div className="muted" style={{ fontSize: 12.5 }}>{storage.quotaMb ? t('panel.email.usage.allotted', '{quota} allotted', { quota: quotaText(storage.quotaMb) }) : t('panel.email.usage.no_quotas', 'No quotas set')}</div></div>
      )}
    </div>
  );
}

export function LogNote({ log, hours }) {
  const { t } = useEmailT();
  if (!log) return null;
  if (log.exists === false) return <p className="muted">{t('panel.email.usage.log_none', 'The mail server has not logged anything yet.')}</p>;
  if (log.truncated) return <p className="muted">{t('panel.email.usage.log_truncated', 'Only the most recent part of the mail log was scanned for the last {hours} h.', { hours })}</p>;
  if (log.from) return <p className="muted">{t('panel.email.usage.log_from', 'Log entries start {date}; earlier mail is in rotated logs and not counted.', { date: formatDate(log.from) })}</p>;
  return null;
}

// Folders of one mailbox with "Empty" (Trash/Junk) or "Delete older than N days".
export function Folders({ mailboxes }) {
  const { t } = useEmailT();
  const toast = useToast();
  const { me } = usePanelMe();
  const [mailboxId, setMailboxId] = useState(String(mailboxes[0]?.id ?? ''));
  const { data, meta, error, loading, refetch } = usePanelApi(mailboxId ? `/email/accounts/${mailboxId}/folders` : null);
  const [target, setTarget] = useState(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const readOnly = Boolean(me?.actingAs) || Boolean(me?.account?.demoMode);

  const ask = (folder) => { setProblem(null); setDays(30); setTarget(folder); };
  const run = async () => {
    const body = EMPTIABLE.includes(target.name) ? {} : { olderThanDays: Number(days) };
    setBusy(true); setProblem(null);
    try {
      const { data: r } = await panelApi.post(`/email/accounts/${mailboxId}/folders/${encodeURIComponent(target.name)}/empty`, body);
      toast.success(r.removed != null ? (r.removed === 1 ? t('panel.email.usage.toast_removed_one', '1 message deleted from {folder}', { folder: target.name }) : t('panel.email.usage.toast_removed', '{count} messages deleted from {folder}', { count: r.removed, folder: target.name })) : t('panel.email.usage.toast_emptied', '{folder} emptied', { folder: target.name }));
      setTarget(null);
      refetch();
    } catch (err) { setProblem(err); } finally { setBusy(false); }
  };

  const mailboxSelect = <Select aria-label={t('panel.email.common.mailbox', 'Mailbox')} value={mailboxId} onChange={setMailboxId} options={mailboxes.map((m) => ({ value: String(m.id), label: m.address }))} />;
  const usage = meta?.usage;
  const emptiable = target && EMPTIABLE.includes(target.name);
  return (
    <Card title={t('panel.email.usage.folders', 'Folders')} subtitle={t('panel.email.usage.folders_subtitle', 'What each folder of a mailbox holds. Trash and Junk can be emptied; other folders only lose mail older than a number of days you choose.')} actions={mailboxes.length ? mailboxSelect : null} padded={false}>
      {!mailboxes.length && <p className="muted" style={{ padding: 16 }}>{t('panel.email.common.no_mailboxes_create_under', 'No mailboxes yet. Create one under')} <Link to="/panel/email/accounts">{t('panel.email/accounts.label', 'Email accounts')}</Link>.</p>}
      {mailboxId && error && <div style={{ padding: 16 }}><PanelRequestError error={error} onRetry={refetch} /></div>}
      {mailboxId && !error && (
        <>
          {usage && <p className="muted" style={{ padding: '12px 16px 0' }}>{t('panel.email.usage.mailbox_usage', '{used} used{messages} (from {source}).', { used: `${usage.bytes != null ? formatBytes(usage.bytes) : '—'}${usage.limitBytes ? ` ${t('panel.email.usage.of_limit', 'of {limit}', { limit: formatBytes(usage.limitBytes) })}` : ''}`, messages: usage.messages != null ? `, ${t('panel.email.accounts.messages_count', '{count} messages', { count: usage.messages })}` : '', source: usage.source === 'dovecot' ? t('panel.email.usage.source_dovecot', 'the mail server') : t('panel.email.usage.source_disk', 'disk usage') })}</p>}
          <DataTable dense loading={loading && !data} columns={[
            { key: 'name', label: t('panel.email.usage.folder', 'Folder'), render: (r) => <code>{r.name}</code> },
            { key: 'messages', label: t('panel.email.usage.messages', 'Messages'), align: 'right', render: (r) => (r.messages ?? '—') },
            { key: 'unseen', label: t('panel.email.usage.unread', 'Unread'), align: 'right', render: (r) => (r.unseen ?? '—') },
            { key: 'bytes', label: t('panel.email.usage.size', 'Size'), align: 'right', render: (r) => (r.bytes != null ? formatBytes(r.bytes) : '—') },
            { key: 'actions', label: '', align: 'right', render: (r) => (
              <Button size="sm" variant={r.emptiable ? 'danger' : 'default'} icon={Trash2} disabled={readOnly || !r.messages} onClick={() => ask(r)}>{r.emptiable ? t('panel.email.usage.empty', 'Empty') : t('panel.email.usage.delete_old', 'Delete old mail')}</Button>
            ) },
          ]} rows={data || []} rowKey={(r) => r.name} emptyText={t('panel.email.usage.folders_empty', 'The mail server lists no folders for this mailbox yet; they appear after the first message arrives.')} />
        </>
      )}
      <Modal open={Boolean(target)} title={emptiable ? t('panel.email.usage.empty_title', 'Empty {folder}?', { folder: target.name }) : t('panel.email.usage.delete_old_title', 'Delete old mail from {folder}?', { folder: target?.name })} onClose={() => setTarget(null)} size="sm"
        footer={<><Button onClick={() => setTarget(null)}>{t('panel.email.common.cancel', 'Cancel')}</Button><Button variant="danger" loading={busy} disabled={target && !EMPTIABLE.includes(target.name) && !(Number(days) >= MIN_OLDER_THAN_DAYS)} onClick={run}>{emptiable ? t('panel.email.usage.empty_folder', 'Empty folder') : t('panel.email.common.delete', 'Delete')}</Button></>}>
        {emptiable
          ? <p className="muted">{t('panel.email.usage.empty_text_1', 'All {count} messages in', { count: target.messages ?? '' })} <code>{target.name}</code> {t('panel.email.usage.empty_text_2', 'are deleted permanently. They cannot be recovered.')}</p>
          : (
            <>
              <p className="muted">{t('panel.email.usage.delete_old_text_1', 'Messages in')} <code>{target?.name}</code> {t('panel.email.usage.delete_old_text_2', 'saved before the age below are deleted permanently. The mail server keeps anything newer.')}</p>
              <Field label={t('panel.email.usage.older_than', 'Older than (days)')} required htmlFor="folder-days" help={t('panel.email.usage.at_least_days', 'At least {days} days.', { days: MIN_OLDER_THAN_DAYS })}><NumberInput id="folder-days" value={days} onChange={setDays} min={MIN_OLDER_THAN_DAYS} max={3650} step={1} nullable={false} /></Field>
            </>
          )}
        <MutationError error={problem} />
      </Modal>
    </Card>
  );
}

export function Messages({ hours }) {
  const { t } = useEmailT();
  const [filters, setFilters] = useState({ q: '', status: '', page: 1 });
  const { data, meta, error, loading, refetch } = usePanelApi(messagesQuery({ hours, ...filters }));
  const statusSelect = <Select aria-label={t('panel.email.common.status', 'Status')} value={filters.status} onChange={(v) => setFilters((f) => ({ ...f, status: v, page: 1 }))} options={statusOptions(t)} />;
  return (
    <Card title={t('panel.email.usage.messages', 'Messages')} subtitle={t('panel.email.usage.messages_subtitle', 'Every entry of the mail log for your domains and mailboxes in this window.')} padded={false}>
      {error && <div style={{ padding: 16 }}><PanelRequestError error={error} onRetry={refetch} /></div>}
      {!error && (
        <DataTable dense loading={loading && !data} searchable q={filters.q} onSearch={(q) => setFilters((f) => ({ ...f, q, page: 1 }))} searchPlaceholder={t('panel.email.usage.search_placeholder', 'Address, subject or message id…')} toolbar={statusSelect}
          total={meta?.total ?? null} page={filters.page} pageSize={PAGE_SIZE} onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
          columns={[
            { key: 'arrivedAt', label: t('panel.email.usage.time', 'Time'), render: (r) => <span className="muted">{formatDate(r.arrivedAt)}</span> },
            { key: 'sender', label: t('panel.email.usage.from', 'From'), render: (r) => <code>{r.sender || '<>'}</code> },
            { key: 'recipient', label: t('panel.email.usage.to', 'To'), render: (r) => <code>{r.recipient}</code> },
            { key: 'subject', label: t('panel.email.common.subject', 'Subject'), render: (r) => r.subject || <span className="muted">—</span> },
            { key: 'size', label: t('panel.email.usage.size', 'Size'), align: 'right', render: (r) => (r.size != null ? formatBytes(r.size) : '—') },
            { key: 'status', label: t('panel.email.common.status', 'Status'), render: (r) => <><DeliveryPill status={r.status} />{r.detail && <div className="muted" style={{ fontSize: 12 }}>{r.detail}</div>}</> },
          ]} rows={data || []} rowKey={(r) => r.key || r.id} emptyText={filters.q || filters.status ? t('panel.email.usage.messages_empty_filtered', 'No messages match these filters in this window.') : t('panel.email.usage.messages_empty', 'No messages in this window. Sent and received mail shows up here as the mail server logs it.')} />
      )}
    </Card>
  );
}

export default function MailUsage({ fn }) {
  const { t } = useEmailT();
  const [hours, setHours] = useState('24');
  const { data, error, loading, refetch } = usePanelApi(`/email/usage?sinceHours=${hours}`);
  const { data: mailboxes } = usePanelApi('/email/accounts?usage=false&pageSize=200');
  const windowSelect = <select className="input select" value={hours} onChange={(e) => setHours(e.target.value)} aria-label={t('panel.email.usage.time_window', 'Time window')}>{windowOptions(t).map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select>;
  return (
    <PanelPage fn={fn} actions={windowSelect}>
      {error && <Card><PanelRequestError error={error} fn={fn} onRetry={refetch} /></Card>}
      {loading && !data && !error && <Card><p className="muted">{t('panel.email.usage.reading_log', 'Reading the mail log…')}</p></Card>}
      {data && (
        <>
          <Totals totals={data.totals} storage={data.storage} />
          <LogNote log={data.log} hours={data.hours} />
          <div className="grid-2">
            <Card title={t('panel.email.usage.per_mailbox', 'Per mailbox')} subtitle={t('panel.email.usage.per_mailbox_subtitle', 'Messages sent from and received by each mailbox.')} padded={false}>
              <DataTable dense columns={[
                { key: 'address', label: t('panel.email.common.mailbox', 'Mailbox'), render: (r) => <code>{r.address}</code> },
                { key: 'sent', label: t('panel.email.usage.sent', 'Sent'), align: 'right' },
                { key: 'received', label: t('panel.email.usage.received', 'Received'), align: 'right' },
                { key: 'failed', label: t('panel.email.usage.status_failed', 'Failed'), align: 'right', render: (r) => (r.failed ? <span className="field-message" style={{ marginTop: 0 }}>{r.failed}</span> : 0) },
              ]} rows={data.mailboxes} rowKey={(r) => r.address} emptyText={t('panel.email.usage.per_mailbox_empty', 'No mailboxes yet. Create one under Email accounts and its traffic is counted here.')} />
            </Card>
            <Card title={t('panel.email.usage.per_domain', 'Per domain')} subtitle={t('panel.email.usage.per_domain_subtitle', 'Traffic the mail server saw for each of your domains.')} padded={false}>
              <DataTable dense columns={[
                { key: 'domain', label: t('panel.email.common.domain', 'Domain'), render: (r) => <code>{r.domain}</code> },
                { key: 'delivered', label: t('panel.email.usage.status_delivered', 'Delivered'), align: 'right', render: (r) => r.delivered ?? 0 },
                { key: 'deferred', label: t('panel.email.usage.status_deferred', 'Deferred'), align: 'right', render: (r) => r.deferred ?? 0 },
                { key: 'failed', label: t('panel.email.usage.status_failed', 'Failed'), align: 'right', render: (r) => (r.failed ? <span className="field-message" style={{ marginTop: 0 }}>{r.failed}</span> : 0) },
              ]} rows={data.byDomain || []} rowKey={(r) => r.domain} emptyText={t('panel.email.usage.per_domain_empty', 'Nothing was sent or received for your domains in this window.')} />
            </Card>
          </div>
          <Messages hours={hours} />
        </>
      )}
      {!error && <Folders mailboxes={Array.isArray(mailboxes) ? mailboxes : []} />}
      <p className="muted">{t('panel.email.usage.footer', 'Storage per mailbox is also shown under')} <Link to="/panel/email/accounts">{t('panel.email/accounts.label', 'Email accounts')}</Link>.</p>
    </PanelPage>
  );
}
