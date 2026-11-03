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
import { PanelRequestError, MutationError, AddressInput, useAccountDomains, fieldError, isFeatureDisabled } from './parts/Shared.jsx';

const KINDS = [
  { value: 'forward', label: 'Forward to another address', description: 'A copy of every message is delivered to the address below.' },
  { value: ':fail:', label: 'Reject with an error', description: 'The sender receives a bounce saying the address does not exist.' },
  { value: ':blackhole:', label: 'Discard silently', description: 'Messages are dropped; the sender is not told.' },
];

export function destinationText(d) {
  if (d === ':fail:') return 'Rejected with an error';
  if (d === ':blackhole:') return 'Discarded silently';
  return d;
}

export function ForwarderForm({ domains, onSubmit, onCancel, busy, error }) {
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] || '');
  const [kind, setKind] = useState('forward');
  const [destination, setDestination] = useState('');
  const submit = (e) => { e.preventDefault(); onSubmit({ domain, localPart: localPart.trim(), destination: kind === 'forward' ? destination.trim().toLowerCase() : kind }); };
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      <AddressInput localPart={localPart} domain={domain} domains={domains} onLocalPart={setLocalPart} onDomain={setDomain} error={fieldError(error, 'localPart') || fieldError(error, 'domain')} help="The address that receives the mail. It does not need a mailbox." autoFocus />
      <Field label="What happens to the mail">
        <RadioGroup name="kind" value={kind} onChange={setKind} options={KINDS} />
      </Field>
      {kind === 'forward' && (
        <Field label="Forward to" required error={fieldError(error, 'destination')} help="Any email address, at your domains or elsewhere.">
          <TextInput value={destination} onChange={setDestination} type="email" placeholder="someone@example.com" autoCapitalize="none" />
        </Field>
      )}
      <FormActions align="right">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!localPart.trim() || !domain || (kind === 'forward' && !destination.trim())}>Add forwarder</Button>
      </FormActions>
    </form>
  );
}

export function DomainForwardForm({ domain, current, onSubmit, onCancel, busy, error }) {
  const [target, setTarget] = useState(current || '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ targetDomain: target.trim().toLowerCase() }); }}>
      <MutationError error={error} />
      <p>Every address at <strong>{domain}</strong> is forwarded to the same local part at the target domain, so <code>name@{domain}</code> reaches <code>name@{target.trim() || 'target'}</code>.</p>
      <Field label="Target domain" required error={fieldError(error, 'targetDomain')}>
        <TextInput value={target} onChange={setTarget} placeholder="example.org" autoCapitalize="none" autoFocus />
      </Field>
      <FormActions align="right"><Button onClick={onCancel}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!target.trim()}>Save</Button></FormActions>
    </form>
  );
}

// One row per domain: GET/PUT/DELETE /email/domains/:domain/forward.
export function DomainForwardRow({ domain, onEdit, onRemove, pending }) {
  const { data, error, loading, refetch } = usePanelApi(`/email/domains/${domain}/forward`);
  return (
    <tr>
      <td><code>{domain}</code></td>
      <td>
        {error && <span className="field-message">{error.message}</span>}
        {!error && loading && !data && <span className="muted">Loading…</span>}
        {data && (data.configured ? <span><ArrowRight size={14} style={{ verticalAlign: 'middle' }} /> <code>{data.targetDomain}</code> {pending && <PendingPill result={pending} />}</span> : <span className="muted">Not forwarding</span>)}
      </td>
      <td className="muted">{data?.updatedAt ? formatDate(data.updatedAt) : '—'}</td>
      <td className="actions-col">
        <div className="row-actions">
          <button className="btn btn-sm" onClick={() => onEdit(domain, data?.targetDomain || '', refetch)}>{data?.configured ? 'Change' : 'Forward domain'}</button>
          {data?.configured && <button className="btn btn-sm btn-danger-ghost" onClick={() => onRemove(domain, refetch)}>Stop</button>}
        </div>
      </td>
    </tr>
  );
}

