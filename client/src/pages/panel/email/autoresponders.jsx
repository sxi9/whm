import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, NumberInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, AddressInput, useAccountDomains, fieldError, isFeatureDisabled, toLocalInput, fromLocalInput, useEmailT, tr } from './parts/Shared.jsx';

// What the responder is doing right now, from its switch and its schedule.
export function responderState(r, now = Date.now()) {
  if (!r.enabled) return { status: 'stopped', label: tr('panel.email.autoresponders.state_stopped', 'Stopped') };
  const start = r.startAt ? new Date(r.startAt).getTime() : null;
  const stop = r.stopAt ? new Date(r.stopAt).getTime() : null;
  if (start && start > now) return { status: 'scheduled', label: tr('panel.email.autoresponders.state_starts', 'Starts {date}', { date: formatDate(r.startAt) }) };
  if (stop && stop <= now) return { status: 'ended', label: tr('panel.email.autoresponders.state_ended', 'Ended {date}', { date: formatDate(r.stopAt) }) };
  return { status: 'active', label: stop ? tr('panel.email.autoresponders.state_active_until', 'Active until {date}', { date: formatDate(r.stopAt) }) : tr('panel.email.autoresponders.state_active', 'Active') };
}

const TONE = { active: 'ok', scheduled: 'pending', ended: 'disabled', stopped: 'warning' };

export function intervalText(hours) {
  if (hours === 0) return tr('panel.email.autoresponders.interval_every', 'Every message');
  if (hours === 24) return tr('panel.email.autoresponders.interval_daily', 'Once a day per sender');
  if (hours % 24 === 0) return tr('panel.email.autoresponders.interval_days', 'Once every {days} days per sender', { days: hours / 24 });
  return tr('panel.email.autoresponders.interval_hours', 'Once every {hours} h per sender', { hours });
}

export function AutoresponderForm({ domains, existing, onSubmit, onCancel, busy, error }) {
  const { t } = useEmailT();
  const [localPart, setLocalPart] = useState(existing?.localPart || '');
  const [domain, setDomain] = useState(existing?.domain || domains[0] || '');
  const [fromName, setFromName] = useState(existing?.fromName || '');
  const [subject, setSubject] = useState(existing?.subject || '');
  const [body, setBody] = useState(existing?.body || '');
  const [intervalHours, setIntervalHours] = useState(existing?.intervalHours ?? 24);
  const [startAt, setStartAt] = useState(toLocalInput(existing?.startAt));
  const [stopAt, setStopAt] = useState(toLocalInput(existing?.stopAt));
  const [enabled, setEnabled] = useState(existing ? existing.enabled : true);
  const submit = (e) => {
    e.preventDefault();
    const patch = { fromName: fromName.trim(), subject: subject.trim(), body, intervalHours: intervalHours ?? 24, startAt: fromLocalInput(startAt), stopAt: fromLocalInput(stopAt), enabled };
    onSubmit(existing ? patch : { address: `${localPart.trim()}@${domain}`, ...patch });
  };
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      {existing
        ? <Field label={t('panel.email.common.address', 'Address')}><TextInput value={existing.address} onChange={() => {}} readOnly aria-label={t('panel.email.common.address', 'Address')} /></Field>
        : <AddressInput localPart={localPart} domain={domain} domains={domains} onLocalPart={setLocalPart} onDomain={setDomain} error={fieldError(error, 'address')} help={t('panel.email.autoresponders.address_help', 'The address that answers. It does not need a mailbox.')} autoFocus />}
      <div className="form-grid">
        <Field label={t('panel.email.autoresponders.from_name', 'From name')} error={fieldError(error, 'fromName')} help={t('panel.email.autoresponders.from_name_help', 'Shown as the sender of the reply.')}>
          <TextInput value={fromName} onChange={setFromName} placeholder={t('panel.email.autoresponders.from_name_placeholder', 'Jane at Example')} maxLength={128} />
        </Field>
        <Field label={t('panel.email.common.subject', 'Subject')} required error={fieldError(error, 'subject')}>
          <TextInput value={subject} onChange={setSubject} placeholder={t('panel.email.autoresponders.subject_placeholder', 'Out of office')} maxLength={255} />
        </Field>
      </div>
      <Field label={t('panel.email.autoresponders.message', 'Message')} required error={fieldError(error, 'body')}>
        <Textarea value={body} onChange={setBody} rows={6} placeholder={t('panel.email.autoresponders.message_placeholder', 'Thank you for your message. I am away until…')} />
      </Field>
      <div className="form-grid">
        <Field label={t('panel.email.autoresponders.reply_at_most', 'Reply at most')} error={fieldError(error, 'intervalHours')} help={intervalText(intervalHours ?? 24)}>
          <div className="input-group">
            <NumberInput value={intervalHours} onChange={(v) => setIntervalHours(v == null ? 24 : Math.max(0, Math.min(720, Math.floor(v))))} nullable={false} min={0} max={720} aria-label={t('panel.email.autoresponders.hours_between', 'Hours between replies to the same sender')} />
            <span className="muted" style={{ alignSelf: 'center' }}>{t('panel.email.autoresponders.hours_apart', 'hours apart')}</span>
          </div>
        </Field>
      </div>
      <div className="form-grid">
        <Field label={t('panel.email.autoresponders.start', 'Start')} error={fieldError(error, 'startAt')} help={t('panel.email.autoresponders.start_help', 'Leave empty to start right away.')}>
          <TextInput type="datetime-local" value={startAt} onChange={setStartAt} aria-label={t('panel.email.autoresponders.start', 'Start')} />
        </Field>
        <Field label={t('panel.email.autoresponders.stop', 'Stop')} error={fieldError(error, 'stopAt')} help={t('panel.email.autoresponders.stop_help', 'Leave empty to keep replying until you stop it.')}>
          <TextInput type="datetime-local" value={stopAt} onChange={setStopAt} aria-label={t('panel.email.autoresponders.stop', 'Stop')} />
        </Field>
      </div>
      <Toggle checked={enabled} onChange={setEnabled} label={t('panel.email.common.enabled', 'Enabled')} description={t('panel.email.autoresponders.enabled_help', 'Switch off to keep the text without sending replies.')} />
      <FormActions align="right">
        <Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={(!existing && (!localPart.trim() || !domain)) || !subject.trim() || !body.trim()}>{existing ? t('panel.email.common.save_changes', 'Save changes') : t('panel.email.autoresponders.create', 'Create autoresponder')}</Button>
      </FormActions>
    </form>
  );
}

