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
import { useDomains, useFeatureGate, isParked, limitReached, usageText, LimitNotice, RequestError, VhostPill, SslPill, AppliedPill, CreateResult, RemoveDomainModal } from './parts/shared.jsx';

export function ParkedForm({ open, target, onClose, onCreated }) {
  const { t } = useT();
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
    <Modal open={open} title={t('panel.domains.park_title', 'Park a domain')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.domains.cancel', 'Cancel')}</Button><Button type="submit" form="parked-form" variant="primary" loading={busy}>{t('panel.domains.park_domain', 'Park domain')}</Button></>}>
      <form id="parked-form" onSubmit={submit}>
        <RequestError error={error} />
        <p className="muted">{fill(t('panel.domains.park_help', 'A parked domain shows the same site as {target}. Visitors keep the address they typed.'), { target })}</p>
        <Field label={t('panel.domains.col_domain', 'Domain')} required help={t('panel.domains.parked_domain_help', 'A registered name whose nameservers point at this server')} error={error?.fields?.domain}>
          <TextInput value={form.domain} onChange={set('domain')} placeholder="example.net" autoFocus spellCheck={false} />
        </Field>
        <Toggle checked={form.createZone} onChange={set('createZone')} label={t('panel.domains.create_zone', 'Create a DNS zone')} description={t('panel.domains.create_zone_parked_help', 'Standard records pointing at this server. Turn off when DNS is hosted elsewhere.')} />
      </form>
    </Modal>
  );
}

const webPill = (web) => (web === 'applied' || web === true ? { applied: true } : web === 'pending' || web === false ? { applied: false, reason: 'pending' } : web && typeof web === 'object' ? web : null);

export default function ParkedDomains({ fn }) {
  const { t } = useT();
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
  const noun = t('panel.domains.noun_parked_domains', 'parked domains');

  const onCreated = (res) => {
    setAdding(false);
    setLast(res.data);
    toast.success(fill(t('panel.domains.parked_on', '{domain} parked on {target}'), { domain: res.data.domain, target: res.data.target || target }));
    refetch();
  };
  const remove = async (choice) => {
    const d = removing.domain;
    await panelApi.delete(`/domains/parked/${encodeURIComponent(d)}?removeZone=${choice.removeZone}`);
    setRemoving(null);
    toast.success(fill(t('panel.domains.unparked', '{domain} is no longer parked'), { domain: d }));
    refetch();
  };

  const columns = [
    { key: 'domain', label: t('panel.domains.col_parked_domain', 'Parked domain'), render: (r) => <strong>{r.domain}</strong> },
    { key: 'target', label: t('panel.domains.col_shows', 'Shows'), render: () => target },
    { key: 'vhost', label: t('panel.domains.col_web_server', 'Web server'), render: (r) => <VhostPill vhost={r.vhost} /> },
    { key: 'ssl', label: t('panel.domains.col_ssl', 'SSL'), render: (r) => <SslPill ssl={r.ssl} /> },
    { key: 'createdAt', label: t('panel.domains.col_added', 'Added'), render: (r) => formatDate(r.createdAt) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)} disabled={full}>{t('panel.domains.park_title', 'Park a domain')}</Button>}>
      <LimitNotice count={count} limit={limit} noun={noun} />
      {last && (
        <CreateResult title={fill(t('panel.domains.is_parked', '{domain} is parked'), { domain: last.domain })} onDismiss={() => setLast(null)} items={[
          [t('panel.domains.col_shows', 'Shows'), last.target || target],
          [t('panel.domains.dns_zone', 'DNS zone'), last.zone ? <AppliedPill key="z" result={last.zone} okLabel={t('panel.domains.zone_created', 'Created')} /> : t('panel.domains.zone_not_created', 'Not created')],
          [t('panel.domains.col_web_server', 'Web server'), <AppliedPill key="w" result={webPill(last.web)} okLabel={t('panel.domains.alias_added', 'Alias added')} />],
          last.webDetail && [t('panel.domains.detail', 'Detail'), String(last.webDetail)],
        ]} />
      )}
      <Card title={t('panel.domains.parked_domains', 'Parked domains')} subtitle={usageText(count, limit, noun)} padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        <DataTable columns={columns} rows={parked} loading={loading} error={error && error.status !== 501 ? error : null}
          emptyText={fill(t('panel.domains.parked_empty', 'No parked domains yet. Park one to show {target} under another name, for example a .net or a misspelling you own.'), { target: target || t('panel.domains.your_main_site', 'your main site') })}
          rowKey={(r) => r.domain}
          rowActions={(r) => [{ label: t('panel.domains.remove', 'Remove'), primary: true, danger: true, onClick: () => setRemoving(r) }]} />
      </Card>
      {adding && <ParkedForm open target={target} onClose={() => setAdding(false)} onCreated={onCreated} />}
      {removing && (
        <RemoveDomainModal open domain={removing.domain} title={fill(t('panel.domains.stop_parking_title', 'Stop parking {domain}?'), { domain: removing.domain })} onClose={() => setRemoving(null)} onConfirm={remove} options={[
          { key: 'removeZone', label: t('panel.domains.delete_zone', 'Delete its DNS zone'), description: t('panel.domains.delete_zone_help', 'The records of this domain on this server are removed.'), default: true },
        ]} />
      )}
    </PanelPage>
  );
}
