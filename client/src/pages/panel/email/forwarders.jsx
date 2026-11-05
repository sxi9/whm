import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ArrowRight } from 'lucide-react';
import { queryString } from '../../../api/client.js';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, AddressInput, useAccountDomains, fieldError, isFeatureDisabled, useEmailT, tr } from './parts/Shared.jsx';

const KINDS = [
  { value: 'forward', key: 'forward', label: 'Forward to another address', description: 'A copy of every message is delivered to the address below.' },
  { value: ':fail:', key: 'fail', label: 'Reject with an error', description: 'The sender receives a bounce saying the address does not exist.' },
  { value: ':blackhole:', key: 'blackhole', label: 'Discard silently', description: 'Messages are dropped; the sender is not told.' },
];

const kindOptions = (t) => KINDS.map((k) => ({ value: k.value, label: t(`panel.email.forwarders.kind_${k.key}`, k.label), description: t(`panel.email.forwarders.kind_${k.key}_help`, k.description) }));

export function destinationText(d) {
  if (d === ':fail:') return tr('panel.email.forwarders.dest_fail', 'Rejected with an error');
  if (d === ':blackhole:') return tr('panel.email.forwarders.dest_blackhole', 'Discarded silently');
  return d;
}

// "forwarded to x" / "rejected with an error" for toasts and confirmations.
const effectText = (destination) => (destination.startsWith(':') ? destinationText(destination).toLowerCase() : tr('panel.email.forwarders.effect_forwarded', 'forwarded to {destination}', { destination }));

export function ForwarderForm({ domains, onSubmit, onCancel, busy, error }) {
  const { t } = useEmailT();
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] || '');
  const [kind, setKind] = useState('forward');
  const [destination, setDestination] = useState('');
  const submit = (e) => { e.preventDefault(); onSubmit({ domain, localPart: localPart.trim(), destination: kind === 'forward' ? destination.trim().toLowerCase() : kind }); };
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      <AddressInput localPart={localPart} domain={domain} domains={domains} onLocalPart={setLocalPart} onDomain={setDomain} error={fieldError(error, 'localPart') || fieldError(error, 'domain')} help={t('panel.email.forwarders.address_help', 'The address that receives the mail. It does not need a mailbox.')} autoFocus />
      <Field label={t('panel.email.forwarders.what_happens', 'What happens to the mail')}>
        <RadioGroup name="kind" value={kind} onChange={setKind} options={kindOptions(t)} />
      </Field>
      {kind === 'forward' && (
        <Field label={t('panel.email.forwarders.forward_to', 'Forward to')} required error={fieldError(error, 'destination')} help={t('panel.email.forwarders.forward_to_help', 'Any email address, at your domains or elsewhere.')}>
          <TextInput value={destination} onChange={setDestination} type="email" placeholder="someone@example.com" autoCapitalize="none" />
        </Field>
      )}
      <FormActions align="right">
        <Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!localPart.trim() || !domain || (kind === 'forward' && !destination.trim())}>{t('panel.email.forwarders.add', 'Add forwarder')}</Button>
      </FormActions>
    </form>
  );
}

export function DomainForwardForm({ domain, current, onSubmit, onCancel, busy, error }) {
  const { t } = useEmailT();
  const [target, setTarget] = useState(current || '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ targetDomain: target.trim().toLowerCase() }); }}>
      <MutationError error={error} />
      <p>{t('panel.email.forwarders.domain_intro_1', 'Every address at')} <strong>{domain}</strong> {t('panel.email.forwarders.domain_intro_2', 'is forwarded to the same local part at the target domain, so')} <code>name@{domain}</code> {t('panel.email.forwarders.domain_intro_3', 'reaches')} <code>name@{target.trim() || 'target'}</code>.</p>
      <Field label={t('panel.email.forwarders.target_domain', 'Target domain')} required error={fieldError(error, 'targetDomain')}>
        <TextInput value={target} onChange={setTarget} placeholder="example.org" autoCapitalize="none" autoFocus />
      </Field>
      <FormActions align="right"><Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button><Button type="submit" variant="primary" loading={busy} disabled={!target.trim()}>{t('panel.email.common.save', 'Save')}</Button></FormActions>
    </form>
  );
}

