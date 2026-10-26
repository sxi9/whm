import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions, RadioGroup } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError, InterfaceSelect, FamilyPill, Iproute2Notice } from '../../ip/Shared.jsx';

const EMPTY = { mode: 'single', address: '', endAddress: '', netmask: '', interface: '', reserved: false, reservedReason: '' };

export default function AddANewIpAddress({ fn }) {
  const toast = useToast();
  const { data: current, meta, refetch } = useApi('/ip/addresses');
  const [form, setForm] = useState(EMPTY);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const isV6 = form.address.includes(':');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setResult(null);
    try {
      const body = { address: form.address.trim() };
      if (form.mode === 'range' && form.endAddress) body.endAddress = form.endAddress.trim();
      if (form.netmask.trim()) body.netmask = form.netmask.trim();
      if (form.interface) body.interface = form.interface;
      if (form.reserved) { body.reserved = true; if (form.reservedReason.trim()) body.reservedReason = form.reservedReason.trim(); }
      const { data } = await api.post('/ip/addresses', body);
      setResult(data);
      toast.success(`${data.added.length} address${data.added.length === 1 ? '' : 'es'} added on ${data.interface}`);
      setForm((f) => ({ ...EMPTY, interface: f.interface, netmask: f.netmask }));
      refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Binds one address or a consecutive range to a network interface with iproute2, records it in the panel's inventory and persists it so it is re-added at boot (whm-ips.service). New addresses start free; reserve them to keep them out of allocation." />
      <Iproute2Notice meta={meta} />
      <form onSubmit={submit}>
        <Card title="New IP address">
          <IpRequestError error={error && !error.fields ? error : null} />
          <RadioGroup name="mode" value={form.mode} onChange={set('mode')} options={[{ value: 'single', label: 'Single address', description: 'One IPv4 or IPv6 address' }, { value: 'range', label: 'Range', description: 'Every address from the first to the last (inclusive, up to 256)' }]} />
          <div className="form-grid">
            <Field label={form.mode === 'range' ? 'First address' : 'IP address'} required error={error?.fields?.address}><TextInput value={form.address} onChange={set('address')} placeholder="203.0.113.20 or 2001:db8::20" /></Field>
            {form.mode === 'range' && <Field label="Last address" required error={error?.fields?.endAddress}><TextInput value={form.endAddress} onChange={set('endAddress')} placeholder="203.0.113.30" /></Field>}
            <Field label="Netmask / prefix" help={isV6 ? 'Blank uses /64' : 'Dotted (255.255.255.0) or prefix (/24); blank uses /24'} error={error?.fields?.netmask || error?.fields?.prefix}><TextInput value={form.netmask} onChange={set('netmask')} placeholder={isV6 ? '64' : '255.255.255.0'} /></Field>
            <InterfaceSelect value={form.interface} onChange={set('interface')} family={isV6 ? 6 : 4} error={error?.fields?.interface} />
          </div>
          <Field inline><Toggle checked={form.reserved} onChange={set('reserved')} label="Reserve the new address(es)" description="Reserved addresses are excluded from account allocation until released" /></Field>
          {form.reserved && <Field label="Reservation note" error={error?.fields?.reservedReason}><TextInput value={form.reservedReason} onChange={set('reservedReason')} placeholder="e.g. held for customer X" /></Field>}
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!form.address || (form.mode === 'range' && !form.endAddress)}>Add IP address{form.mode === 'range' ? 'es' : ''}</Button></FormActions>
        </Card>
      </form>
      {result && (
        <Card title="Result">
          <KeyValue items={[
            ['Interface', <code key="i">{result.interface}</code>], ['Prefix', `/${result.prefix}`],
            ['Added', result.added.length], ['Failed', result.failed.length],
            ['Persisted at boot', <StatusPill key="p" status={result.persisted?.skipped ? 'disabled' : result.persisted?.enabled ? 'ok' : result.persisted?.error ? 'failed' : 'warning'}>{result.persisted?.skipped ? 'disabled in settings' : result.persisted?.enabled ? 'whm-ips.service enabled' : result.persisted?.error || 'unit written, not enabled'}</StatusPill>],
          ]} />
          <div className="table-wrap">
            <table>
              <thead><tr><th>Address</th><th>Family</th><th>Bound</th><th>Reserved</th><th>Note</th></tr></thead>
              <tbody>
                {result.added.map((a) => <tr key={a.address}><td><code>{a.address}</code></td><td><FamilyPill family={a.family} /></td><td><StatusPill status={a.bound ? 'ok' : 'warning'}>{a.alreadyBound ? 'already bound' : a.bound ? 'bound' : 'not bound'}</StatusPill></td><td>{a.reserved ? <StatusPill status="warning">reserved</StatusPill> : 'no'}</td><td className="muted">{a.reserved_reason || ''}</td></tr>)}
                {result.failed.map((f) => <tr key={f.address}><td><code>{f.address}</code></td><td colSpan={4}><StatusPill status="failed">{f.code}</StatusPill> {f.error}</td></tr>)}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="Currently bound addresses" subtitle={meta ? `Main IP ${meta.mainIp || 'not set'} · ${current?.length || 0} recorded` : undefined} actions={<Link className="btn btn-sm" to="/ip-functions/show-or-delete-current-ip-addresses">Manage</Link>} padded={false}>
        <DataTable
          columns={[
            { key: 'address', label: 'Address', render: (r) => <code>{r.address}</code> },
            { key: 'family', label: 'Family', render: (r) => <FamilyPill family={r.family} /> },
            { key: 'netmask', label: 'Netmask', render: (r) => r.family === 4 ? r.netmask : `/${r.prefix}` },
            { key: 'interface', label: 'Interface' },
            { key: 'is_main', label: 'Role', render: (r) => r.is_main ? <StatusPill status="info">main</StatusPill> : r.reserved ? <StatusPill status="warning">reserved</StatusPill> : r.dedicated_to ? <StatusPill status="ok">dedicated: {r.dedicated_to}</StatusPill> : <span className="muted">{r.accounts ? `${r.accounts} account(s)` : 'free'}</span> },
          ]}
          rows={current || []} rowKey={(r) => r.address} dense emptyText="No addresses recorded yet. Rebuild the IP address pool to import the host's current addresses."
        />
      </Card>
    </>
  );
}
