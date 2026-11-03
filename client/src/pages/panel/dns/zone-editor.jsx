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

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'];
const HOST_TYPES = new Set(['CNAME', 'MX']);
const CAA_TAGS = [{ value: 'issue', label: 'issue — may issue certificates' }, { value: 'issuewild', label: 'issuewild — may issue wildcard certificates' }, { value: 'iodef', label: 'iodef — where to report violations' }];
const CAA_FLAGS = [{ value: '0', label: '0 — not critical' }, { value: '128', label: '128 — critical' }];

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
  const [form, setForm] = useState(initial ? formFrom(initial) : emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const fqdn = form.name.trim() ? `${form.name.trim()}.${zone.domain}` : zone.domain;
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
    <Modal open title={initial ? `Edit ${initial.type} record` : 'Add a record'} onClose={busy ? undefined : onClose}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="record-form" variant="primary" loading={busy}>{initial ? 'Save record' : 'Add record'}</Button></>}>
      <form id="record-form" onSubmit={submit}>
        {error && !error.fields && (isCapability(error) ? <PanelCapabilityState error={error} /> : <ErrorBanner error={error} />)}
        <div className="form-grid">
          <Field label="Type" required error={error?.fields?.type}>
            <Select value={form.type} onChange={(t) => setForm((f) => ({ ...emptyForm(t), name: f.name, ttl: f.ttl }))} options={types || RECORD_TYPES} disabled={Boolean(initial)} />
          </Field>
          <Field label="Name" help={form.type === 'SRV' ? 'Service and protocol, e.g. _sip._tcp' : `Blank for ${zone.domain} itself; becomes ${fqdn}`} error={error?.fields?.name}>
            <TextInput value={form.name} onChange={set('name')} placeholder={form.type === 'SRV' ? '_sip._tcp' : 'www'} autoFocus spellCheck={false} />
          </Field>
        </div>
        {form.type === 'A' && <Field label="IPv4 address" required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder="203.0.113.10" spellCheck={false} /></Field>}
        {form.type === 'AAAA' && <Field label="IPv6 address" required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder="2001:db8::1" spellCheck={false} /></Field>}
        {form.type === 'CNAME' && <Field label="Points to" required help="A hostname, not an IP address" error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder={zone.domain} spellCheck={false} /></Field>}
        {form.type === 'MX' && (
          <div className="form-grid">
            <Field label="Priority" required help="Lower numbers are tried first" error={error?.fields?.priority}><NumberInput value={form.priority === '' ? null : form.priority} onChange={(v) => set('priority')(v ?? '')} min={0} max={65535} /></Field>
            <Field label="Mail server" required error={valueError}><TextInput value={form.value} onChange={set('value')} placeholder={`mail.${zone.domain}`} spellCheck={false} /></Field>
          </div>
        )}
        {form.type === 'TXT' && <Field label="Text" required help="Quotes are added for you" error={valueError}><Textarea value={form.value} onChange={set('value')} rows={3} mono /></Field>}
        {form.type === 'SRV' && (
          <>
            <div className="form-grid">
              <Field label="Priority" required error={error?.fields?.priority}><NumberInput value={form.priority === '' ? null : form.priority} onChange={(v) => set('priority')(v ?? '')} min={0} max={65535} /></Field>
              <Field label="Weight" required error={valueError}><NumberInput value={form.weight === '' ? null : form.weight} onChange={(v) => set('weight')(v ?? '')} min={0} max={65535} /></Field>
              <Field label="Port" required><NumberInput value={form.port === '' ? null : form.port} onChange={(v) => set('port')(v ?? '')} min={0} max={65535} /></Field>
            </div>
            <Field label="Target" required help="The host that provides the service"><TextInput value={form.target} onChange={set('target')} placeholder={`sip.${zone.domain}`} spellCheck={false} /></Field>
          </>
        )}
        {form.type === 'CAA' && (
          <>
            <div className="form-grid">
              <Field label="Flags"><Select value={form.flags} onChange={set('flags')} options={CAA_FLAGS} /></Field>
              <Field label="Tag"><Select value={form.tag} onChange={set('tag')} options={CAA_TAGS} /></Field>
            </div>
            <Field label={form.tag === 'iodef' ? 'Report address' : 'Certificate authority'} required help={form.tag === 'iodef' ? 'mailto: or https: address' : 'e.g. letsencrypt.org'} error={valueError}>
              <TextInput value={form.value} onChange={set('value')} placeholder={form.tag === 'iodef' ? 'mailto:hostmaster@example.com' : 'letsencrypt.org'} spellCheck={false} />
            </Field>
          </>
        )}
        <Field label="TTL" help={`Seconds, or 1h / 1d; blank uses the zone default of ${zone.ttl ?? 14400} s`} error={error?.fields?.ttl}>
          <TextInput value={form.ttl} onChange={set('ttl')} placeholder="zone default" style={{ maxWidth: 200 }} />
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
  if (!result) return null;
  if (result.applied === false) return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><PendingPill result={result} /><span className="muted">saved as serial {result.serial}</span></span>;
  return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><StatusPill status="ok">Published</StatusPill><span className="muted">serial {result.serial}</span></span>;
}

export function filterRecords(records, type, q) {
  const needle = q.trim().toLowerCase();
  return records.filter((r) => (type === 'all' || r.type === type) && (!needle || `${r.name} ${r.type} ${r.value}`.toLowerCase().includes(needle)));
}

