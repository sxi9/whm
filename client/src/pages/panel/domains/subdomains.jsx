import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { useDomains, useFeatureGate, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, DocrootCode, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';
import { DelegationBanners, RecordList, managedAt, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// What the create answer says about the subdomain's address record: added to a
// zone here, to be copied to the parent's DNS provider, or neither.
export function DnsRecordResult({ dns }) {
  const { t } = useT();
  if (!dns) return <span className="muted">—</span>;
  if (notDelegatedHere(dns.delegation)) {
    return <span><span className="muted">{fill(t('panel.domains.add_at', 'Add at {provider}:'), { provider: managedAt(dns.delegation) })}</span><RecordList records={dns.records} /></span>;
  }
  if (dns.zone) return <AppliedPill result={dns} okLabel={fill(t('panel.domains.added_to_zone', 'Added to {zone}'), { zone: dns.zone })} />;
  return <span className="muted">{t('panel.domains.no_zone_for_name', 'No zone of yours contains this name; add the A record where its DNS is hosted')}</span>;
}

export function SubdomainForm({ open, parents, delegations = {}, onClose, onCreated }) {
  const { t } = useT();
  const [form, setForm] = useState({ label: '', parent: parents[0] || '', docroot: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const label = form.label.trim().toLowerCase();
  const submit = async (e) => {
    e.preventDefault();
    if (!LABEL_RE.test(label)) { setError({ message: t('panel.domains.check_sub_name', 'Check the subdomain name'), fields: { label: [t('panel.domains.sub_name_rule', 'Letters, digits and "-", up to 63 characters, not starting or ending with "-"')] } }); return; }
    setBusy(true);
    setError(null);
    const body = { label, parent: form.parent };
    if (form.docroot.trim()) body.docroot = form.docroot.trim();
    try { onCreated(await panelApi.post('/domains/sub', body)); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title={t('panel.domains.add_sub_title', 'Add a subdomain')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.domains.cancel', 'Cancel')}</Button><Button type="submit" form="sub-form" variant="primary" loading={busy}>{t('panel.domains.add_subdomain', 'Add subdomain')}</Button></>}>
      <form id="sub-form" onSubmit={submit}>
        <RequestError error={error} />
        <div className="form-grid">
          <Field label={t('panel.domains.name', 'Name')} required help={label ? fill(t('panel.domains.becomes', 'Becomes {fqdn}'), { fqdn: `${label}.${form.parent}` }) : t('panel.domains.sub_name_help', 'The part before the domain, e.g. shop')} error={error?.fields?.label}>
            <TextInput value={form.label} onChange={set('label')} placeholder="shop" autoFocus spellCheck={false} />
          </Field>
          <Field label={t('panel.domains.under', 'Under')} required error={error?.fields?.parent} help={notDelegatedHere(delegations[form.parent]) ? fill(t('panel.domains.parent_elsewhere', 'DNS for {domain} is managed at {provider}; the A record is shown for you to add there'), { domain: form.parent, provider: managedAt(delegations[form.parent]) }) : undefined}>
            <Select value={form.parent} onChange={set('parent')} options={parents} />
          </Field>
        </div>
        <Field label={t('panel.domains.docroot', 'Document root')} help={fill(t('panel.domains.docroot_help', 'Folder under public_html; blank uses public_html/{name}'), { name: label || '<name>' })} error={error?.fields?.docroot}>
          <TextInput value={form.docroot} onChange={set('docroot')} placeholder={label || 'shop'} spellCheck={false} />
        </Field>
      </form>
    </Modal>
  );
}

export default function Subdomains({ fn }) {
  const { t } = useT();
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
  const parentRows = rows.filter((r) => r.type === 'main' || r.type === 'addon');
  const parents = parentRows.map((r) => r.domain);
  const delegations = Object.fromEntries(parentRows.map((r) => [r.domain, r.delegation || null]));
  const count = counts?.sub ?? subs.length;
  const limit = limits?.max_subdomains ?? null;
  const full = limitReached(count, limit);
  const noun = t('panel.domains.noun_subdomains', 'subdomains');

  const onCreated = (res) => {
    setAdding(false);
    setLast({ data: res.data, warnings: res.meta?.warnings || [] });
    toast.success(fill(t('panel.domains.added', '{domain} added'), { domain: res.data.domain }));
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    const res = await panelApi.delete(`/domains/sub/${encodeURIComponent(d)}?removeDocroot=${choice.removeDocroot}`);
    setRemoving(null);
    toast.success(fill(t('panel.domains.removed', '{domain} removed'), { domain: d }));
    if (res.meta?.warnings?.length) toast.warning(res.meta.warnings.join(' '));
    refetch();
  };

  const columns = [
    { key: 'domain', label: t('panel.domains.col_subdomain', 'Subdomain'), render: (r) => <strong>{r.domain}</strong> },
    { key: 'docroot', label: t('panel.domains.col_docroot', 'Document root'), render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: t('panel.domains.col_web_server', 'Web server'), render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: t('panel.domains.col_ssl', 'SSL'), render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: t('panel.domains.col_added', 'Added'), render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full || !parents.length}>{t('panel.domains.add_subdomain', 'Add subdomain')}</Button>}>
      <LimitNotice count={count} limit={limit} noun={noun} />
      <DelegationBanners domains={parentRows} title={t('panel.domains.sub_not_published', 'Subdomains are not published from here')} />
      {last && (
        <CreateResult title={fill(t('panel.domains.is_set_up', '{domain} is set up'), { domain: last.data.domain })} warnings={last.warnings} onDismiss={() => setLast(null)} items={[
          [t('panel.domains.docroot', 'Document root'), <DocrootCode key="d" docroot={last.data.docroot} homeDir={homeDir} />],
          [t('panel.domains.dns_record', 'DNS record'), <DnsRecordResult key="z" dns={last.data.dns} />],
          [t('panel.domains.col_web_server', 'Web server'), <AppliedPill key="w" result={last.data.web} okLabel={t('panel.domains.configured', 'Configured')} />],
        ]} />
      )}
      <Card title={t('panel.domains.subdomains', 'Subdomains')} subtitle={usageText(count, limit, noun)} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={subs} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={t('panel.domains.sub_empty', 'No subdomains yet. Add one to serve a section of your site, such as shop or blog, from its own folder.')}
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: t('panel.domains.remove', 'Remove'), primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <SubdomainForm open parents={parents} delegations={delegations} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={fill(t('panel.domains.remove_title', 'Remove {domain}?'), { domain: removing.domain })} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeDocroot', label: t('panel.domains.delete_docroot', 'Delete the document root'), description: fill(t('panel.domains.delete_docroot_help', 'Removes {docroot} and every file in it. This cannot be undone.'), { docroot: removing.docroot }), default: false },
        ]} />
      )}
    </PanelPage>
  );
}