// One row per domain: GET/PUT/DELETE /email/domains/:domain/forward.
export function DomainForwardRow({ domain, onEdit, onRemove, pending }) {
  const { t } = useEmailT();
  const { data, error, loading, refetch } = usePanelApi(`/email/domains/${domain}/forward`);
  return (
    <tr>
      <td><code>{domain}</code></td>
      <td>
        {error && <span className="field-message">{error.message}</span>}
        {!error && loading && !data && <span className="muted">{t('panel.email.common.loading', 'Loading…')}</span>}
        {data && (data.configured ? <span><ArrowRight size={14} style={{ verticalAlign: 'middle' }} /> <code>{data.targetDomain}</code> {pending && <PendingPill result={pending} />}</span> : <span className="muted">{t('panel.email.forwarders.not_forwarding', 'Not forwarding')}</span>)}
      </td>
      <td className="muted">{data?.updatedAt ? formatDate(data.updatedAt) : '—'}</td>
      <td className="actions-col">
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => onEdit(domain, data?.targetDomain || '', refetch)}>{data?.configured ? t('panel.email.common.change', 'Change') : t('panel.email.forwarders.forward_domain', 'Forward domain')}</button>
          {data?.configured && <button className="btn btn-sm btn-danger-ghost" onClick={() => onRemove(domain, refetch)}>{t('panel.email.forwarders.stop', 'Stop')}</button>}
        </div>
      </td>
    </tr>
  );
}

