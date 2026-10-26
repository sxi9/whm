import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountSelector, useAccountSelection, Steps, Totals, Warnings, ItemStatus } from '../../multi-account/AccountSelector.jsx';
import { RunPanel, RunHistory } from '../../multi-account/RunPanel.jsx';

const describeItem = (r) => <span><code>{r.before?.ip || 'unset'}</code> → <code>{r.after?.ip || r.steps?.plan?.ip || '—'}</code>{r.steps?.dedicated ? <> <StatusPill status="info">dedicated</StatusPill></> : null}</span>;

export default function ChangeMultipleSitesIpAddresses({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const sel = useAccountSelection();
  const { data: addresses, error: addrError } = useApi('/multi-account/ip/addresses');
  const [targets, setTargets] = useState({});
  const [bulkIp, setBulkIp] = useState('');
  const [options, setOptions] = useState({ updateDns: true, updateVhosts: true, requireDaemons: false });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const step = run ? 3 : preview ? 2 : 1;

  const addressOptions = (addresses || []).map((a) => ({ value: a.address, label: `${a.address}${a.is_main ? ' (main)' : ''}${a.shared ? ' (shared)' : ''}${a.dedicated_to ? ` (dedicated to ${a.dedicated_to})` : ''}${a.reserved ? ' (reserved)' : ''} · ${a.accounts} account(s)`, disabled: !a.selectable }));
  const changes = () => sel.selectedRows.map((r) => ({ username: r.username, ip: targets[r.username] || bulkIp })).filter((c) => c.ip);
  const ready = sel.selectedRows.length > 0 && changes().length === sel.selectedRows.length;

  const runPreview = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post('/multi-account/ip/preview', { changes: changes(), updateDns: options.updateDns, updateVhosts: options.updateVhosts }); setPreview(data); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  const start = async () => {
    const ok = await confirm({
      title: `Change the IP address of ${preview.totals.change} account(s)?`,
      message: `${preview.totals.vhosts} virtual host(s) are rewritten and ${preview.totals.records} A record(s) are updated and published${preview.totals.dedicated ? `; ${preview.totals.dedicated} free address(es) become dedicated` : ''}. Visitors follow once DNS caches expire. ${preview.totals.unchanged ? `${preview.totals.unchanged} account(s) already use the chosen address and are left alone.` : ''}`,
      confirmLabel: 'Change IP addresses', danger: true,
    });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post('/multi-account/ip', { changes: changes(), ...options });
      setRun({ job: data.job, runId: data.run.id });
      toast.info(`Run #${data.run.id} started`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = () => { setRun(null); setPreview(null); setTargets({}); setBulkIp(''); sel.clear(); sel.refetch(); setHistoryKey((k) => k + 1); };

  return (
    <>
      <PageHeader fn={fn} description="Moves several accounts to other IP addresses in one run: pick the accounts, choose a new address per account (or one for all), review the plan, then the job updates each account record, rewrites its virtual hosts through the web server service and the A records of its zones that pointed at the old address. Every account gets its own result line and the run can be downloaded as a report." />
      <Steps step={step} labels={['Select accounts and addresses', 'Review plan', 'Run']} />
      {addrError?.status === 501 ? <CapabilityNotice error={addrError} /> : <ErrorBanner error={addrError} />}
      {error?.status === 501 ? <CapabilityNotice error={error} /> : <ErrorBanner error={error} />}
      {step === 1 && (
        <>
          <AccountSelector sel={sel} extraColumns={[{ key: 'target', label: 'New IP', render: (r) => (sel.selected.includes(r.username) ? <code>{targets[r.username] || bulkIp || '—'}</code> : <span className="muted">—</span>) }]} />
          <Card title="New addresses" subtitle={sel.selectedRows.length ? `${sel.selectedRows.length} account(s) selected` : 'Select accounts above'} padded={false}>
            <div className="card-body">
              <div className="form-grid">
                <Field label="Address for every selected account" help="Per-account choices below override this; addresses come from IP Functions">
                  <Select value={bulkIp} onChange={(v) => { setBulkIp(v); setPreview(null); }} options={addressOptions} placeholder="Choose an address" />
                </Field>
                <Field inline><Toggle checked={options.updateVhosts} onChange={(v) => setOptions((o) => ({ ...o, updateVhosts: v }))} label="Rewrite virtual hosts" description="Through the web server service; stored and applied later when Apache is missing" /></Field>
                <Field inline><Toggle checked={options.updateDns} onChange={(v) => setOptions((o) => ({ ...o, updateDns: v }))} label="Rewrite A records" description="Zones of each account that point at the old address" /></Field>
                <Field inline><Toggle checked={options.requireDaemons} onChange={(v) => setOptions((o) => ({ ...o, requireDaemons: v }))} label="Require installed services" description="Refuse to start when Apache or BIND is missing instead of leaving items pending" /></Field>
              </div>
            </div>
            <DataTable
              columns={[
                { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
                { key: 'domain', label: 'Domain' },
                { key: 'ip', label: 'Current IP', render: (r) => (r.ip ? <code>{r.ip}</code> : <span className="muted">unset</span>) },
                { key: 'target', label: 'New IP', render: (r) => <Select value={targets[r.username] || ''} onChange={(v) => { setTargets((t) => ({ ...t, [r.username]: v })); setPreview(null); }} options={addressOptions.filter((o) => o.value !== r.ip)} placeholder={bulkIp ? `Same as all (${bulkIp})` : 'Choose an address'} /> },
              ]}
              rows={sel.selectedRows} rowKey={(r) => r.username} dense emptyText="No accounts selected."
            />
            <div className="card-body">
              <FormActions>
                <Button variant="primary" loading={busy} disabled={!ready} onClick={runPreview}>Preview changes</Button>
                <Link className="btn" to="/ip-functions/show-ip-address-usage">IP address usage</Link>
              </FormActions>
            </div>
          </Card>
        </>
      )}
      {step === 2 && preview && (
        <Card title="Plan" subtitle={preview.ok ? 'No blocking problems found' : preview.totals.blocked ? 'Fix the problems below before running' : 'Nothing to change'} padded={false}>
          <div className="card-body">
            <Totals items={[['Accounts', preview.totals.accounts], ['To change', preview.totals.change], ['Unchanged', preview.totals.unchanged], ['Blocked', preview.totals.blocked], ['A records', preview.totals.records], ['Virtual hosts', preview.totals.vhosts], ['Become dedicated', preview.totals.dedicated]]} />
            <Warnings warnings={preview.warnings} />
          </div>
          <DataTable
            columns={[
              { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
              { key: 'domain', label: 'Domain' },
              { key: 'from', label: 'Current', render: (r) => (r.from ? <code>{r.from}</code> : <span className="muted">unset</span>) },
              { key: 'to', label: 'New', render: (r) => <span><code>{r.to}</code> {r.dedicated && <StatusPill status="info">becomes dedicated</StatusPill>}</span> },
              { key: 'records', label: 'A records', align: 'right', render: (r) => (r.status === 'change' ? r.records : '—') },
              { key: 'vhosts', label: 'Vhosts', align: 'right', render: (r) => (r.status === 'change' ? r.vhosts : '—') },
              { key: 'status', label: 'Status', render: (r) => <ItemStatus status={r.status} /> },
              { key: 'issues', label: 'Problems', render: (r) => (r.issues.length ? r.issues.map((i) => <div key={i} className="field-message">{i}</div>) : <span className="muted">none</span>) },
            ]}
            rows={preview.items.map((it, i) => ({ ...it, key: i }))} rowKey={(r) => r.key} dense
          />
          <div className="card-body">
            <FormActions>
              <Button onClick={() => setPreview(null)}>Back</Button>
              <Button variant="danger" loading={busy} disabled={!preview.ok} onClick={start}>Change IP addresses now</Button>
            </FormActions>
          </div>
        </Card>
      )}
      {step === 3 && run && <RunPanel job={run.job} runId={run.runId} title="Changing IP addresses" describeItem={describeItem} onReset={reset} onFinished={() => setHistoryKey((k) => k + 1)} />}
      <RunHistory kind="change_ip" describeItem={describeItem} refreshKey={historyKey} />
    </>
  );
}
