import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useDomains, useFeatureGate, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, DocrootCode, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';

export function AddonForm({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ domain: '', docroot: '', createZone: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { domain: form.domain.trim().toLowerCase(), createZone: form.createZone };
    if (form.docroot.trim()) body.docroot = form.docroot.trim();
    try { onCreated(await panelApi.post('/domains/addon', body)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Add an addon domain" onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="addon-form" variant="primary" loading={busy}>Add domain</Button></>}>
      <form id="addon-form" onSubmit={submit}>
        <RequestError error={error} />
        <Field label="Domain" required help="A registered name whose nameservers point at this server, e.g. example.org" error={error?.fields?.domain}>
          <TextInput value={form.domain} onChange={set('domain')} placeholder="example.org" autoFocus spellCheck={false} />
        </Field>
        <Field label="Document root" help={`Folder under public_html; blank uses public_html/${form.domain.trim().toLowerCase() || '<domain>'}`} error={error?.fields?.docroot}>
          <TextInput value={form.docroot} onChange={set('docroot')} placeholder={form.domain.trim().toLowerCase() || 'example.org'} spellCheck={false} />
        </Field>
        <Toggle checked={form.createZone} onChange={set('createZone')} label="Create a DNS zone" description="Standard A, MX and SPF records for the new domain. Turn off when DNS is hosted elsewhere." />
      </form>
    </Modal>
  );
}

export default function AddonDomains({ fn }) {
  const toast = useToast();
  const { me } = usePanelMe();
  const { rows, counts, limits, error, loading, refetch } = useDomains();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [last, setLast] = useState(null);
  const disabled = useFeatureGate(fn, error);
  if (disabled) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const homeDir = me?.account?.homeDir;
  const addons = rows.filter((r) => r.type === 'addon');
  const count = counts?.addon ?? addons.length;
  const limit = limits?.max_addons ?? null;
  const full = limitReached(count, limit);

  const onCreated = (res) => {
    setAdding(false);
    setLast({ data: res.data, warnings: res.meta?.warnings || [] });
    toast.success(`${res.data.domain} added`);
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    const res = await panelApi.delete(`/domains/addon/${encodeURIComponent(d)}?removeZone=${choice.removeZone}&removeDocroot=${choice.removeDocroot}`);
    setRemoving(null);
    toast.success(`${d} removed`);
    if (res.meta?.warnings?.length) toast.warning(res.meta.warnings.join(' '));
    refetch();
  };

  const columns = [
    { key: 'domain', label: 'Domain', render: (r) => <strong>{r.domain}</strong> },
    { key: 'docroot', label: 'Document root', render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: 'Web server', render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: 'SSL', render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: 'Added', render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full}>Add addon domain</Button>}>
      <LimitNotice count={count} limit={limit} noun="addon domains" />
      {last && (
        <CreateResult title={`${last.data.domain} is set up`} warnings={last.warnings} onDismiss={() => setLast(null)} items={[
          ['Document root', <DocrootCode key="d" docroot={last.data.docroot} homeDir={homeDir} />],
          ['DNS zone', last.data.zone ? <AppliedPill key="z" result={last.data.zone} okLabel={last.data.zone.created ? 'Created' : 'Already present'} /> : 'Not created'],
          ['Web server', <AppliedPill key="w" result={last.data.web} okLabel="Configured" />],
          ['Mail routing', <AppliedPill key="m" result={last.data.mail} okLabel="Local" />],
        ]} />
      )}
      <Card title="Addon domains" subtitle={usageText(count, limit, 'addon domains')} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={addons} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText="No addon domains yet. Add one to host another website on this account; it gets its own folder under public_html."
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <AddonForm open onClose={() => setAdding(false)} onCreated={onCreated} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={`Remove ${removing.domain}?`} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeZone', label: 'Delete its DNS zone', description: 'The records of this domain on this server are removed.', default: true },
          { key: 'removeDocroot', label: 'Delete the document root', description: `Removes ${removing.docroot} and every file in it. This cannot be undone.`, default: false },
        ]} />
      )}
    </PanelPage>
  );
}
