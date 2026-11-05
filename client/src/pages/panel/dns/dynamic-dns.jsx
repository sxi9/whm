import { useMemo, useState } from 'react';
import { Plus, Copy, Info } from 'lucide-react';
import { Card, StatusPill, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { DelegationBanner, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

const isCapability = (err) => Boolean(err) && (err.status === 501 || err.code === 'capability_missing' || err.code === 'binary_not_found');

// Zones a token can be minted for: those with at least one A/AAAA record whose
// public DNS is not known to be elsewhere.
export function eligibleZones(zones) {
  return (zones || []).filter((z) => !notDelegatedHere(z.delegation));
}

export function CreateTokenForm({ zones, onClose, onCreated }) {
  const { t } = useT();
  const usable = eligibleZones(zones);
  const [domain, setDomain] = useState(usable[0]?.domain || '');
  const zone = usable.find((z) => z.domain === domain) || null;
  const [recordId, setRecordId] = useState(String(zone?.records?.[0]?.id ?? ''));
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pickZone = (d) => { setDomain(d); setRecordId(String(usable.find((z) => z.domain === d)?.records?.[0]?.id ?? '')); };
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await panelApi.post('/dns/ddns', { domain, recordId: Number(recordId), label: label.trim() || null });
      onCreated(res.data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const zoneOptions = (zones || []).map((z) => ({ value: z.domain, label: notDelegatedHere(z.delegation) ? `${z.domain} — ${t('panel.ddns.disabled_zone', 'DNS managed elsewhere')}` : z.domain, disabled: notDelegatedHere(z.delegation) }));
  const recordOptions = (zone?.records || []).map((r) => ({ value: String(r.id), label: `${r.host}  ${r.type}  ${r.value}` }));
  return (
    <Modal open title={t('panel.ddns.create_title', 'Create a dynamic DNS update URL')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.ddns.cancel', 'Cancel')}</Button><Button type="submit" form="ddns-form" variant="primary" loading={busy} disabled={!zone || !recordId}>{t('panel.ddns.add_token', 'Create update URL')}</Button></>}>
      <form id="ddns-form" onSubmit={submit}>
        {error && (isCapability(error) ? <PanelCapabilityState error={error} /> : <ErrorBanner error={error} />)}
        <Field label={t('panel.ddns.zone', 'Zone')} required help={t('panel.ddns.zone_help', 'Zones whose public DNS is managed elsewhere cannot be updated from here')} error={error?.fields?.domain}>
          <Select value={domain} onChange={pickZone} options={zoneOptions} />
        </Field>
        <Field label={t('panel.ddns.record', 'Record')} required help={t('panel.ddns.record_help', 'The A (IPv4) or AAAA (IPv6) record the URL updates')} error={error?.fields?.recordId}>
          {recordOptions.length ? <Select value={recordId} onChange={setRecordId} options={recordOptions} /> : <p className="muted">{t('panel.ddns.no_records', 'No A or AAAA records in this zone yet; add one in the zone editor first.')}</p>}
        </Field>
        <Field label={t('panel.ddns.label', 'Label')} help={t('panel.ddns.label_help', 'Optional: which device or site uses this URL')} error={error?.fields?.label}>
          <TextInput value={label} onChange={setLabel} placeholder="home router" maxLength={64} />
        </Field>
      </form>
    </Modal>
  );
}

// The one time the plain URL is shown.
export function CreatedTokenModal({ created, onClose }) {
  const { t } = useT();
  const toast = useToast();
  const copy = async () => { try { await navigator.clipboard.writeText(created.url); toast.success(t('panel.ddns.copied', 'Update URL copied')); } catch { toast.error(t('panel.ddns.copy_failed', 'Copy failed; select the text instead')); } };
  return (
    <Modal open title={t('panel.ddns.created_title', 'Update URL created')} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t('panel.ddns.close', 'Close')}</Button>}>
      <p>{t('panel.ddns.created_help', "Store this URL in your router or script now; it is not shown again. Opening it updates the record to the caller's address, or to ?ip= when given.")}</p>
      <Field label={t('panel.ddns.url', 'Update URL')}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code data-ddns-url style={{ wordBreak: 'break-all', flex: 1 }}>{created.url}</code>
          <Button icon={Copy} onClick={copy}>{t('panel.ddns.copy', 'Copy')}</Button>
        </div>
      </Field>
      <p className="muted">{t('panel.ddns.cron_help', 'From a cron job every five minutes:')}</p>
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}><code>{`*/5 * * * * curl -fsS '${created.url}?format=text'`}</code></pre>
    </Modal>
  );
}

export default function DynamicDns({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const data = usePanelApi('/dns/ddns');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const tokens = data.data?.tokens || [];
  const zones = data.data?.zones || [];
  const max = data.data?.max ?? 20;
  const usable = useMemo(() => eligibleZones(zones).filter((z) => z.records.length), [zones]);
  const canCreate = usable.length > 0 && tokens.length < max;

  const revoke = async (row) => {
    if (!(await confirm({ title: fill(t('panel.ddns.revoke_confirm', 'Revoke the update URL for {host}?'), { host: row.host }), message: t('panel.ddns.revoke_message', 'Devices still using it answer 404 from then on.'), confirmLabel: t('panel.ddns.revoke', 'Revoke'), danger: true }))) return;
    try {
      await panelApi.delete(`/dns/ddns/${row.id}`);
      toast.success(t('panel.ddns.revoked', 'Update URL revoked'));
      data.refetch();
    } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'host', label: t('panel.ddns.col_host', 'Record'), render: (r) => <span><strong>{r.host}</strong> <StatusPill status="info">{r.type}</StatusPill></span> },
    { key: 'label', label: t('panel.ddns.col_label', 'Label'), render: (r) => r.label || <span className="muted">—</span> },
    { key: 'value', label: t('panel.ddns.col_value', 'Current value'), render: (r) => <code>{r.value}</code> },
    { key: 'lastUsedAt', label: t('panel.ddns.col_last_update', 'Last update'), render: (r) => (r.lastUsedAt ? <span>{formatDate(r.lastUsedAt)}{r.lastIp && <span className="muted"> · {r.lastIp}</span>}</span> : <span className="muted">{t('panel.ddns.never', 'never')}</span>) },
    { key: 'updates', label: t('panel.ddns.col_updates', 'Updates'), width: 90, align: 'right' },
  ];

  return (
    <PanelPage fn={fn} actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)} disabled={!canCreate}>{t('panel.ddns.add_token', 'Create update URL')}</Button>}>
      <PanelCapabilityState error={data.error} onRetry={data.refetch} />
      {data.error && !isCapability(data.error) && <ErrorBanner error={data.error} onRetry={data.refetch} />}
      {zones.map((z) => <DelegationBanner key={z.domain} domain={z.domain} delegation={z.delegation} title={t('panel.ddns.delegation_title', 'Dynamic DNS is unavailable for this zone')} />)}
      {!data.loading && !data.error && zones.length === 0 && (
        <Card><EmptyState title={t('panel.ddns.no_zones', 'No DNS zones on this account')}><p>{t('panel.ddns.no_zones_help', 'A zone appears here for every domain whose DNS is hosted on this server.')}</p></EmptyState></Card>
      )}
      <Card title={t('panel.ddns.tokens_title', 'Update URLs')} subtitle={fill(t('panel.ddns.limit_help', '{count} of {max} update URLs used'), { count: tokens.length, max })} padded={false}>
        <DataTable columns={columns} rows={tokens} loading={data.loading} emptyText={t('panel.ddns.empty', 'No update URLs yet. Create one for an A or AAAA record to keep it pointed at a home or office connection.')}
          rowActions={(r) => [{ label: t('panel.ddns.revoke', 'Revoke'), primary: true, danger: true, onClick: () => revoke(r) }]} />
      </Card>
      <div className="banner banner-info"><Info size={18} /><div><strong>{t('panel.ddns.how_title', 'How it works')}</strong><p>{t('panel.ddns.how_text', 'Each URL is tied to one A or AAAA record of your zones. A router, NAS or cron line opens it after every address change; the record is rewritten and published by the DNS server on this host. Anyone holding the URL can move the record, so keep it private and revoke it when a device is retired.')}</p></div></div>
      {creating && <CreateTokenForm zones={zones} onClose={() => setCreating(false)} onCreated={(d) => { setCreating(false); setCreated(d); data.refetch(); }} />}
      {created && <CreatedTokenModal created={created} onClose={() => setCreated(null)} />}
    </PanelPage>
  );
}
