import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function EnableDkimSpfGlobally({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/dns/email');
  const [opts, setOpts] = useState({ dkim: true, spf: true, dmarc: false });
  const [selected, setSelected] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [runError, setRunError] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = data || [];
  const missing = (k) => rows.filter((r) => !r[k]).length;

  const run = async () => {
    const scope = selected.length ? `${selected.length} selected domain(s)` : `all ${rows.length} domain(s)`;
    if (!(await confirm({ title: 'Enable email authentication?', message: `Adds ${[opts.spf && 'SPF', opts.dkim && 'DKIM keys', opts.dmarc && 'DMARC'].filter(Boolean).join(', ')} to ${scope} that lack them, then reloads BIND. Existing records are left unchanged.`, confirmLabel: 'Run' }))) return;
    setBusy(true); setRunError(null);
    try {
      const body = { ...opts };
      if (selected.length) body.domains = selected;
      const { data: res } = await api.post('/dns/email/enable-all', body);
      setJobId(res.job.id);
    } catch (err) { setRunError(err); toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Bulk-apply SPF, DKIM (new keys where missing) and optionally a monitoring DMARC policy to every zone, as a background job." />
      <Card title="What to enable">
        <CapabilityNotice error={runError} />
        {runError && runError.code !== 'capability_missing' && <ErrorBanner error={runError} />}
        <div className="stat-grid" style={{ marginBottom: 12 }}>
          <div className="stat"><div className="label">Zones</div><div className="value">{rows.length}</div></div>
          <div className="stat"><div className="label">Missing SPF</div><div className="value">{missing('spf')}</div></div>
          <div className="stat"><div className="label">Missing DKIM</div><div className="value">{missing('dkim')}</div></div>
          <div className="stat"><div className="label">Missing DMARC</div><div className="value">{missing('dmarc')}</div></div>
        </div>
        <Field inline><Toggle checked={opts.spf} onChange={(v) => setOpts((o) => ({ ...o, spf: v }))} label="SPF" description="v=spf1 +mx +a ip4:<zone A records> ~all where no SPF record exists" /></Field>
        <Field inline><Toggle checked={opts.dkim} onChange={(v) => setOpts((o) => ({ ...o, dkim: v }))} label="DKIM" description="Generate a 2048-bit key per domain (selector from settings) and publish the public key" /></Field>
        <Field inline><Toggle checked={opts.dmarc} onChange={(v) => setOpts((o) => ({ ...o, dmarc: v }))} label="DMARC (p=none)" description="Monitoring-only policy with reports to postmaster@<domain>" /></Field>
        <FormActions>
          <Button variant="primary" loading={busy} disabled={!opts.spf && !opts.dkim && !opts.dmarc} onClick={run}>{selected.length ? `Enable on ${selected.length} selected` : 'Enable on all domains'}</Button>
        </FormActions>
        {jobId && <ProgressLog jobId={jobId} onFinished={() => { refetch(); toast.success('Email authentication job finished'); }} />}
      </Card>
      <Card title="Current status" padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Domain', render: (r) => <Link to={`/dns-functions/email-dns-record-manager?domain=${r.domain}`}><code>{r.domain}</code></Link> },
            { key: 'account', label: 'Account', render: (r) => r.account || <span className="muted">—</span> },
            { key: 'spf', label: 'SPF', render: (r) => <StatusPill status={r.spf ? 'ok' : 'warning'}>{r.spf ? 'yes' : 'missing'}</StatusPill> },
            { key: 'dkim', label: 'DKIM', render: (r) => <StatusPill status={r.dkim ? 'ok' : 'warning'}>{r.dkim ? 'yes' : 'missing'}</StatusPill> },
            { key: 'dmarc', label: 'DMARC', render: (r) => <StatusPill status={r.dmarc ? 'ok' : 'unknown'}>{r.dmarc ? 'yes' : 'none'}</StatusPill> },
            { key: 'mx', label: 'MX', align: 'right' },
          ]}
          rows={rows} loading={loading} error={error} rowKey={(r) => r.domain} selectable selected={selected} onSelectedChange={setSelected} dense emptyText="No zones yet."
        />
      </Card>
    </>
  );
}
