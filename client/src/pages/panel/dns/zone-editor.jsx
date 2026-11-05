import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Info } from 'lucide-react';
import { Card, StatusPill, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Textarea, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { DelegationBanner, notDelegatedHere } from '../../../panel/DelegationBanner.jsx';

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const HOST_TYPES = new Set(['CNAME', 'MX']);

const isCapability = (err) => Boolean(err) && (err.status === 501 || err.code === 'capability_missing' || err.code === 'binary_not_found');
export const stripDot = (v) => (typeof v === 'string' ? v.replace(/\.$/, '') : v);

// What the table and the form show for a stored record: hostname targets without
// the trailing dot, SRV and CAA split into their parts.
export function presentRecord(rec) {
  const out = { ...rec, display: rec.value };
  if (HOST_TYPES.has(rec.type)) out.display = stripDot(rec.value);
  if (rec.type === 'SRV') {
    const m = String(rec.value).match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (m) { out.srv = { weight: Number(m[1]), port: Number(m[2]), target: stripDot(m[3]) }; out.display = `${m[1]} ${m[2]} ${stripDot(m[3])}`; }
  }
  if (rec.type === 'CAA') {
    const m = String(rec.value).match(/^(\d+)\s+(\S+)\s+"?([^"]*)"?$/);
    if (m) out.caa = { flags: m[1], tag: m[2], value: m[3] };
  }
  return out;
}

export function emptyForm(type = 'A') {
  return { name: '', type, ttl: '', priority: '', value: '', weight: '', port: '', target: '', flags: '0', tag: 'issue' };
}

export function formFrom(rec) {
  const p = presentRecord(rec);
  return { ...emptyForm(rec.type), name: rec.name === '@' ? '' : rec.name, ttl: rec.ttl ?? '', priority: rec.priority ?? '', value: p.caa ? p.caa.value : p.display ?? '', weight: p.srv?.weight ?? '', port: p.srv?.port ?? '', target: p.srv?.target ?? '', flags: p.caa?.flags ?? '0', tag: p.caa?.tag ?? 'issue' };
}

// The request body for one form; SRV and CAA are composed the way the zone stores them.
export function bodyFrom(form) {
  const body = { name: form.name.trim() || '@', type: form.type, ttl: form.ttl === '' ? null : String(form.ttl).trim() };
  if (form.type === 'SRV') { body.priority = form.priority === '' ? null : Number(form.priority); body.value = `${form.weight} ${form.port} ${String(form.target).trim()}`; }
  else if (form.type === 'MX') { body.priority = form.priority === '' ? null : Number(form.priority); body.value = String(form.value).trim(); }
  else if (form.type === 'CAA') body.value = `${form.flags} ${form.tag} ${String(form.value).trim()}`;
  else body.value = String(form.value).trim();
  return body;
}

