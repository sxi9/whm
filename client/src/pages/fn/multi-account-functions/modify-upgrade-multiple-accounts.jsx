import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, CapabilityNotice, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountSelector, useAccountSelection, Steps, Totals, Warnings, ItemStatus } from '../../multi-account/AccountSelector.jsx';
import { RunPanel, RunHistory } from '../../multi-account/RunPanel.jsx';

const SHELLS = ['/bin/bash', '/bin/sh', '/usr/sbin/nologin', '/usr/local/bin/jailshell'];
const FIELDS = [
  { key: 'package', label: 'Package', help: 'Re-applies the package limits (disk, bandwidth, shell, PHP version)' },
  { key: 'diskQuotaMb', label: 'Disk quota (MB)', help: 'Blank = unlimited; a package choice overrides this' },
  { key: 'bandwidthLimitMb', label: 'Bandwidth limit (MB)', help: 'Blank = unlimited; a package choice overrides this' },
  { key: 'shell', label: 'Shell' },
  { key: 'contactEmail', label: 'Contact email', help: 'Blank clears the address' },
  { key: 'demoMode', label: 'Demo mode' },
  { key: 'forcePasswordChange', label: 'Force password change' },
  { key: 'owner', label: 'Owner', rootOnly: true },
];
const fmt = (field, v) => (v == null ? (field === 'contactEmail' ? '—' : ['diskQuotaMb', 'bandwidthLimitMb'].includes(field) ? 'unlimited' : '—') : typeof v === 'boolean' ? (v ? 'on' : 'off') : ['diskQuotaMb', 'bandwidthLimitMb'].includes(field) ? formatMb(v) : String(v));
const describeItem = (r) => (r.steps?.plan?.changes?.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{r.steps.plan.changes.map((c) => <li key={c.field}>{c.label}: {fmt(c.field, c.from)} → <strong>{fmt(c.field, c.to)}</strong></li>)}</ul> : null);

