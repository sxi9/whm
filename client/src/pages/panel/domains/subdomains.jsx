import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useDomains, useFeatureGate, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, DocrootCode, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function SubdomainForm({ open, parents, onClose, onCreated }) {
  const [form, setForm] = useState({ label: '', parent: parents[0] || '', docroot: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const label = form.label.trim().toLowerCase();
  const submit = async (e) => {
    e.preventDefault();
    if (!LABEL_RE.test(label)) { setError({ message: 'Check the subdomain name', fields: { label: ['Letters, digits and "-", up to 63 characters, not starting or ending with "-"'] } }); return; }
    setBusy(true);
    setError(null);
    const body = { label, parent: form.parent };
    if (form.docroot.trim()) body.docroot = form.docroot.trim();
    try { onCreated(await panelApi.post('/domains/sub', body)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Add a subdomain" onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="sub-form" variant="primary" loading={busy}>Add subdomain</Button></>}>
      <form id="sub-form" onSubmit={submit}>
        <RequestError error={error} />
        <div className="form-grid">
          <Field label="Name" required help={label ? `Becomes ${label}.${form.parent}` : 'The part before the domain, e.g. shop'} error={error?.fields?.label}>
            <TextInput value={form.label} onChange={set('label')} placeholder="shop" autoFocus spellCheck={false} />
          </Field>
          <Field label="Under" required error={error?.fields?.parent}>
            <Select value={form.parent} onChange={set('parent')} options={parents} />
          </Field>
        </div>
        <Field label="Document root" help={`Folder under public_html; blank uses public_html/${label || '<name>'}`} error={error?.fields?.docroot}>
          <TextInput value={form.docroot} onChange={set('docroot')} placeholder={label || 'shop'} spellCheck={false} />
        </Field>
      </form>
    </Modal>
  );
}

export default function Subdomains({ fn }) {
  const toast = useToast();
  const { me } = usePanelMe();
  const { rows, counts, limits, error, loading, refetch } = useDomains();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [last, setLast] = useState(null);
  const disabled = useFeatureGate(fn, error);
  if (disabled) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const homeDir = me?.account?.homeDir;
  const subs = rows.filter((r) => r.type === 'sub');
  const parents = rows.filter((r) => r.type === 'main' || r.type === 'addon').map((r) => r.domain);
  const count = counts?.sub ?? subs.length;
  const limit = limits?.max_subdomains ?? null;
  const full = limitReached(count, limit);

  const onCreated = (res) => {
    setAdding(false);
    setLast({ data: res.data, warnings: res.meta?.warnings || [] });
    toast.success(`${res.data.domain} added`);
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    const res = await panelApi.delete(`/domains/sub/${encodeURIComponent(d)}?removeDocroot=${choice.removeDocroot}`);
    setRemoving(null);
    toast.success(`${d} removed`);
    if (res.meta?.warnings?.length) toast.warning(res.meta.warnings.join(' '));
    refetch();
  };

  const columns = [
    { key: 'domain', label: 'Subdomain', render: (r) => <strong>{r.domain}</strong> },
    { key: 'docroot', label: 'Document root', render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: 'Web server', render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: 'SSL', render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: 'Added', render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full || !parents.length}>Add subdomain</Button>}>
      <LimitNotice count={count} limit={limit} noun="subdomains" />
      {last && (
        <CreateResult title={`${last.data.domain} is set up`} warnings={last.warnings} onDismiss={() => setLast(null)} items={[
          ['Document root', <DocrootCode key="d" docroot={last.data.docroot} homeDir={homeDir} />],
          ['DNS record', last.data.dns?.zone ? <AppliedPill key="z" result={last.data.dns} okLabel={`Added to ${last.data.dns.zone}`} /> : <span key="n" className="muted">No zone of yours contains this name; add the A record where its DNS is hosted</span>],
          ['Web server', <AppliedPill key="w" result={last.data.web} okLabel="Configured" />],
        ]} />
      )}
      <Card title="Subdomains" subtitle={usageText(count, limit, 'subdomains')} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={subs} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText="No subdomains yet. Add one to serve a section of your site, such as shop or blog, from its own folder."
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <SubdomainForm open parents={parents} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={`Remove ${removing.domain}?`} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeDocroot', label: 'Delete the document root', description: `Removes ${removing.docroot} and every file in it. This cannot be undone.`, default: false },
        ]} />
      )}
    </PanelPage>
  );
}
