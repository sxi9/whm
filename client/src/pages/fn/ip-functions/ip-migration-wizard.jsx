import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Toggle, Button, FormActions, Select } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { IpRequestError, InterfaceSelect, Summary } from '../../ip/Shared.jsx';

const DEFAULT_OPTIONS = { updateDns: true, updateVhosts: true, removeOld: false, interface: '', prefix: '' };

export default function IpMigrationWizard({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: addresses } = useApi('/ip/addresses?live=false');
  const { data: history, refetch: refetchHistory } = useApi('/ip/migration/history');
  const [rows, setRows] = useState([{ from: '', to: '' }]);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const step = job ? 3 : preview ? 2 : 1;

  const update = (i, patch) => { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); setPreview(null); };
  const mappings = () => rows.map((r) => ({ from: r.from.trim(), to: r.to.trim() })).filter((r) => r.from && r.to);
  const body = (dryRun) => {
    const b = { mappings: mappings(), dryRun, updateDns: options.updateDns, updateVhosts: options.updateVhosts, removeOld: options.removeOld };
    if (options.interface) b.interface = options.interface;
    if (options.prefix !== '' && options.prefix != null) b.prefix = Number(options.prefix);
    return b;
  };

  const runPreview = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post('/ip/migration/preview', { mappings: mappings() }); setPreview(data); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const start = async (dryRun) => {
    if (!dryRun) {
      const main = preview.plan.filter((p) => p.isMain).map((p) => `${p.from} → ${p.to}`);
      const ok = await confirm({
        title: 'Start the IP migration?',
        message: `${preview.totals.accounts} account(s) and ${preview.totals.dnsRecords} DNS record(s) are rewritten${preview.totals.newAddressesToBind ? `, ${preview.totals.newAddressesToBind} new address(es) bound` : ''}${main.length ? `. The main IP changes (${main.join(', ')})` : ''}. ${options.removeOld ? 'Old addresses are removed from the interfaces.' : 'Old addresses stay bound and are marked reserved.'}`,
        confirmLabel: 'Migrate', danger: true, typeToConfirm: 'MIGRATE',
      });
      if (!ok) return;
    }
    setBusy(true); setError(null);
    try { const { data } = await api.post('/ip/migration', body(dryRun)); setJob({ id: data.job.id, dryRun }); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = () => { setJob(null); setPreview(null); setRows([{ from: '', to: '' }]); setOptions(DEFAULT_OPTIONS); refetchHistory(); };

  const known = (addresses || []).map((a) => a.address);
  return (
    <>
      <PageHeader fn={fn} description="Renumbers the server: every account on an old address moves to the new one, A/AAAA records carrying the old address are rewritten and published, virtual hosts are updated through the web server service, Basic Setup and remote-service IPs follow, and new addresses are bound and persisted. Preview first, then dry-run or migrate." />
      <div className="row-actions" style={{ marginBottom: 14 }}>
        {['1. Map addresses', '2. Review plan', '3. Run'].map((label, i) => <span key={label} className={`pill ${step === i + 1 ? 'pill-info' : step > i + 1 ? 'pill-ok' : 'pill-muted'}`}>{label}</span>)}
      </div>
      <IpRequestError error={error} />
      {step < 3 && (
        <Card title="Address mappings" subtitle="Old address → new address. Several mappings run in order." actions={<Button size="sm" icon={Plus} onClick={() => setRows((rs) => [...rs, { from: '', to: '' }])}>Add mapping</Button>} padded={false}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Old address</th><th>New address</th><th style={{ width: 60 }} /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <div className="input-group">
                        <TextInput value={r.from} onChange={(v) => update(i, { from: v })} placeholder="203.0.113.10" list="whm-known-ips" />
                      </div>
                    </td>
                    <td><TextInput value={r.to} onChange={(v) => update(i, { to: v })} placeholder="198.51.100.10" /></td>
                    <td><button className="btn btn-sm btn-icon btn-danger-ghost" disabled={rows.length === 1} onClick={() => { setRows((rs) => rs.filter((_r, j) => j !== i)); setPreview(null); }} aria-label="Remove mapping"><Trash2 size={14} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="whm-known-ips">{known.map((a) => <option key={a} value={a} />)}</datalist>
          <div className="card-body">
            <div className="form-grid">
              <Field inline><Toggle checked={options.updateDns} onChange={(v) => setOptions((o) => ({ ...o, updateDns: v }))} label="Rewrite DNS records" description="A/AAAA records carrying the old address, published through BIND" /></Field>
              <Field inline><Toggle checked={options.updateVhosts} onChange={(v) => setOptions((o) => ({ ...o, updateVhosts: v }))} label="Rewrite virtual hosts" description="Through the web server service when it is installed" /></Field>
              <Field inline><Toggle checked={options.removeOld} onChange={(v) => setOptions((o) => ({ ...o, removeOld: v }))} label="Remove old addresses" description="Off: the old address stays bound and is marked reserved" /></Field>
            </div>
            <div className="form-grid">
              <InterfaceSelect value={options.interface} onChange={(v) => setOptions((o) => ({ ...o, interface: v }))} label="Interface for new addresses" help="Blank reuses the old address's interface" />
              <Field label="Prefix for new addresses" help="Blank reuses the old address's netmask"><Select value={options.prefix} onChange={(v) => setOptions((o) => ({ ...o, prefix: v }))} options={['24', '25', '26', '27', '28', '29', '30', '32', '48', '56', '64', '128'].map((p) => ({ value: p, label: `/${p}` }))} placeholder="Same as old" /></Field>
            </div>
            <FormActions><Button variant="primary" loading={busy} disabled={!mappings().length} onClick={runPreview}>Preview migration</Button></FormActions>
          </div>
        </Card>
      )}
      {step === 2 && preview && (
        <Card title="Migration plan" subtitle={preview.ok ? 'No blocking problems found' : 'Fix the problems below before running'}>
          <Summary items={[['Mappings', preview.totals.mappings], ['Accounts', preview.totals.accounts], ['DNS records', preview.totals.dnsRecords], ['New addresses to bind', preview.totals.newAddressesToBind], ['Main IP changes', preview.totals.mainIpChanges]]} />
          <KeyValue items={[
            ['iproute2', <StatusPill key="i" status={preview.iproute2 ? 'ok' : 'failed'}>{preview.iproute2 ? 'installed' : 'missing — new addresses cannot be bound'}</StatusPill>],
            ['DNS service', <StatusPill key="d" status={preview.dnsService ? 'ok' : 'warning'}>{preview.dnsService ? 'available' : 'unavailable'}</StatusPill>],
            ['Web server service', <StatusPill key="w" status={preview.web === 'available' ? 'ok' : 'warning'}>{preview.web === 'available' ? 'available' : 'not installed — vhosts unchanged'}</StatusPill>],
          ]} />
          {preview.warnings.length > 0 && <div className="banner banner-warning"><div><strong>Warnings</strong><ul>{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Old</th><th>New</th><th>Accounts</th><th>DNS records</th><th>Flags</th><th>Problems</th></tr></thead>
              <tbody>
                {preview.plan.map((p) => (
                  <tr key={`${p.from}>${p.to}`}>
                    <td><code>{p.from}</code></td>
                    <td><code>{p.to}</code> <StatusPill status={p.toBound ? 'ok' : 'pending'}>{p.toBound ? 'bound' : 'will bind'}</StatusPill></td>
                    <td>{p.accounts.length ? p.accounts.join(', ') : <span className="muted">none</span>}</td>
                    <td>{p.dns.length ? <span className="muted">{[...new Set(p.dns.map((d) => d.domain))].join(', ')} ({p.dns.length})</span> : <span className="muted">none</span>}</td>
                    <td>{p.isMain && <StatusPill status="info">main IP</StatusPill>} {p.isShared && <StatusPill status="info">shared IP</StatusPill>} {p.ipv6Account && <StatusPill status="info">IPv6 of {p.ipv6Account}</StatusPill>} {!p.fromBound && <StatusPill status="warning">old not bound</StatusPill>}</td>
                    <td>{p.issues.length ? p.issues.map((i) => <div key={i} className="field-message">{i}</div>) : <StatusPill status="ok">ok</StatusPill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FormActions>
            <Button onClick={() => setPreview(null)}>Back</Button>
            <Button loading={busy} disabled={!preview.ok} onClick={() => start(true)}>Dry run</Button>
            <Button variant="danger" loading={busy} disabled={!preview.ok} onClick={() => start(false)}>Migrate now</Button>
          </FormActions>
        </Card>
      )}
      {step === 3 && job && (
        <Card title={job.dryRun ? 'Dry run' : 'Migration in progress'}>
          <ProgressLog jobId={job.id} onFinished={(ev) => { refetchHistory(); if (ev.type === 'done') toast.success(job.dryRun ? 'Dry run finished' : 'Migration finished'); else toast.error(ev.error || 'Migration failed'); }} />
          <FormActions>
            {job.dryRun && <Button variant="primary" onClick={() => setJob(null)}>Back to plan</Button>}
            <Button onClick={reset}>Start another migration</Button>
            <Link className="btn" to="/ip-functions/show-ip-address-usage">Show IP usage</Link>
          </FormActions>
        </Card>
      )}
      <Card title="Recent migrations" padded={false}>
        <DataTable
          columns={[
            { key: 'id', label: 'Job', render: (j) => `#${j.id}` },
            { key: 'mappings', label: 'Mappings', render: (j) => j.mappings.map((m) => <div key={m.from}><code>{m.from}</code> → <code>{m.to}</code></div>) },
            { key: 'dryRun', label: 'Mode', render: (j) => <StatusPill status={j.dryRun ? 'info' : 'ok'}>{j.dryRun ? 'dry run' : 'migration'}</StatusPill> },
            { key: 'status', label: 'Status', render: (j) => <StatusPill status={j.status} /> },
            { key: 'result', label: 'Result', render: (j) => j.result ? <span className="muted">{j.result.accounts} accounts · {j.result.dnsRecords} DNS · {j.result.bound} bound · {j.result.failed} failed</span> : j.error ? <span className="muted">{j.error}</span> : '' },
            { key: 'created_at', label: 'Started', render: (j) => formatDate(j.created_at) },
          ]}
          rows={history || []} rowKey={(j) => j.id} dense emptyText="No migrations yet."
        />
      </Card>
    </>
  );
}