export default function ModifyUpgradeMultipleAccounts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const sel = useAccountSelection();
  const { data: packages } = useApi('/packages?pageSize=500');
  const [enabled, setEnabled] = useState({});
  const [values, setValues] = useState({ package: '', diskQuotaMb: null, bandwidthLimitMb: null, shell: '/bin/bash', contactEmail: '', demoMode: false, forcePasswordChange: false, owner: '' });
  const [options, setOptions] = useState({ applyPhp: true, requireDaemons: false });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const step = run ? 3 : preview ? 2 : 1;

  const changes = () => {
    const out = {};
    for (const f of FIELDS) {
      if (!enabled[f.key]) continue;
      const v = values[f.key];
      if (f.key === 'contactEmail') out[f.key] = v ? v : null;
      else if (['package', 'owner', 'shell'].includes(f.key)) { if (v) out[f.key] = v; }
      else out[f.key] = v;
    }
    return out;
  };
  const toggle = (key, on) => { setEnabled((e) => ({ ...e, [key]: on })); setPreview(null); };
  const setValue = (key, v) => { setValues((s) => ({ ...s, [key]: v })); setPreview(null); };
  const body = () => ({ usernames: sel.selected, changes: changes(), applyPhp: options.applyPhp });
  const ready = sel.selected.length > 0 && Object.keys(changes()).length > 0;

  const runPreview = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post('/multi-account/modify/preview', body()); setPreview(data); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  const start = async () => {
    const summary = Object.entries(preview.changes).map(([k, v]) => `${FIELDS.find((f) => f.key === k)?.label || k} → ${fmt(k, v)}`).join(', ');
    const ok = await confirm({ title: `Modify ${preview.totals.change} account(s)?`, message: `${summary}. Limits are applied to the Linux user (quota, shell) and, for a package with a PHP version, to the virtual hosts. ${preview.totals.unchanged ? `${preview.totals.unchanged} account(s) already have these values and are left alone.` : ''}`, confirmLabel: 'Modify accounts', danger: true });
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post('/multi-account/modify', { ...body(), requireDaemons: options.requireDaemons });
      setRun({ job: data.job, runId: data.run.id });
      toast.info(`Run #${data.run.id} started`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = () => { setRun(null); setPreview(null); sel.clear(); sel.refetch(); setHistoryKey((k) => k + 1); };

  const owners = sel.meta?.filters?.owners || [];
  const pkg = (packages || []).find((p) => p.name === values.package);
  const control = (f) => {
    switch (f.key) {
      case 'package': return <Select value={values.package} onChange={(v) => setValue('package', v)} options={(packages || []).map((p) => ({ value: p.name, label: `${p.name} — ${formatMb(p.disk_mb)} disk, ${formatMb(p.bandwidth_mb)} bandwidth${p.php_version ? `, PHP ${p.php_version}` : ''}` }))} placeholder="Select a package" />;
      case 'diskQuotaMb': return <NumberInput value={values.diskQuotaMb} onChange={(v) => setValue('diskQuotaMb', v)} min={0} placeholder="Unlimited" />;
      case 'bandwidthLimitMb': return <NumberInput value={values.bandwidthLimitMb} onChange={(v) => setValue('bandwidthLimitMb', v)} min={0} placeholder="Unlimited" />;
      case 'shell': return <Select value={values.shell} onChange={(v) => setValue('shell', v)} options={SHELLS} />;
      case 'contactEmail': return <TextInput value={values.contactEmail} onChange={(v) => setValue('contactEmail', v)} type="email" placeholder="owner@example.com" />;
      case 'demoMode': return <Toggle checked={values.demoMode} onChange={(v) => setValue('demoMode', v)} label={values.demoMode ? 'Enable demo mode' : 'Disable demo mode'} />;
      case 'forcePasswordChange': return <Toggle checked={values.forcePasswordChange} onChange={(v) => setValue('forcePasswordChange', v)} label={values.forcePasswordChange ? 'Require a new password at next login' : 'Clear the requirement'} />;
      case 'owner': return <><TextInput value={values.owner} onChange={(v) => setValue('owner', v)} placeholder="root or a reseller username" list="whm-owner-names" /><datalist id="whm-owner-names">{['root', ...owners].filter((o, i, a) => a.indexOf(o) === i).map((o) => <option key={o} value={o} />)}</datalist></>;
      default: return null;
    }
  };

  return (
    <>
      <PageHeader fn={fn} description="Applies the same changes to many accounts in one run: move them to another package (its limits, shell and PHP version follow), set disk or bandwidth limits, shell, contact address, demo mode, forced password change or owner. Review the per-account differences first; every account is modified on its own and reported separately, and the run can be downloaded as a report." />
      <Steps step={step} labels={['Select accounts and changes', 'Review differences', 'Run']} />
      {error?.status === 501 ? <CapabilityNotice error={error} /> : <ErrorBanner error={error} />}
      {step === 1 && (
        <>
          <AccountSelector sel={sel} />
          <Card title="Changes to apply" subtitle="Tick a field to include it; untouched fields keep their per-account value">
            <div className="form-grid">
              {FIELDS.filter((f) => !f.rootOnly || user.role === 'root').map((f) => (
                <Field key={f.key} label={f.label} help={enabled[f.key] ? f.help : undefined} error={error?.fields?.[`changes.${f.key}`]}>
                  <Toggle checked={Boolean(enabled[f.key])} onChange={(on) => toggle(f.key, on)} label={enabled[f.key] ? 'Change' : 'Keep per-account value'} />
                  {enabled[f.key] && <div style={{ marginTop: 6 }}>{control(f)}</div>}
                </Field>
              ))}
            </div>
            {enabled.package && pkg && <p className="muted">Package <strong>{pkg.name}</strong>: {formatMb(pkg.disk_mb)} disk · {formatMb(pkg.bandwidth_mb)} bandwidth · shell {pkg.has_shell ? 'yes' : 'no'} · PHP {pkg.php_version || 'server default'} · {pkg.max_addons ?? 'unlimited'} addon domains · {pkg.max_db ?? 'unlimited'} databases</p>}
            <div className="form-grid">
              <Field inline><Toggle checked={options.applyPhp} onChange={(v) => setOptions((o) => ({ ...o, applyPhp: v }))} label="Apply the package's PHP version to the virtual hosts" description="Only when a package is chosen and it pins a PHP version" /></Field>
              <Field inline><Toggle checked={options.requireDaemons} onChange={(v) => setOptions((o) => ({ ...o, requireDaemons: v }))} label="Require installed services" description="Refuse to start when quota tools or Apache are missing instead of leaving items pending" /></Field>
            </div>
            <FormActions><Button variant="primary" loading={busy} disabled={!ready} onClick={runPreview}>Preview differences</Button></FormActions>
          </Card>
        </>
      )}
      {step === 2 && preview && (
        <Card title="Differences" subtitle={preview.ok ? 'No blocking problems found' : preview.totals.blocked ? 'Some accounts cannot be modified' : 'The selected accounts already have these values'} padded={false}>
          <div className="card-body">
            <Totals items={[['Accounts', preview.totals.accounts], ['To change', preview.totals.change], ['Unchanged', preview.totals.unchanged], ['Blocked', preview.totals.blocked], ['Fields', preview.totals.fields]]} />
            <Warnings warnings={preview.warnings} />
          </div>
          <DataTable
            columns={[
              { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
              { key: 'domain', label: 'Domain' },
              { key: 'owner', label: 'Owner' },
              { key: 'status', label: 'Status', render: (r) => <ItemStatus status={r.status} /> },
              { key: 'changes', label: 'Changes', render: (r) => (r.changes.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{r.changes.map((c) => <li key={c.field}>{c.label}: {fmt(c.field, c.from)} → <strong>{fmt(c.field, c.to)}</strong></li>)}</ul> : r.issues.length ? r.issues.map((i) => <div key={i} className="field-message">{i}</div>) : <span className="muted">already has these values</span>) },
            ]}
            rows={preview.items} rowKey={(r) => r.username} dense
          />
          <div className="card-body">
            <FormActions>
              <Button onClick={() => setPreview(null)}>Back</Button>
              <Button variant="danger" loading={busy} disabled={!preview.ok} onClick={start}>Modify accounts now</Button>
            </FormActions>
          </div>
        </Card>
      )}
      {step === 3 && run && <RunPanel job={run.job} runId={run.runId} title="Modifying accounts" describeItem={describeItem} onReset={reset} onFinished={() => setHistoryKey((k) => k + 1)} />}
      <RunHistory kind="modify" describeItem={describeItem} refreshKey={historyKey} />
    </>
  );
}
