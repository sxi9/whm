import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal } from '../../../components/Modal.jsx';

export default function NameserverRecordReport({ fn }) {
  const [domain, setDomain] = useState('');
  const [limit, setLimit] = useState(50);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (domain) qs.set('domain', domain.trim().toLowerCase());
      const { data } = await api.get(`/dns/nameserver-report?${qs}`);
      setReport(data);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const rows = (report?.zones || []).filter((z) => !onlyProblems || z.status !== 'ok');

  return (
    <>
      <PageHeader fn={fn} description="Compares each zone's NS records with the delegation published by the registrar, checks that every nameserver has an address (glue) and that the public A record matches the zone. Lookups use the configured resolvers." />
      <Card title="Run report">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Single domain (optional)"><TextInput value={domain} onChange={setDomain} placeholder="example.com" /></Field>
          <Field label="Max zones to check" help="Each zone needs several DNS lookups"><NumberInput value={limit} onChange={(v) => setLimit(v ?? 50)} nullable={false} min={1} max={500} /></Field>
        </div>
        <FormActions><Button variant="primary" loading={busy} onClick={run}>Check nameservers</Button></FormActions>
        {report && <KeyValue items={[['Resolvers', Array.isArray(report.resolvers) ? report.resolvers.join(', ') : 'system resolv.conf'], ['Expected nameservers', report.expectedNameservers.join(', ') || 'not configured in Basic Setup'], ['Zones checked', report.total]]} />}
      </Card>
      {report && (
        <Card title="Results" padded={false} actions={<Toggle checked={onlyProblems} onChange={setOnlyProblems} label="Only problems" />}>
          <DataTable
            columns={[
              { key: 'status', label: 'Status', width: 100, render: (z) => <StatusPill status={z.status === 'ok' ? 'ok' : z.status}>{z.status}</StatusPill> },
              { key: 'domain', label: 'Zone', render: (z) => <Link to={`/dns-functions/dns-zone-manager?domain=${z.domain}`}><code>{z.domain}</code></Link> },
              { key: 'zoneNs', label: 'NS in zone', render: (z) => (z.zoneNs.length ? <code className="small">{z.zoneNs.join(', ')}</code> : <span className="muted">—</span>) },
              { key: 'delegatedNs', label: 'Delegated NS', render: (z) => (z.delegatedNs.length ? <code className="small">{z.delegatedNs.join(', ')}</code> : <span className="muted">—</span>) },
              { key: 'issues', label: 'Issues', render: (z) => (z.issues.length ? `${z.issues.length} issue(s): ${z.issues[0].message}${z.issues.length > 1 ? '…' : ''}` : <span className="muted">none</span>) },
            ]}
            rows={rows} rowKey={(z) => z.domain} dense emptyText={onlyProblems ? 'Every checked zone looks healthy.' : 'No zones to report on. Add a zone and run the report again.'}
            rowActions={(z) => [{ label: 'Details', primary: true, onClick: () => setOpen(z) }]}
          />
        </Card>
      )}
      <Modal open={Boolean(open)} title={open ? `Nameserver report: ${open.domain}` : ''} onClose={() => setOpen(null)} size="lg">
        {open && (
          <>
            <KeyValue items={[['Zone NS', open.zoneNs.join(', ') || '—'], ['Delegated NS', open.delegatedNs.join(', ') || '—'], ['Zone A', open.apexA.join(', ') || '—'], ['Public A', open.publicA.join(', ') || 'no answer']]} />
            <h3 style={{ marginTop: 16, marginBottom: 8 }}>Glue addresses</h3>
            {open.glue.length ? <KeyValue items={open.glue.map((g) => [g.host, g.addresses.length ? g.addresses.join(', ') : <StatusPill key={g.host} status="error">{g.error || 'no address'}</StatusPill>])} /> : <p className="muted">No nameserver hosts to look up.</p>}
            <h3 style={{ marginTop: 16, marginBottom: 8 }}>Issues</h3>
            {open.issues.length ? <ul className="list-plain">{open.issues.map((i, n) => <li key={n} style={{ padding: '6px 0' }}><StatusPill status={i.level === 'info' ? 'info' : i.level}>{i.level}</StatusPill> {i.message}</li>)}</ul> : <p className="muted">No issues found.</p>}
          </>
        )}
      </Modal>
    </>
  );
}