export function RecordForm({ zone, initial, types, onClose, onSaved }) {
  const { t } = useT();
  const [form, setForm] = useState(initial ? formFrom(initial) : emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const fqdn = form.name.trim() ? `${form.name.trim()}.${zone.domain}` : zone.domain;
  const caaTags = [{ value: 'issue', label: t('panel.dns.caa_issue', 'issue — may issue certificates') }, { value: 'issuewild', label: t('panel.dns.caa_issuewild', 'issuewild — may issue wildcard certificates') }, { value: 'iodef', label: t('panel.dns.caa_iodef', 'iodef — where to report violations') }];
  const caaFlags = [{ value: '0', label: t('panel.dns.caa_flag_0', '0 — not critical') }, { value: '128', label: t('panel.dns.caa_flag_128', '128 — critical') }];
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = initial ? await panelApi.put(`/dns/zones/${encodeURIComponent(zone.domain)}/records/${initial.id}`, bodyFrom(form)) : await panelApi.post(`/dns/zones/${encodeURIComponent(zone.domain)}/records`, bodyFrom(form));
      onSaved(res.data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const valueError = error?.fields?.value;
  return (
    <Modal open title={initial ? fill(t('panel.dns.edit_record_title', 'Edit {type} record'), { type: initial.type }) : t('panel.dns.add_record_title', 'Add a record')} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>{t('panel.dns.cancel', 'Cancel')}</Button><Button type="submit" form="record-form" variant="primary" loading={busy}>{initial ? t('panel.dns.save_record', 'Save record') : t('panel.dns.add_record', 'Add record')}</Button></>}>
      <form id="record-form" onSubmit={submit}>
        {error && !error.fields && (isCapability(error) ? <PanelCapabilityState error={error} /> : <ErrorBanner error={error} />)}
        <div className="form-grid">
          <Field label={t('panel.dns.col_type', 'Type')} required error={error?.fields?.type}>
            <Select value={form.type} onChange={(ty) => setForm((f) => ({ ...emptyForm(ty), name: f.name, ttl: f.ttl }))} options={types || RECORD_TYPES} disabled={Boolean(initial)} />
          </Field>
          <Field label={t('panel.dns.col_name', 'Name')} help={form.type === 'SRV' ? t('panel.dns.name_help_srv', 'Service and protocol, e.g. _sip._tcp') : fill(t('panel.dns.name_help', 'Blank for {zone} itself; becomes {fqdn}'), { zone: zone.domain, fqdn })} error={error?.fields?.name}>
            <TextInput value={form.name} onChange={set('name')} placeholder={form.type === 'SRV' ? '_sip._tcp' : 'www'} autoFocus spellCheck={false} />
          </Field>
        </div>
        {form.type === 'A' && <Field label={t('panel.dns.ipv4', 'IPv4 address')} required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder="203.0.113.10" spellCheck={false} /></Field>}
        {form.type === 'AAAA' && <Field label={t('panel.dns.ipv6', 'IPv6 address')} required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder="2001:db8::1" spellCheck={false} /></Field>}
        {form.type === 'CNAME' && <Field label={t('panel.dns.points_to', 'Points to')} required help={t('panel.dns.cname_help', 'A hostname, not an IP address')} error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder={zone.domain} spellCheck={false} /></Field>}
        {form.type === 'MX' && (
          <div className="form-grid">
            <Field label={t('panel.dns.col_priority', 'Priority')} required help={t('panel.dns.priority_help', 'Lower numbers are tried first')} error={error?.fields?.priority}><NumberInput value={form.priority === '' ? null : form.priority} onChange={(v) => set('priority')(v ?? '')} min={0} max={65535} /></Field>
            <Field label={t('panel.dns.mail_server', 'Mail server')} required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder={`mail.${zone.domain}`} spellCheck={false} /></Field>
          </div>
        )}
        {form.type === 'TXT' && <Field label={t('panel.dns.text', 'Text')} required help={t('panel.dns.txt_help', 'Quotes are added for you')} error={valueError}><Textarea value={form.value} onChange={set('value')} rows={3} mono /></Field>}
        {form.type === 'SRV' && (
          <>
            <div className="form-grid">
              <Field label={t('panel.dns.col_priority', 'Priority')} required error={error?.fields?.priority}><NumberInput value={form.priority === '' ? null : form.priority} onChange={(v) => set('priority')(v ?? '')} min={0} max={65535} /></Field>
              <Field label={t('panel.dns.weight', 'Weight')} required error={valueError}><NumberInput value={form.weight === '' ? null : form.weight} onChange={(v) => set('weight')(v ?? '')} min={0} max={65535} /></Field>
              <Field label={t('panel.dns.port', 'Port')} required><NumberInput value={form.port === '' ? null : form.port} onChange={(v) => set('port')(v ?? '')} min={0} max={65535} /></Field>
            </div>
            <Field label={t('panel.dns.target', 'Target')} required help={t('panel.dns.target_help', 'The host that provides the service')}><TextInput value={form.target} onChange={set('target')} placeholder={`sip.${zone.domain}`} spellCheck={false} /></Field>
          </>
        )}
        {form.type === 'CAA' && (
          <>
            <div className="form-grid">
              <Field label={t('panel.dns.flags', 'Flags')}><Select value={form.flags} onChange={set('flags')} options={caaFlags} /></Field>
              <Field label={t('panel.dns.tag', 'Tag')}><Select value={form.tag} onChange={set('tag')} options={caaTags} /></Field>
            </div>
            <Field label={form.tag === 'iodef' ? t('panel.dns.report_address', 'Report address') : t('panel.dns.certificate_authority', 'Certificate authority')} required help={form.tag === 'iodef' ? t('panel.dns.iodef_help', 'mailto: or https: address') : t('panel.dns.ca_help', 'e.g. letsencrypt.org')} error={valueError}>
              <TextInput value={form.value} onChange={set('value')} placeholder={form.tag === 'iodef' ? 'mailto:hostmaster@example.com' : 'letsencrypt.org'} spellCheck={false} />
            </Field>
          </>
        )}
        <Field label={t('panel.dns.col_ttl', 'TTL')} help={fill(t('panel.dns.ttl_help', 'Seconds, or 1h / 1d; blank uses the zone default of {ttl} s'), { ttl: zone.ttl ?? 14400 })} error={error?.fields?.ttl}>
          <TextInput value={form.ttl} onChange={set('ttl')} placeholder={t('panel.dns.zone_default', 'zone default')} style={{ maxWidth: 200 }} />
        </Field>
      </form>
    </Modal>
  );
}

export function RecordName({ name, domain }) {
  if (name === '@') return <strong>{domain}</strong>;
  return <span><strong>{name}</strong><span className="muted">.{domain}</span></span>;
}

export function PublishState({ result }) {
  const { t } = useT();
  if (!result) return null;
  if (result.applied === false) return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><PendingPill result={result} /><span className="muted">{fill(t('panel.dns.saved_as_serial', 'saved as serial {serial}'), { serial: result.serial })}</span></span>;
  return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><StatusPill status="ok">{t('panel.dns.published', 'Published')}</StatusPill><span className="muted">{fill(t('panel.dns.serial_n', 'serial {serial}'), { serial: result.serial })}</span></span>;
}

export function filterRecords(records, type, q) {
  const needle = q.trim().toLowerCase();
  return records.filter((r) => (type === 'all' || r.type === type) && (!needle || `${r.name} ${r.type} ${r.value}`.toLowerCase().includes(needle)));
}

export default function ZoneEditor({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const zones = usePanelApi('/dns/zones');
  const list = zones.data?.zones || [];
  const wanted = params.get('zone');
  const selected = list.find((z) => z.domain === wanted)?.domain || list[0]?.domain || null;
  const zone = usePanelApi(selected ? `/dns/zones/${encodeURIComponent(selected)}` : null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [last, setLast] = useState(null);
  useEffect(() => { setEditing(null); setLast(null); setTypeFilter('all'); setQ(''); }, [selected]);

  const records = useMemo(() => (zone.data?.records || []).map(presentRecord), [zone.data]);
  const rows = useMemo(() => filterRecords(records, typeFilter, q), [records, typeFilter, q]);
  const typeCounts = useMemo(() => records.reduce((acc, r) => ({ ...acc, [r.type]: (acc[r.type] || 0) + 1 }), {}), [records]);
  const summary = list.find((z) => z.domain === selected);
  const types = zones.data?.types || RECORD_TYPES;
  const delegation = zone.data?.delegation || summary?.delegation || null;
  const elsewhere = notDelegatedHere(delegation);

  const onSaved = (data) => {
    setEditing(null);
    setLast(data);
    if (elsewhere) toast.warning(fill(t('panel.dns.saved_elsewhere', 'Record saved here, but DNS for {zone} is managed elsewhere: add it there as well'), { zone: selected }));
    else toast.success(data.applied === false ? t('panel.dns.saved_pending', 'Record saved; it is published once DNS is available on this server') : fill(t('panel.dns.saved_published', 'Record saved and published (serial {serial})'), { serial: data.serial }));
    zone.refetch();
    zones.refetch();
  };
  const remove = async (r) => {
    if (!(await confirm({ title: fill(t('panel.dns.delete_record_title', 'Delete this {type} record?'), { type: r.type }), message: `${r.name === '@' ? selected : `${r.name}.${selected}`}  ${r.type}  ${r.priority ?? ''} ${r.display}`.replace(/\s+/g, ' '), confirmLabel: t('panel.dns.delete', 'Delete'), danger: true }))) return;
    try {
      const res = await panelApi.delete(`/dns/zones/${encodeURIComponent(selected)}/records/${r.id}`);
      setLast(res.data);
      toast.success(t('panel.dns.record_deleted', 'Record deleted'));
      zone.refetch();
      zones.refetch();
    } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: t('panel.dns.col_name', 'Name'), render: (r) => <RecordName name={r.name} domain={selected} /> },
    { key: 'type', label: t('panel.dns.col_type', 'Type'), width: 80, render: (r) => <StatusPill status="info">{r.type}</StatusPill> },
    { key: 'ttl', label: t('panel.dns.col_ttl', 'TTL'), width: 90, align: 'right', render: (r) => (r.ttl == null ? <span className="muted">{t('panel.dns.ttl_default', 'default')}</span> : r.ttl) },
    { key: 'priority', label: t('panel.dns.col_priority', 'Priority'), width: 90, align: 'right', render: (r) => (r.priority == null ? <span className="muted">—</span> : r.priority) },
    { key: 'value', label: t('panel.dns.col_value', 'Value'), render: (r) => <code style={{ wordBreak: 'break-all' }}>{r.display}</code> },
  ];

  const listError = zones.error;
  const zoneError = zone.error;

  return (
    <PanelPage fn={fn} actions={selected && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>{t('panel.dns.add_record', 'Add record')}</Button>}>
      <PanelCapabilityState error={listError} onRetry={zones.refetch} />
      {listError && !isCapability(listError) && <ErrorBanner error={listError} onRetry={zones.refetch} />}
      {!zones.loading && !listError && list.length === 0 && (
        <Card>
          <EmptyState title={t('panel.dns.no_zones', 'No DNS zones on this account')}>
            <p>{t('panel.dns.no_zones_help', 'A zone appears here for every domain whose DNS is hosted on this server. Addon and parked domains can create one when they are added.')}</p>
          </EmptyState>
        </Card>
      )}
      {list.length > 0 && (
        <Card title={selected} subtitle={t('panel.dns.zone_help', 'Only the records you can change are listed; nameservers and the SOA are managed by your provider.')}
          actions={(
            <>
              {last && <PublishState result={last} />}
              {list.length > 1 && <Select value={selected || ''} onChange={(d) => setParams({ zone: d })} options={list.map((z) => z.domain)} aria-label={t('panel.dns.zone', 'Zone')} />}
            </>
          )}>
          <div className="stat-grid">
            <div className="stat"><div className="label">{t('panel.dns.records', 'Records')}</div><div className="value">{summary?.records ?? records.length}</div></div>
            <div className="stat"><div className="label">{t('panel.dns.default_ttl', 'Default TTL')}</div><div className="value">{summary?.ttl != null ? `${summary.ttl} s` : '—'}</div></div>
            <div className="stat"><div className="label">{t('panel.dns.serial', 'Serial')}</div><div className="value">{summary?.serial ?? '—'}</div></div>
            <div className="stat"><div className="label">{t('panel.dns.last_change', 'Last change')}</div><div className="value" style={{ fontSize: 15 }}>{summary?.updatedAt ? formatDate(summary.updatedAt) : '—'}</div></div>
            <div className="stat"><div className="label">{t('panel.dns.dns_server', 'DNS server')}</div><div className="value" style={{ fontSize: 15 }}>{zone.data ? (zone.data.published ? <StatusPill status="ok">{t('panel.dns.serving', 'Serving this zone')}</StatusPill> : <StatusPill status="pending">{t('panel.dns.not_publishing', 'Not yet publishing')}</StatusPill>) : '—'}{summary?.dnssecEnabled && <> <StatusPill status="enabled">DNSSEC</StatusPill></>}</div></div>
            <div className="stat"><div className="label">{t('panel.dns.public_dns', 'Public DNS')}</div><div className="value" style={{ fontSize: 15 }}>{delegation ? (delegation.delegatedHere === true ? <StatusPill status="ok">{t('panel.dns.delegated_here', 'Delegated here')}</StatusPill> : delegation.delegatedHere === false ? <StatusPill status="warning">{t('panel.dns.managed_elsewhere', 'Managed elsewhere')}</StatusPill> : <StatusPill status="unknown">{t('panel.dns.delegation_unknown', 'Unknown')}</StatusPill>) : '—'}</div></div>
            {summary?.sync?.length > 0 && <div className="stat"><div className="label">{t('panel.dns.cluster_sync', 'Cluster sync')}</div><div className="value" style={{ fontSize: 15 }}>{summary.sync.map((x) => `${x.cluster}: ${x.status}`).join(', ')}</div></div>}
          </div>
        </Card>
      )}
      {selected && <DelegationBanner domain={selected} delegation={delegation} />}
      {zone.data && zone.data.published === false && !elsewhere && (
        <div className="banner banner-info"><Info size={18} /><div><strong>{t('panel.dns.not_served_title', 'Changes are saved, not yet served')}</strong><p>{t('panel.dns.not_served_help', 'The DNS server on this host is not running, so records are kept here and published as soon as it is. Ask your hosting provider if this persists.')}</p></div></div>
      )}
      {selected && (
        <Card title={t('panel.dns.records', 'Records')} padded={false}>
          <PanelCapabilityState error={zoneError} onRetry={zone.refetch} />
          <DataTable columns={columns} rows={rows} loading={zone.loading} error={zoneError && !isCapability(zoneError) ? zoneError : null}
            emptyText={records.length ? t('panel.dns.empty_filter', 'No records match this filter') : t('panel.dns.empty', 'No editable records in this zone yet. Add an A record to point a name at a server, or an MX record for mail.')}
            searchable q={q} onSearch={setQ} searchPlaceholder={t('panel.dns.search', 'Search names and values…')}
            toolbar={(
              <div className="segmented" role="tablist">
                <button type="button" role="tab" aria-selected={typeFilter === 'all'} className={typeFilter === 'all' ? 'active' : ''} onClick={() => setTypeFilter('all')}>{t('panel.dns.filter_all', 'All')} {records.length}</button>
                {types.map((ty) => <button key={ty} type="button" role="tab" aria-selected={typeFilter === ty} className={typeFilter === ty ? 'active' : ''} onClick={() => setTypeFilter(ty)} disabled={!typeCounts[ty]}>{ty} {typeCounts[ty] || 0}</button>)}
              </div>
            )}
            rowActions={(r) => [{ label: t('panel.dns.edit', 'Edit'), primary: true, onClick: () => setEditing(r) }, { label: t('panel.dns.delete', 'Delete'), primary: true, danger: true, onClick: () => remove(r) }]} />
        </Card>
      )}
      {editing && zone.data && <RecordForm zone={zone.data} initial={editing.id ? editing : null} types={types} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </PanelPage>
  );
}
