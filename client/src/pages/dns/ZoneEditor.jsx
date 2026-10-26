import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, StatusPill, KeyValue, CapabilityNotice, Loading, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Textarea, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { PublishBadge, publishMessage } from './ZonePicker.jsx';

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR'];
const VALUE_HELP = {
  A: 'IPv4 address, e.g. 203.0.113.10', AAAA: 'IPv6 address, e.g. 2001:db8::1', CNAME: 'Target hostname, e.g. example.com', MX: 'Mail exchanger hostname, e.g. mail.example.com',
  TXT: 'Text; quotes are added automatically', SRV: 'weight port target, e.g. 10 5060 sip.example.com', NS: 'Nameserver hostname', CAA: 'flags tag value, e.g. 0 issue letsencrypt.org', PTR: 'Target hostname',
};
const EMPTY = { name: '', type: 'A', ttl: '', priority: '', value: '' };

export function RecordForm({ domain, initial, onSaved, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState(initial ? { ...EMPTY, ...initial, ttl: initial.ttl ?? '', priority: initial.priority ?? '' } : EMPTY);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const needsPriority = ['MX', 'SRV'].includes(form.type);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const body = { name: form.name || '@', type: form.type, value: form.value, ttl: form.ttl === '' ? null : form.ttl };
    if (needsPriority) body.priority = form.priority === '' ? null : Number(form.priority);
    try {
      const { data } = initial?.id ? await api.put(`/dns/zones/${domain}/records/${initial.id}`, body) : await api.post(`/dns/zones/${domain}/records`, body);
      toast.success(publishMessage(data, initial?.id ? 'Record updated' : 'Record added'));
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <CapabilityNotice error={error} />
      <div className="form-grid">
        <Field label="Name" required help={`Relative to ${domain}; use @ for the zone itself`} error={error?.fields?.name}><TextInput value={form.name} onChange={set('name')} placeholder="@ or www" autoFocus /></Field>
        <Field label="Type" required error={error?.fields?.type}><Select value={form.type} onChange={set('type')} options={RECORD_TYPES} /></Field>
        <Field label="TTL" help="Seconds (or 1h, 1d); blank = zone default" error={error?.fields?.ttl}><TextInput value={form.ttl} onChange={set('ttl')} placeholder="zone default" /></Field>
        {needsPriority && <Field label="Priority" required help="Lower is preferred" error={error?.fields?.priority}><NumberInput value={form.priority === '' ? null : form.priority} onChange={(v) => set('priority')(v ?? '')} min={0} max={65535} /></Field>}
      </div>
      <Field label="Value" required help={VALUE_HELP[form.type]} error={error?.fields?.value}>
        {form.type === 'TXT' ? <Textarea value={form.value} onChange={set('value')} rows={3} mono /> : <TextInput value={form.value} onChange={set('value')} />}
      </Field>
      <FormActions>
        <Button type="submit" variant="primary" loading={saving}>{initial?.id ? 'Save record' : 'Add record'}</Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </FormActions>
    </form>
  );
}

function SoaForm({ domain, soa, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ primary: soa.primary, hostmaster: soa.hostmaster, refresh: soa.refresh, retry: soa.retry, expire: soa.expire, minimum: soa.minimum });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm({ primary: soa.primary, hostmaster: soa.hostmaster, refresh: soa.refresh, retry: soa.retry, expire: soa.expire, minimum: soa.minimum }), [soa]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const { data } = await api.put(`/dns/zones/${domain}/soa`, { ...form, primary: form.primary.replace(/\.$/, ''), hostmaster: form.hostmaster.replace(/\.$/, '') });
      toast.success(publishMessage(data, 'SOA updated'));
      onSaved?.(data);
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  return (
    <form onSubmit={save}>
      <ErrorBanner error={error && !error.fields ? error : null} />
      <div className="form-grid">
        <Field label="Primary nameserver" error={error?.fields?.primary}><TextInput value={form.primary} onChange={set('primary')} /></Field>
        <Field label="Hostmaster (email as a name)" help="hostmaster.example.com = hostmaster@example.com" error={error?.fields?.hostmaster}><TextInput value={form.hostmaster} onChange={set('hostmaster')} /></Field>
        <Field label="Refresh" error={error?.fields?.refresh}><NumberInput value={form.refresh} onChange={set('refresh')} nullable={false} min={0} /></Field>
        <Field label="Retry" error={error?.fields?.retry}><NumberInput value={form.retry} onChange={set('retry')} nullable={false} min={0} /></Field>
        <Field label="Expire" error={error?.fields?.expire}><NumberInput value={form.expire} onChange={set('expire')} nullable={false} min={0} /></Field>
        <Field label="Minimum (negative cache TTL)" error={error?.fields?.minimum}><NumberInput value={form.minimum} onChange={set('minimum')} nullable={false} min={0} /></Field>
      </div>
      <FormActions><Button type="submit" variant="primary" loading={saving}>Save SOA</Button></FormActions>
    </form>
  );
}