export default function Forwarders({ fn }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const { data, meta, error, loading, refetch } = usePanelApi(`/email/forwarders${queryString({ q, domain: domainFilter })}`);
  const domains = useAccountDomains(meta?.domains);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [domainPending, setDomainPending] = useState({});

  const close = () => { setDialog(null); setMutationError(null); };

  const create = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      await panelApi.post('/email/forwarders', body);
      toast.success(t('panel.email.forwarders.toast_created', '{address} now {effect}', { address: `${body.localPart}@${body.domain}`, effect: body.destination.startsWith(':') ? effectText(body.destination) : t('panel.email.forwarders.effect_forwards', 'forwards to {destination}', { destination: body.destination }) }));
      close(); refetch();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    if (!(await confirm({ title: t('panel.email.forwarders.delete_title', 'Delete the forwarder for {address}?', { address: row.address }), message: t('panel.email.forwarders.delete_text', "Mail for {address} is no longer {effect}. If no mailbox exists, the domain's default address applies.", { address: row.address, effect: effectText(row.destination) }), confirmLabel: t('panel.email.common.delete', 'Delete'), danger: true }))) return;
    try { await panelApi.delete(`/email/forwarders/${row.id}`); toast.success(t('panel.email.forwarders.toast_deleted', 'Forwarder deleted')); refetch(); } catch (err) { toast.error(err); }
  };

  const saveDomainForward = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await panelApi.put(`/email/domains/${dialog.domain}/forward`, body);
      if (res?.data?.applied === false) setDomainPending((p) => ({ ...p, [dialog.domain]: res.data }));
      toast.success(t('panel.email.forwarders.toast_domain_saved', '{domain} forwards to {target}', { domain: dialog.domain, target: body.targetDomain }));
      dialog.refetch?.(); close();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const removeDomainForward = async (domain, reload) => {
    if (!(await confirm({ title: t('panel.email.forwarders.stop_title', 'Stop forwarding {domain}?', { domain }), message: t('panel.email.forwarders.stop_text', 'Addresses at this domain are delivered to their own mailboxes and forwarders again.'), confirmLabel: t('panel.email.forwarders.stop_forwarding', 'Stop forwarding'), danger: true }))) return;
    try { await panelApi.delete(`/email/domains/${domain}/forward`); toast.success(t('panel.email.forwarders.toast_domain_stopped', '{domain} no longer forwards', { domain })); reload?.(); } catch (err) { toast.error(err); }
  };

  const max = meta?.maxPerDomain;
  const featureOff = isFeatureDisabled(error);

  return (
    <PanelPage fn={fn} actions={!featureOff && <Button variant="primary" icon={Plus} onClick={() => { setMutationError(null); setDialog({ kind: 'create' }); }} disabled={!domains.length}>{t('panel.email.forwarders.add', 'Add forwarder')}</Button>}>
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          <Card title={t('panel.email.forwarders.title', 'Email forwarders')} subtitle={`${t('panel.email.forwarders.subtitle', 'Send a copy of mail for one address somewhere else')}${max ? ` · ${t('panel.email.forwarders.max_per_domain', 'up to {max} per domain', { max })}` : ''}.`} padded={false}>
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {!error && (
              <DataTable
                columns={[
                  { key: 'address', label: t('panel.email.common.address', 'Address'), render: (r) => <code>{r.address}</code> },
                  { key: 'destination', label: t('panel.email.forwarders.delivered_to', 'Delivered to'), render: (r) => r.destination.startsWith(':') ? <StatusPill status={r.destination === ':fail:' ? 'warning' : 'disabled'}>{destinationText(r.destination)}</StatusPill> : <code>{r.destination}</code> },
                  { key: 'createdAt', label: t('panel.email.common.created', 'Created'), render: (r) => <span className="muted">{formatDate(r.createdAt)}</span> },
                ]}
                rows={data || []} loading={loading} dense
                searchable q={q} onSearch={setQ} searchPlaceholder={t('panel.email.common.search_addresses', 'Search addresses')}
                toolbar={domains.length > 1 && <select className="input select" value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} aria-label={t('panel.email.common.filter_by_domain', 'Filter by domain')}><option value="">{t('panel.email.common.all_domains', 'All domains')}</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
                emptyText={q || domainFilter ? t('panel.email.forwarders.empty_filtered', 'No forwarders match this filter.') : t('panel.email.forwarders.empty', 'No forwarders yet. Add one to send mail for an address at your domain on to another inbox; it appears here with its destination.')}
                rowActions={(r) => [{ label: t('panel.email.common.delete', 'Delete'), danger: true, primary: true, onClick: () => remove(r) }]}
              />
            )}
          </Card>
          <Card title={t('panel.email.forwarders.domain_title', 'Domain forwarders')} subtitle={t('panel.email.forwarders.domain_subtitle', 'Forward every address at one of your domains to the same address at another domain.')} padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('panel.email.common.domain', 'Domain')}</th><th>{t('panel.email.forwarders.forwards_to', 'Forwards to')}</th><th>{t('panel.email.common.updated', 'Updated')}</th><th className="actions-col" /></tr></thead>
                <tbody>
                  {domains.map((d) => <DomainForwardRow key={d} domain={d} pending={domainPending[d]} onEdit={(domain, current, reload) => { setMutationError(null); setDialog({ kind: 'domain', domain, current, refetch: reload }); }} onRemove={removeDomainForward} />)}
                  {!domains.length && <tr><td colSpan={4} className="table-state">{t('panel.email.common.no_domains', 'No domains on this account yet.')}</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="muted">{t('panel.email.forwarders.footer', 'Mail for addresses that have neither a mailbox nor a forwarder follows the')} <Link to="/panel/email/default-address">{t('panel.email.forwarders.footer_link', 'default address')}</Link> {t('panel.email.forwarders.footer_end', 'of the domain.')}</p>
        </>
      )}
      <Modal open={dialog?.kind === 'create'} title={t('panel.email.forwarders.add', 'Add forwarder')} onClose={close}>
        {dialog?.kind === 'create' && <ForwarderForm domains={domains} onSubmit={create} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'domain'} title={dialog?.kind === 'domain' ? t('panel.email.forwarders.forward_title', 'Forward {domain}', { domain: dialog.domain }) : ''} onClose={close} size="sm">
        {dialog?.kind === 'domain' && <DomainForwardForm domain={dialog.domain} current={dialog.current} onSubmit={saveDomainForward} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
    </PanelPage>
  );
}