export default function ZoneEditor({ fn }) {
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

  const onSaved = (data) => {
    setEditing(null);
    setLast(data);
    toast.success(data.applied === false ? 'Record saved; it is published once DNS is available on this server' : `Record saved and published (serial ${data.serial})`);
    zone.refetch();
    zones.refetch();
  };
  const remove = async (r) => {
    if (!(await confirm({ title: `Delete this ${r.type} record?`, message: `${r.name === '@' ? selected : `${r.name}.${selected}`}  ${r.type}  ${r.priority ?? ''} ${r.display}`.replace(/\s+/g, ' '), confirmLabel: 'Delete', danger: true }))) return;
    try {
      const res = await panelApi.delete(`/dns/zones/${encodeURIComponent(selected)}/records/${r.id}`);
      setLast(res.data);
      toast.success('Record deleted');
      zone.refetch();
      zones.refetch();
    } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: 'Name', render: (r) => <RecordName name={r.name} domain={selected} /> },
    { key: 'type', label: 'Type', width: 80, render: (r) => <StatusPill status="info">{r.type}</StatusPill> },
    { key: 'ttl', label: 'TTL', width: 90, align: 'right', render: (r) => (r.ttl == null ? <span className="muted">default</span> : r.ttl) },
    { key: 'priority', label: 'Priority', width: 90, align: 'right', render: (r) => (r.priority == null ? <span className="muted">—</span> : r.priority) },
    { key: 'value', label: 'Value', render: (r) => <code style={{ wordBreak: 'break-all' }}>{r.display}</code> },
  ];

  const listError = zones.error;
  const zoneError = zone.error;

  return (
    <PanelPage fn={fn} actions={selected && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>Add record</Button>}>
      <PanelCapabilityState error={listError} onRetry={zones.refetch} />
      {listError && !isCapability(listError) && <ErrorBanner error={listError} onRetry={zones.refetch} />}
      {!zones.loading && !listError && list.length === 0 && (
        <Card>
          <EmptyState title="No DNS zones on this account">
            <p>A zone appears here for every domain whose DNS is hosted on this server. Addon and parked domains can create one when they are added.</p>
          </EmptyState>
        </Card>
      )}
      {list.length > 0 && (
        <Card title={selected} subtitle="Only the records you can change are listed; nameservers and the SOA are managed by your provider."
          actions={(
            <>
              {last && <PublishState result={last} />}
              {list.length > 1 && <Select value={selected || ''} onChange={(d) => setParams({ zone: d })} options={list.map((z) => z.domain)} aria-label="Zone" />}
            </>
          )}>
          <div className="stat-grid">
            <div className="stat"><div className="label">Records</div><div className="value">{summary?.records ?? records.length}</div></div>
            <div className="stat"><div className="label">Default TTL</div><div className="value">{summary?.ttl != null ? `${summary.ttl} s` : '—'}</div></div>
            <div className="stat"><div className="label">Serial</div><div className="value">{summary?.serial ?? '—'}</div></div>
            <div className="stat"><div className="label">Last change</div><div className="value" style={{ fontSize: 15 }}>{summary?.updatedAt ? formatDate(summary.updatedAt) : '—'}</div></div>
            <div className="stat"><div className="label">DNS server</div><div className="value" style={{ fontSize: 15 }}>{zone.data ? (zone.data.published ? <StatusPill status="ok">Serving this zone</StatusPill> : <StatusPill status="pending">Not yet publishing</StatusPill>) : '—'}{summary?.dnssecEnabled && <> <StatusPill status="enabled">DNSSEC</StatusPill></>}</div></div>
            {summary?.sync?.length > 0 && <div className="stat"><div className="label">Cluster sync</div><div className="value" style={{ fontSize: 15 }}>{summary.sync.map((x) => `${x.cluster}: ${x.status}`).join(', ')}</div></div>}
          </div>
        </Card>
      )}
      {zone.data && zone.data.published === false && (
        <div className="banner banner-info"><Info size={18} /><div><strong>Changes are saved, not yet served</strong><p>The DNS server on this host is not running, so records are kept here and published as soon as it is. Ask your hosting provider if this persists.</p></div></div>
      )}
      {selected && (
        <Card title="Records" padded={false}>
          <PanelCapabilityState error={zoneError} onRetry={zone.refetch} />
          <DataTable columns={columns} rows={rows} loading={zone.loading} error={zoneError && !isCapability(zoneError) ? zoneError : null}
            emptyText={records.length ? 'No records match this filter' : 'No editable records in this zone yet. Add an A record to point a name at a server, or an MX record for mail.'}
            searchable q={q} onSearch={setQ} searchPlaceholder="Search names and values…"
            toolbar={(
              <div className="segmented" role="tablist">
                <button type="button" role="tab" aria-selected={typeFilter === 'all'} className={typeFilter === 'all' ? 'active' : ''} onClick={() => setTypeFilter('all')}>All {records.length}</button>
                {types.map((t) => <button key={t} type="button" role="tab" aria-selected={typeFilter === t} className={typeFilter === t ? 'active' : ''} onClick={() => setTypeFilter(t)} disabled={!typeCounts[t]}>{t} {typeCounts[t] || 0}</button>)}
              </div>
            )}
            rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setEditing(r) }, { label: 'Delete', primary: true, danger: true, onClick: () => remove(r) }]} />
        </Card>
      )}
      {editing && zone.data && <RecordForm zone={zone.data} initial={editing.id ? editing : null} types={types} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </PanelPage>
  );
}