export default function Forwarders({ fn }) {
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
      toast.success(`${body.localPart}@${body.domain} now ${body.destination.startsWith(':') ? destinationText(body.destination).toLowerCase() : `forwards to ${body.destination}`}`);
      close(); refetch();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    if (!(await confirm({ title: `Delete the forwarder for ${row.address}?`, message: `Mail for ${row.address} is no longer ${row.destination.startsWith(':') ? destinationText(row.destination).toLowerCase() : `forwarded to ${row.destination}`}. If no mailbox exists, the domain's default address applies.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await panelApi.delete(`/email/forwarders/${row.id}`); toast.success('Forwarder deleted'); refetch(); } catch (err) { toast.error(err); }
  };

  const saveDomainForward = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await panelApi.put(`/email/domains/${dialog.domain}/forward`, body);
      if (res?.data?.applied === false) setDomainPending((p) => ({ ...p, [dialog.domain]: res.data }));
      toast.success(`${dialog.domain} forwards to ${body.targetDomain}`);
      dialog.refetch?.(); close();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const removeDomainForward = async (domain, reload) => {
    if (!(await confirm({ title: `Stop forwarding ${domain}?`, message: 'Addresses at this domain are delivered to their own mailboxes and forwarders again.', confirmLabel: 'Stop forwarding', danger: true }))) return;
    try { await panelApi.delete(`/email/domains/${domain}/forward`); toast.success(`${domain} no longer forwards`); reload?.(); } catch (err) { toast.error(err); }
  };

  const max = meta?.maxPerDomain;
  const featureOff = isFeatureDisabled(error);

  return (
    <PanelPage fn={fn} actions={!featureOff && <Button variant="primary" icon={Plus} onClick={() => { setMutationError(null); setDialog({ kind: 'create' }); }} disabled={!domains.length}>Add forwarder</Button>}>
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          <Card title="Email forwarders" subtitle={`Send a copy of mail for one address somewhere else${max ? ` · up to ${max} per domain` : ''}.`} padded={false}>
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {!error && (
              <DataTable
                columns={[
                  { key: 'address', label: 'Address', render: (r) => <code>{r.address}</code> },
                  { key: 'destination', label: 'Delivered to', render: (r) => r.destination.startsWith(':') ? <StatusPill status={r.destination === ':fail:' ? 'warning' : 'disabled'}>{destinationText(r.destination)}</StatusPill> : <code>{r.destination}</code> },
                  { key: 'createdAt', label: 'Created', render: (r) => <span className="muted">{formatDate(r.createdAt)}</span> },
                ]}
                rows={data || []} loading={loading} dense
                searchable q={q} onSearch={setQ} searchPlaceholder="Search addresses"
                toolbar={domains.length > 1 && <select className="input select" value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} aria-label="Filter by domain"><option value="">All domains</option>{domains.map((d) => <option key={d} value={d}>{d}</option>)}</select>}
                emptyText={q || domainFilter ? 'No forwarders match this filter.' : 'No forwarders yet. Add one to send mail for an address at your domain on to another inbox; it appears here with its destination.'}
                rowActions={(r) => [{ label: 'Delete', danger: true, primary: true, onClick: () => remove(r) }]}
              />
            )}
          </Card>
          <Card title="Domain forwarders" subtitle="Forward every address at one of your domains to the same address at another domain." padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Domain</th><th>Forwards to</th><th>Updated</th><th className="actions-col" /></tr></thead>
                <tbody>
                  {domains.map((d) => <DomainForwardRow key={d} domain={d} pending={domainPending[d]} onEdit={(domain, current, reload) => { setMutationError(null); setDialog({ kind: 'domain', domain, current, refetch: reload }); }} onRemove={removeDomainForward} />)}
                  {!domains.length && <tr><td colSpan={4} className="table-state">No domains on this account yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="muted">Mail for addresses that have neither a mailbox nor a forwarder follows the <Link to="/panel/email/default-address">default address</Link> of the domain.</p>
        </>
      )}
      <Modal open={dialog?.kind === 'create'} title="Add forwarder" onClose={close}>
        {dialog?.kind === 'create' && <ForwarderForm domains={domains} onSubmit={create} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
      <Modal open={dialog?.kind === 'domain'} title={dialog?.kind === 'domain' ? `Forward ${dialog.domain}` : ''} onClose={close} size="sm">
        {dialog?.kind === 'domain' && <DomainForwardForm domain={dialog.domain} current={dialog.current} onSubmit={saveDomainForward} onCancel={close} busy={busy} error={mutationError} />}
      </Modal>
    </PanelPage>
  );
}
