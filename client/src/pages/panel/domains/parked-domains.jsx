import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useDomains, useFeatureGate, isParked, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';

export function ParkedForm({ open, target, onClose, onCreated }) {
  const [form, setForm] = useState({ domain: '', createZone: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { onCreated(await panelApi.post('/domains/parked', { domain: form.domain.trim().toLowerCase(), createZone: form.createZone })); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Park a domain" onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="parked-form" variant="primary" loading={busy}>Park domain</Button></>}>
      <form id="parked-form" onSubmit={submit}>
        <RequestError error={error} />
        <p className="muted">A parked domain shows the same site as {target}. Visitors keep the address they typed.</p>
        <Field label="Domain" required help="A registered name whose nameservers point at this server" error={error?.fields?.domain}>
          <TextInput value={form.domain} onChange={set('domain')} placeholder="example.net" autoFocus spellCheck={false} />
        </Field>
        <Toggle checked={form.createZone} onChange={set('createZone')} label="Create a DNS zone" description="Standard records pointing at this server. Turn off when DNS is hosted elsewhere." />
      </form>
    </Modal>
  );
}

const webPill = (web) => (web === 'applied' || web === true ? { applied: true } : web === 'pending' || web === false ? { applied: false, reason: 'pending' } : web && typeof web === 'object' ? web : null);

export default function ParkedDomains({ fn }) {
  const toast = useToast();
  const { me } = usePanelMe();
  const { rows, counts, limits, error, loading, refetch } = useDomains();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [last, setLast] = useState(null);
  const disabled = useFeatureGate(fn, error);
  if (disabled) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const target = me?.account?.domain;
  const parked = rows.filter(isParked);
  const count = counts?.parked ?? parked.length;
  const limit = limits?.max_parked ?? null;
  const full = limitReached(count, limit);

  const onCreated = (res) => {
    setAdding(false);
    setLast(res.data);
    toast.success(`${res.data.domain} parked on ${res.data.target || target}`);
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    await panelApi.delete(`/domains/parked/${encodeURIComponent(d)}?removeZone=${choice.removeZone}`);
    setRemoving(null);
    toast.success(`${d} is no longer parked`);
    refetch();
  };

  const columns = [
    { key: 'domain', label: 'Parked domain', render: (r) => <strong>{r.domain}</strong> },
    { key: 'target', label: 'Shows', render: () => target },
    { key: 'vhost', label: 'Web server', render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: 'SSL', render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: 'Added', render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full}>Park a domain</Button>}>
      <LimitNotice count={count} limit={limit} noun="parked domains" />
      {last && (
        <CreateResult title={`${last.domain} is parked`} onDismiss={() => setLast(null)} items={[
          ['Shows', last.target || target],
          ['DNS zone', last.zone ? <AppliedPill key="z" result={last.zone} okLabel="Created" /> : 'Not created'],
          ['Web server', <AppliedPill key="w" result={webPill(last.web)} okLabel="Alias added" />],
          last.webDetail && ['Detail', String(last.webDetail)],
        ]} />
      )}
      <Card title="Parked domains" subtitle={usageText(count, limit, 'parked domains')} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={parked} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={`No parked domains yet. Park one to show ${target || 'your main site'} under another name, for example a .net or a misspelling you own.`}
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <ParkedForm open target={target} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={`Stop parking ${removing.domain}?`} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeZone', label: 'Delete its DNS zone', description: 'The records of this domain on this server are removed.', default: true },
        ]} />
      )}
    </PanelPage>
  );
}
