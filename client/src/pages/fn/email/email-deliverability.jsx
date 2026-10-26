import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError } from '../../email/Shared.jsx';

const TONE = { ok: 'ok', warning: 'warning', missing: 'failed', unknown: 'unknown' };

function DomainReport({ domain, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch, setData } = useApi(`/email/deliverability/${domain}`);
  const [busy, setBusy] = useState(false);
  const fix = async (items) => {
    if (!(await confirm({ title: `Create ${items.map((i) => i.toUpperCase()).join(', ')} record(s)?`, message: `The panel writes the suggested record(s) into the ${domain} DNS zone and publishes it. Existing SPF/DMARC records are replaced; DKIM generates a key if none exists.`, confirmLabel: 'Fix' }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post(`/email/deliverability/${domain}/fix`, { items });
      const failed = Object.entries(res.results).filter(([, r]) => !r.ok);
      if (failed.length) toast.warning(failed.map(([k, r]) => `${k.toUpperCase()}: ${r.error}`).join('; ')); else toast.success('Records created and published');
      setData(res.status);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const fixable = data?.items.filter((i) => i.fixable && i.status !== 'ok').map((i) => i.id) || [];
  return (
    <Card title={`Deliverability report: ${domain}`} subtitle={data ? `Checked ${formatDate(data.checkedAt)} · score ${data.score}/100` : 'Looking up DNS…'} actions={<><Button size="sm" onClick={() => refetch()}>Re-check</Button><Button size="sm" onClick={onClose}>Close</Button></>}>
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading text="Resolving SPF, DKIM, DMARC, MX and PTR…" />}
      {data && (
        <>
          {!data.zone && <div className="banner banner-info"><div>This domain's DNS is not hosted on this server (no local zone), so records can only be shown, not created. Add them at your DNS provider.</div></div>}
          {fixable.length > 0 && <div className="form-actions"><Button variant="primary" loading={busy} onClick={() => fix(fixable)}>Fix all ({fixable.map((f) => f.toUpperCase()).join(', ')})</Button></div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 160 }}>Check</th><th style={{ width: 110 }}>Status</th><th>Current</th><th>Expected / suggested</th><th style={{ width: 120 }} /></tr></thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td><strong>{i.label}</strong>{i.selector && <div className="muted">selector {i.selector}</div>}</td>
                    <td>
                      <StatusPill status={TONE[i.status] || 'unknown'}>{i.status}</StatusPill>
                      {i.id === 'dkim' && i.signing != null && <div style={{ marginTop: 4 }}><StatusPill status={i.signing ? 'ok' : 'warning'}>{i.signing ? 'signing on' : 'not signing'}</StatusPill></div>}
                    </td>
                    <td>{i.current.length ? i.current.map((c) => <div key={c}><code style={{ wordBreak: 'break-all' }}>{c}</code></div>) : <span className="muted">none</span>}{i.detail && <div className="muted" style={{ marginTop: 4 }}>{i.detail}</div>}{i.signing === false && i.signingHint && <div className="muted" style={{ marginTop: 4 }}>{i.signingHint}</div>}</td>
                    <td>{i.expected ? <code style={{ wordBreak: 'break-all' }}>{i.expected}</code> : <span className="muted">—</span>}</td>
                    <td>{i.fixable && i.status !== 'ok' && <Button size="sm" variant="primary" loading={busy} onClick={() => fix([i.id])}>Fix</Button>}{i.id === 'ptr' && i.status !== 'ok' && <span className="muted">Set at your IP provider</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Fine-tune the records in <Link to={`/dns-functions/email-dns-record-manager?domain=${domain}`}>Email DNS Record Manager</Link>.</p>
        </>
      )}
    </Card>
  );
}

export default function EmailDeliverability({ fn }) {
  const { data, loading, error, refetch } = useApi('/email/deliverability');
  const [domain, setDomain] = useState(null);
  const [q, setQ] = useState('');
  const rows = (data || []).filter((d) => !q || d.domain.includes(q.toLowerCase()) || (d.account || '').includes(q.toLowerCase()));
  return (
    <>
      <PageHeader fn={fn} description="Checks each domain's SPF, DKIM and DMARC TXT records, MX records and the server's reverse DNS as the rest of the internet sees them, and creates missing records in locally hosted zones with one click." />
      <RequestError error={error} onRetry={refetch} />
      {error && !error.status && <ErrorBanner error={error} />}
      {domain && <DomainReport domain={domain} onClose={() => setDomain(null)} />}
      <Card padded={false}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Domain', render: (d) => <code>{d.domain}</code> },
            { key: 'type', label: 'Type' },
            { key: 'account', label: 'Account', render: (d) => d.account || <span className="muted">—</span> },
            { key: 'zone', label: 'DNS hosted here', render: (d) => <StatusPill status={d.zone ? 'ok' : 'unknown'}>{d.zone ? 'yes' : 'no'}</StatusPill> },
            { key: 'dkimKey', label: 'DKIM key', render: (d) => <StatusPill status={d.dkimKey ? 'ok' : 'warning'}>{d.dkimKey ? 'generated' : 'none'}</StatusPill> },
          ]}
          rows={rows} loading={loading} rowKey={(d) => d.domain} dense emptyText="No domains yet. Create an account first."
          searchable q={q} onSearch={setQ} searchPlaceholder="Filter domains"
          rowActions={(d) => [{ label: 'Check', primary: true, onClick: () => setDomain(d.domain) }]}
        />
      </Card>
    </>
  );
}