function RawEditor({ domain, onSaved }) {
  const toast = useToast();
  const [state, setState] = useState({ loading: true, body: '', onDisk: null, inSync: null });
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = async () => {
    setState((s) => ({ ...s, loading: true }));
    try { const { data } = await api.get(`/dns/zones/${domain}/raw`); setState({ loading: false, body: data.body, onDisk: data.onDisk, inSync: data.inSync }); } catch (err) { setError(err); setState((s) => ({ ...s, loading: false })); }
  };
  useEffect(() => { load(); }, [domain]); // eslint-disable-line react-hooks/exhaustive-deps
  const validate = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post(`/dns/zones/${domain}/validate`, { body: state.body }); setCheck(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.put(`/dns/zones/${domain}/raw`, { body: state.body }); toast.success(publishMessage(data, 'Zone saved')); setCheck(null); await load(); onSaved?.(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  if (state.loading && !state.body) return <Loading />;
  return (
    <>
      <p className="muted">Edit the zone as a BIND master file. On save it is validated (named-checkzone when BIND is installed), parsed into records and re-rendered, so comments are not preserved. The serial is bumped automatically.</p>
      {state.inSync === false && <div className="banner banner-warning"><div><strong>The file on disk differs from the database.</strong><p>Saving (or Re-publish on the Records tab) rewrites the file from the panel's records.</p></div></div>}
      <Textarea value={state.body} onChange={(v) => { setState((s) => ({ ...s, body: v })); setCheck(null); }} rows={22} mono spellCheck={false} />
      <ErrorBanner error={error && !error.fields ? error : null} />
      {error?.fields?.body && <div className="banner banner-error"><div><strong>Zone text is not valid</strong><ul>{error.fields.body.map((e, i) => <li key={i}>{e}</li>)}</ul></div></div>}
      {check && (
        <div className={`banner ${check.ok ? 'banner-success' : 'banner-error'}`}>
          <div>
            <strong>{check.ok ? `Valid: ${check.records} record(s), serial ${check.serial ?? 'n/a'}` : 'Validation failed'}</strong>
            {check.errors.length > 0 && <ul>{check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
            {check.checkzone?.output && <pre className="log">{check.checkzone.output}</pre>}
            {check.checkzone === null && <p className="muted">named-checkzone is not available on this host; only the panel's parser ran.</p>}
          </div>
        </div>
      )}
      <FormActions>
        <Button onClick={validate} loading={busy}>Validate</Button>
        <Button variant="primary" onClick={save} loading={busy}>Save zone</Button>
        <Button onClick={load} disabled={busy}>Reload from server</Button>
      </FormActions>
    </>
  );
}

const age = (s) => (s == null ? 'unknown age' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} day(s) ago`);

function DnssecKeys({ status }) {
  const { data, error, loading, refetch } = status;
  if (loading && !data) return <Loading text="Reading keys from the BIND host…" />;
  if (error) return <><CapabilityNotice error={error} onRetry={refetch} />{error.code !== 'capability_missing' && <ErrorBanner error={error} onRetry={refetch} />}</>;
  if (!data) return null;
  return (
    <>
      {!data.keys && <div className="banner banner-error"><div><strong>No DNSSEC keys found on disk</strong><p>The zone is flagged as signed but {data.keyDir || 'the key directory'} holds no KSK/ZSK. Disable and re-enable DNSSEC to generate new keys (then publish the new DS).</p></div></div>}
      {data.signed && (
        <KeyValue items={[
          ['Signed zone', data.signed.exists ? <code key="p">{data.signed.path}</code> : 'not written yet'],
          ['Signed', data.signed.exists ? `${age(data.signed.ageSeconds)}${data.signed.stale ? ' (older than the zone file; re-publish)' : ''}` : '—'],
          ['Signed serial', data.signed.serial ?? '—'],
          ['Key directory', data.keyDir ? <code key="k">{data.keyDir}</code> : null],
        ]} />
      )}
      {data.ds.length > 0 && <><h3>DS record(s) for your registrar</h3><pre className="log">{data.ds.join('\n')}</pre></>}
      {data.keys && data.ds.length === 0 && <p className="muted">dnssec-dsfromkey is not installed on the BIND host; derive the DS from the KSK below.</p>}
      {data.dnskey && <><h3>DNSKEY</h3><pre className="log">{[data.dnskey.ksk, data.dnskey.zsk].filter(Boolean).join('\n')}</pre></>}
      <FormActions><Button size="sm" onClick={refetch} loading={loading}>Refresh</Button></FormActions>
    </>
  );
}

export function ZoneEditor({ domain, zone, loading, error, refetch, setData }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [tab, setTab] = useState('records');
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('');
  const [lastResult, setLastResult] = useState(null);
  // Keys live on the BIND host; GET /dnssec reads DS/DNSKEY back whenever the
  // zone is signed, so a reload never loses the DS the registrar needs.
  const isRoot = user.role === 'root';
  const dnssec = useApi(domain && isRoot && zone?.dnssec_enabled ? `/dns/zones/${encodeURIComponent(domain)}/dnssec` : null, { enabled: Boolean(domain && isRoot && zone?.dnssec_enabled) });

  useEffect(() => { setEditing(null); setLastResult(null); setTab('records'); }, [domain]);

  const onSaved = (result) => { setLastResult(result); setEditing(null); refetch(); };
  const remove = async (r) => {
    if (!(await confirm({ title: `Delete ${r.type} record?`, message: `${r.name === '@' ? domain : `${r.name}.${domain}`}  ${r.type}  ${r.priority ?? ''} ${r.value}`, confirmLabel: 'Delete', danger: true }))) return;
    try { const { data } = await api.delete(`/dns/zones/${domain}/records/${r.id}`); toast.success(publishMessage(data, 'Record deleted')); onSaved(data); } catch (err) { toast.error(err); }
  };
  const republish = async () => {
    try { const { data } = await api.post(`/dns/zones/${domain}/apply`); toast.success(publishMessage(data, 'Zone re-rendered')); setLastResult(data); } catch (err) { toast.error(err); }
  };
  const toggleDnssec = async (enabled) => {
    if (enabled && !(await confirm({ title: 'Enable DNSSEC?', message: 'Keys are generated with dnssec-keygen and the zone is signed on every change. You must publish the DS record at your registrar for validation to work.', confirmLabel: 'Enable' }))) return;
    if (!enabled && !(await confirm({ title: 'Disable DNSSEC?', message: 'The keys and the signed zone are deleted. Remove the DS record at your registrar first, or resolvers will treat the zone as bogus.', confirmLabel: 'Disable', danger: true }))) return;
    try { const { data } = await api.put(`/dns/zones/${domain}/dnssec`, { enabled }); setLastResult(data); toast.success(enabled ? 'DNSSEC enabled; publish the DS record at your registrar' : 'DNSSEC disabled'); refetch(); } catch (err) { toast.error(err); }
  };

  if (loading && !zone) return <Loading />;
  if (error) return <><CapabilityNotice error={error} onRetry={refetch} />{error.code !== 'capability_missing' && <ErrorBanner error={error} onRetry={refetch} />}</>;
  if (!zone) return null;
  const rows = (zone.records || []).filter((r) => !filter || `${r.name} ${r.type} ${r.value}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <Card title={zone.domain} subtitle={`${zone.account ? `Account ${zone.account}` : 'No account owns this zone'} · updated ${formatDate(zone.updated_at)}`}
        actions={(
          <>
            <StatusPill status={zone.published ? 'ok' : 'warning'}>{zone.published ? 'BIND installed' : 'BIND not installed'}</StatusPill>
            <PublishBadge result={lastResult} />
            <Button size="sm" onClick={republish}>Re-publish zone</Button>
          </>
        )}>
        <KeyValue items={[['Serial', <code key="s">{zone.serial}</code>], ['Default TTL', `${zone.ttl}s`], ['Records', zone.records.length], ['DNSSEC', <StatusPill key="d" status={zone.dnssec_enabled ? 'enabled' : 'disabled'}>{zone.dnssec_enabled ? 'Signed' : 'Off'}</StatusPill>]]} />
        <div className="form-actions" style={{ marginTop: 12 }}>
          {['records', 'soa', 'raw', 'dnssec'].map((t) => <Button key={t} size="sm" variant={tab === t ? 'primary' : 'default'} onClick={() => setTab(t)}>{{ records: 'Records', soa: 'SOA', raw: 'Raw zone file', dnssec: 'DNSSEC' }[t]}</Button>)}
        </div>
      </Card>

      {tab === 'records' && (
        <Card title="Records" padded={false} actions={<Button size="sm" variant="primary" onClick={() => setEditing({})}>Add record</Button>}>
          <DataTable
            columns={[
              { key: 'name', label: 'Name', render: (r) => <code>{r.name === '@' ? zone.domain : `${r.name}.${zone.domain}`}</code> },
              { key: 'ttl', label: 'TTL', width: 90, render: (r) => r.ttl ?? <span className="muted">{zone.ttl}</span> },
              { key: 'type', label: 'Type', width: 80, render: (r) => <StatusPill status="info">{r.type}</StatusPill> },
              { key: 'priority', label: 'Priority', width: 80, render: (r) => r.priority ?? '' },
              { key: 'value', label: 'Value', render: (r) => <span style={{ wordBreak: 'break-all', fontFamily: 'var(--mono)', fontSize: 12 }}>{r.value}</span> },
            ]}
            rows={rows} rowKey={(r) => r.id} emptyText="No records besides the SOA." dense
            toolbar={<TextInput value={filter} onChange={setFilter} placeholder="Filter records" style={{ width: 220 }} />}
            rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setEditing(r) }, { label: 'Delete', danger: true, onClick: () => remove(r) }]}
          />
        </Card>
      )}
      {tab === 'soa' && <Card title="Start of Authority" subtitle={`Serial ${zone.soa.serial} is managed automatically (YYYYMMDDnn).`}><SoaForm domain={zone.domain} soa={zone.soa} onSaved={onSaved} /></Card>}
      {tab === 'raw' && <Card title="Raw zone file"><RawEditor domain={zone.domain} onSaved={onSaved} /></Card>}
      {tab === 'dnssec' && (
        <Card title="DNSSEC">
          {!isRoot ? <p className="muted">Only the root administrator can change DNSSEC settings.</p> : (
            <>
              <Field inline><Toggle checked={zone.dnssec_enabled} onChange={toggleDnssec} label="Sign this zone with DNSSEC" description="Generates ECDSA P-256 KSK/ZSK keys and signs the zone file with dnssec-signzone on every change; the signed zone keeps the panel's serial." /></Field>
              {zone.dnssec_enabled && <DnssecKeys status={dnssec} />}
            </>
          )}
        </Card>
      )}

      <Modal open={Boolean(editing)} title={editing?.id ? `Edit ${editing.type} record` : 'Add record'} onClose={() => setEditing(null)} size="md">
        {editing && <RecordForm domain={zone.domain} initial={editing.id ? editing : null} onSaved={onSaved} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