export default function Autoresponders({ fn }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, meta, error, loading, refetch } = usePanelApi('/email/autoresponders');
  const domains = useAccountDomains(meta?.domains);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState({});
  const close = () => { setDialog(null); setMutationError(null); };

  const note = (res, id) => { if (res?.data?.applied === false) setPending((p) => ({ ...p, [id ?? res.data.id]: res.data })); };

  const save = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      const res = dialog.row ? await panelApi.put(`/email/autoresponders/${dialog.row.id}`, body) : await panelApi.post('/email/autoresponders', body);
      note(res, dialog.row?.id);
      toast.success(dialog.row ? t('panel.email.autoresponders.toast_saved', 'Autoresponder for {address} saved', { address: dialog.row.address }) : t('panel.email.autoresponders.toast_created', 'Autoresponder for {address} created', { address: body.address }));
      close(); refetch();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const toggle = async (row) => {
    try {
      const res = await panelApi.put(`/email/autoresponders/${row.id}`, { enabled: !row.enabled });
      note(res, row.id);
      toast.success(row.enabled ? t('panel.email.autoresponders.toast_stopped', '{address} stopped', { address: row.address }) : t('panel.email.autoresponders.toast_started', '{address} started', { address: row.address }));
      refetch();
    } catch (err) { toast.error(err); }
  };

  const remove = async (row) => {
    if (!(await confirm({ title: t('panel.email.autoresponders.delete_title', 'Delete the autoresponder for {address}?', { address: row.address }), message: t('panel.email.autoresponders.delete_text', 'The reply text is removed and no further automatic replies are sent.'), confirmLabel: t('panel.email.common.delete', 'Delete'), danger: true }))) return;
    try { await panelApi.delete(`/email/autoresponders/${row.id}`); toast.success(t('panel.email.autoresponders.toast_deleted', 'Autoresponder deleted')); refetch(); } catch (err) { toast.error(err); }
  };

  const featureOff = isFeatureDisabled(error);
  return (
    <PanelPage fn={fn} actions={!featureOff && <Button variant="primary" icon={Plus} onClick={() => { setMutationError(null); setDialog({ row: null }); }} disabled={!domains.length}>{t('panel.email.autoresponders.create', 'Create autoresponder')}</Button>}>
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <Card padded={false}>
          <PanelRequestError error={error} fn={fn} onRetry={refetch} />
          {!error && (
            <DataTable
              columns={[
                { key: 'address', label: t('panel.email.common.address', 'Address'), render: (r) => <><code>{r.address}</code>{pending[r.id] && <> <PendingPill result={pending[r.id]} /></>}</> },
                { key: 'subject', label: t('panel.email.common.subject', 'Subject'), render: (r) => <><div>{r.subject}</div>{r.fromName && <div className="muted">{t('panel.email.autoresponders.from', 'from')} {r.fromName}</div>}</> },
                { key: 'intervalHours', label: t('panel.email.autoresponders.frequency', 'Frequency'), render: (r) => intervalText(r.intervalHours) },
                { key: 'schedule', label: t('panel.email.autoresponders.schedule', 'Schedule'), render: (r) => (r.startAt || r.stopAt ? <span className="muted">{r.startAt ? formatDate(r.startAt) : t('panel.email.autoresponders.now', 'now')} → {r.stopAt ? formatDate(r.stopAt) : t('panel.email.autoresponders.until_stopped', 'until stopped')}</span> : <span className="muted">{t('panel.email.autoresponders.always', 'Always')}</span>) },
                { key: 'state', label: t('panel.email.common.status', 'Status'), render: (r) => { const s = responderState(r); return <StatusPill status={TONE[s.status]}>{s.label}</StatusPill>; } },
              ]}
              rows={data || []} loading={loading}
              emptyText={t('panel.email.autoresponders.empty', 'No autoresponders yet. Create one to answer every message to an address automatically, for example while you are away; it appears here with its schedule.')}
              rowActions={(r) => [
                { label: t('panel.email.common.edit', 'Edit'), primary: true, onClick: () => { setMutationError(null); setDialog({ row: r }); } },
                { label: r.enabled ? t('panel.email.autoresponders.stop', 'Stop') : t('panel.email.autoresponders.start', 'Start'), onClick: () => toggle(r) },
                { label: t('panel.email.common.delete', 'Delete'), danger: true, onClick: () => remove(r) },
              ]}
            />
          )}
        </Card>
      )}
      <Modal open={Boolean(dialog)} title={dialog?.row ? t('panel.email.autoresponders.edit_title', 'Edit autoresponder for {address}', { address: dialog.row.address }) : t('panel.email.autoresponders.create', 'Create autoresponder')} onClose={close} size="lg">
        {dialog && <AutoresponderForm domains={domains} existing={dialog.row} onSubmit={save} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
    </PanelPage>
  );
}
