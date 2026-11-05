import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Card, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { useDomains, useFeatureGate, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, DocrootCode, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';
import { DelegationBanner, managedAt, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

// The zone toggle defaults off when the account's main domain is not delegated
// to this server: its DNS is evidently published elsewhere, and a zone here
// would only look like it worked.
export function defaultCreateZone(rows) {
  const main = (rows || []).find((r) => r.type === 'main');
  return !notDelegatedHere(main?.delegation);
}

export function AddonForm({ open, onClose, onCreated, createZoneDefault = true, mainDomain = null }) {
  const { t } = useT();
  const [form, setForm] = useState({ domain: '', docroot: '', createZone: createZoneDefault });
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
  const zoneOffWhy = mainDomain
    ? fill(t('panel.domains.zone_off_main_at', 'Off because DNS for {domain} is managed at {provider}; turn on only when the new domain\'s nameservers point at this server.'), { domain: mainDomain.domain, provider: managedAt(mainDomain.delegation) })
    : t('panel.domains.zone_off_elsewhere', 'Off because DNS for your main domain is managed elsewhere; turn on only when the new domain\'s nameservers point at this server.');
  return (
    <Modal open={open} title={t('panel.domains.add_addon_title', 'Add an addon domain')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.domains.cancel', 'Cancel')}</Button><Button type="submit" form="addon-form" variant="primary" loading={busy}>{t('panel.domains.add_domain', 'Add domain')}</Button></>}>
      <form id="addon-form" onSubmit={submit}>
        <RequestError error={error} />
        <Field label={t('panel.domains.col_domain', 'Domain')} required help={t('panel.domains.addon_domain_help', 'A registered name whose nameservers point at this server, e.g. example.org')} error={error?.fields?.domain}>
          <TextInput value={form.domain} onChange={set('domain')} placeholder="example.org" autoFocus spellCheck={false} />
        </Field>
        <Field label={t('panel.domains.docroot', 'Document root')} help={fill(t('panel.domains.docroot_help', 'Folder under public_html; blank uses public_html/{name}'), { name: form.domain.trim().toLowerCase() || '<domain>' })} error={error?.fields?.docroot}>
          <TextInput value={form.docroot} onChange={set('docroot')} placeholder={form.domain.trim().toLowerCase() || 'example.org'} spellCheck={false} />
        </Field>
        <Toggle checked={form.createZone} onChange={set('createZone')} label={t('panel.domains.create_zone', 'Create a DNS zone')} description={createZoneDefault ? t('panel.domains.create_zone_addon_help', 'Standard A, MX and SPF records for the new domain. Turn off when DNS is hosted elsewhere.') : zoneOffWhy} />
      </form>
    </Modal>
  );
}

export default function AddonDomains({ fn }) {
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
  const addons = rows.filter((r) => r.type === 'addon');
  const main = rows.find((r) => r.type === 'main') || null;
  const zoneDefault = defaultCreateZone(rows);
  const count = counts?.addon ?? addons.length;
  const limit = limits?.max_addons ?? null;
  const full = limitReached(count, limit);
  const noun = t('panel.domains.noun_addon_domains', 'addon domains');

  const onCreated = (res) => {
    setAdding(false);
    setLast({ data: res.data, warnings: res.meta?.warnings || [] });
    toast.success(fill(t('panel.domains.added', '{domain} added'), { domain: res.data.domain }));
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    const res = await panelApi.delete(`/domains/addon/${encodeURIComponent(d)}?removeZone=${choice.removeZone}&removeDocroot=${choice.removeDocroot}`);
    setRemoving(null);
    toast.success(fill(t('panel.domains.removed', '{domain} removed'), { domain: d }));
    if (res.meta?.warnings?.length) toast.warning(res.meta.warnings.join(' '));
    refetch();
  };

  const columns = [
    { key: 'domain', label: t('panel.domains.col_domain', 'Domain'), render: (r) => <strong>{r.domain}</strong> },
    { key: 'docroot', label: t('panel.domains.col_docroot', 'Document root'), render: (r) => <DocrootCode docroot={r.docroot} homeDir={homeDir} /> },
    { key: 'vhost', label: t('panel.domains.col_web_server', 'Web server'), render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: t('panel.domains.col_ssl', 'SSL'), render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: t('panel.domains.col_added', 'Added'), render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full}>{t('panel.domains.add_addon', 'Add addon domain')}</Button>}>
      <LimitNotice count={count} limit={limit} noun={noun} />
      {last && <DelegationBanner domain={last.data.domain} delegation={last.data.delegation} records={last.data.records} title={fill(t('panel.domains.not_published_from_here', '{domain} is not published from here'), { domain: last.data.domain })} />}
      {last && (
        <CreateResult title={fill(t('panel.domains.is_set_up', '{domain} is set up'), { domain: last.data.domain })} warnings={last.warnings} onDismiss={() => setLast(null)} items={[
          [t('panel.domains.docroot', 'Document root'), <DocrootCode key="d" docroot={last.data.docroot} homeDir={homeDir} />],
          [t('panel.domains.dns_zone', 'DNS zone'), last.data.zone ? <AppliedPill key="z" result={last.data.zone} okLabel={last.data.zone.created ? t('panel.domains.zone_created', 'Created') : t('panel.domains.zone_present', 'Already present')} /> : t('panel.domains.zone_not_created', 'Not created')],
          [t('panel.domains.col_web_server', 'Web server'), <AppliedPill key="w" result={last.data.web} okLabel={t('panel.domains.configured', 'Configured')} />],
          [t('panel.domains.mail_routing', 'Mail routing'), <AppliedPill key="m" result={last.data.mail} okLabel={t('panel.domains.mail_local', 'Local')} />],
        ]} />
      )}
      <Card title={t('panel.domains.addon_domains', 'Addon domains')} subtitle={usageText(count, limit, noun)} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={addons} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={t('panel.domains.addon_empty', 'No addon domains yet. Add one to host another website on this account; it gets its own folder under public_html.')}
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: t('panel.domains.remove', 'Remove'), primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <AddonForm open onClose={() => setAdding(false)} onCreated={onCreated} createZoneDefault={zoneDefault} mainDomain={zoneDefault ? null : main} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={fill(t('panel.domains.remove_title', 'Remove {domain}?'), { domain: removing.domain })} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeZone', label: t('panel.domains.delete_zone', 'Delete its DNS zone'), description: t('panel.domains.delete_zone_help', 'The records of this domain on this server are removed.'), default: true },
          { key: 'removeDocroot', label: t('panel.domains.delete_docroot', 'Delete the document root'), description: fill(t('panel.domains.delete_docroot_help', 'Removes {docroot} and every file in it. This cannot be undone.'), { docroot: removing.docroot }), default: false },
        ]} />
      )}
    </PanelPage>
  );
}
