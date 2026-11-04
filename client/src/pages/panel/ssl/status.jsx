import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck, Sparkles, Info } from 'lucide-react';
import { Card, KeyValue, StatusPill, EmptyState, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { DelegationBanners } from '../../../panel/DelegationBanner.jsx';
import { RequestError, JobProgress, ExpiryPill, StatePill, TypePill, CertificateSummary, isCapabilityError, webResult } from './parts/Shared.jsx';

const INSTALL_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/install']?.path || '/panel/ssl/install';
const CERTS_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/certificates']?.path || '/panel/ssl/certificates';

// Counts for the tiles above the table: every domain, the ones with a live
// certificate, the ones expiring within 30 days and the ones with nothing.
export function sslSummary(domains) {
  const list = domains || [];
  const live = (c) => c && c.state !== 'stored' && !c.expired;
  return {
    domains: list.length,
    secured: list.filter((d) => live(d.certificate)).length,
    expiring: list.filter((d) => live(d.certificate) && d.certificate.daysRemaining != null && d.certificate.daysRemaining <= 30).length,
    unsecured: list.filter((d) => !live(d.certificate)).length,
  };
}

export function AutoSslPill({ entry }) {
  if (!entry) return <span className="muted">—</span>;
  const tone = entry.action === 'failed' || entry.status === 'failed' ? 'failed' : entry.action === 'issued' || entry.action === 'renewed' ? 'ok' : 'inactive';
  const when = entry.finishedAt || entry.startedAt;
  return <span title={entry.message || ''}><StatusPill status={tone}>{entry.action || entry.status}</StatusPill>{when && <span className="muted small"> {formatDate(when).split(',')[0]}</span>}</span>;
}

function DomainDetails({ domain, onClose }) {
  const { data, error, loading, refetch } = usePanelApi(domain ? `/ssl/domains/${encodeURIComponent(domain)}` : null);
  return (
    <Modal open={Boolean(domain)} title={domain || ''} onClose={onClose} size="md">
      {loading && !data && <Loading />}
      {error && error.status === 404 && <EmptyState icon={Info} title="No certificate installed"><p>Nothing is installed on {domain} yet.</p><p><Link className="btn btn-sm" to={`${INSTALL_PATH}?domain=${encodeURIComponent(domain)}`}>Install a certificate</Link></p></EmptyState>}
      {error && error.status !== 404 && <RequestError error={error} onRetry={refetch} inline />}
      {data && (
        <>
          <KeyValue items={[
            ['State', <StatePill key="s" state={data.state} />],
            data.files?.exists != null && ['Files on the server', data.files.exists ? <StatusPill key="f" status="ok">present</StatusPill> : <StatusPill key="f" status="warning">missing</StatusPill>],
            data.files?.hasChain != null && ['Chain', data.files.hasChain ? 'included' : 'none'],
          ]} />
          <div style={{ marginTop: 12 }}><CertificateSummary certificate={data.certificate} chain={data.chain} /></div>
        </>
      )}
    </Modal>
  );
}

export default function SslStatus({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, error, loading, refetch } = usePanelApi('/ssl/domains');
  const { me } = usePanelMe();
  // Where each hostname's public DNS lives (from /domains): a certificate can only
  // be issued once the name resolves to this server from the outside.
  const hostnames = usePanelApi('/domains');
  const delegated = hostnames.data || [];
  const addressRecords = (d) => [d.domain, ...(d.type === 'main' || d.type === 'addon' ? [`www.${d.domain}`] : [])].flatMap((name) => [...(me?.account?.ip ? [{ name, type: 'A', value: me.account.ip }] : []), ...(me?.account?.ipv6 ? [{ name, type: 'AAAA', value: me.account.ipv6 }] : [])]);
  const [q, setQ] = useState('');
  const [details, setDetails] = useState(null);
  const [job, setJob] = useState(null);
  const [issueError, setIssueError] = useState(null);
  const [pending, setPending] = useState({});
  const [busy, setBusy] = useState(null);

  const domains = data?.domains || [];
  const summary = useMemo(() => sslSummary(domains), [domains]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? domains.filter((d) => d.domain.includes(needle) || (d.certificate?.issuer || '').toLowerCase().includes(needle)) : domains;
  }, [domains, q]);
  const autossl = data?.autossl;

  const issue = async (domain) => {
    setBusy(domain);
    setIssueError(null);
    try {
      const { data: res } = await panelApi.post(`/ssl/domains/${encodeURIComponent(domain)}/issue`, {});
      setJob({ id: res.job?.id, domain });
      toast.success(`Issuing a certificate for ${domain}`);
    } catch (err) {
      if (isCapabilityError(err)) setIssueError(err); else toast.error(err);
    } finally { setBusy(null); }
  };

  const remove = async (domain) => {
    const ok = await confirm({ title: `Remove the certificate from ${domain}?`, message: 'Visitors will see a browser warning on https:// until a new certificate is installed. The stored copy stays under Certificates.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    setBusy(domain);
    try {
      const { data: res } = await panelApi.delete(`/ssl/domains/${encodeURIComponent(domain)}`);
      const w = webResult(res.web);
      setPending((p) => ({ ...p, [domain]: w.applied ? null : w }));
      toast.success(w.applied ? `Certificate removed from ${domain}` : `Certificate files removed from ${domain}; the web server picks it up once it is available`);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  const columns = [
    { key: 'domain', label: 'Domain', render: (r) => <><strong>{r.domain}</strong> <TypePill type={r.type} /></> },
    { key: 'state', label: 'Certificate', render: (r) => (r.certificate ? <><StatePill state={r.certificate.state} />{pending[r.domain] && <> <PendingPill result={pending[r.domain]} /></>}</> : <StatusPill status="warning">none</StatusPill>) },
    { key: 'issuer', label: 'Issued by', render: (r) => (r.certificate ? (r.certificate.selfSigned ? 'Self-signed' : r.certificate.issuer || '—') : <span className="muted">—</span>) },
    { key: 'expires', label: 'Expires', render: (r) => <ExpiryPill notAfter={r.certificate?.notAfter} daysRemaining={r.certificate?.daysRemaining} /> },
    { key: 'autossl', label: 'Last AutoSSL run', render: (r) => <AutoSslPill entry={r.autossl} /> },
  ];

  const unavailable = isCapabilityError(error);

  return (
    <PanelPage fn={fn} actions={unavailable
      ? <button type="button" className="btn btn-primary" disabled><ShieldCheck size={16} /> Install certificate</button>
      : <Link className="btn btn-primary" to={INSTALL_PATH}><ShieldCheck size={16} /> Install certificate</Link>}>
      {error && <RequestError error={error} fn={fn} onRetry={refetch} />}
      {!error && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat" data-stat="domains"><div className="label">Domains</div><div className="value">{summary.domains}</div></div>
            <div className="stat" data-stat="secured"><div className="label">Secured</div><div className="value">{summary.secured}</div></div>
            <div className="stat" data-stat="expiring"><div className="label">Expiring within 30 days</div><div className="value">{summary.expiring}</div></div>
            <div className="stat" data-stat="unsecured"><div className="label">Without a certificate</div><div className="value">{summary.unsecured}</div></div>
          </div>

          {autossl && (
            <div className={`banner ${autossl.enabled ? 'banner-success' : 'banner-info'}`}>
              <Sparkles size={18} />
              <div>
                <strong>{autossl.enabled ? 'Free certificates are issued automatically' : 'Automatic certificates are not enabled on this server'}</strong>
                <p className="muted">{autossl.enabled ? `Every domain here is checked daily and renewed before it expires (${autossl.provider}${autossl.includeWww ? ', including www.' : ''}). Use "Issue now" to get a certificate right away.` : 'Ask your hosting provider to turn on AutoSSL, or install a certificate you bought from a certificate authority.'}</p>
              </div>
            </div>
          )}

          <DelegationBanners domains={delegated} recordsFor={addressRecords} title="Certificates need the name to resolve to this server" />

          {issueError && <RequestError error={issueError} onRetry={() => setIssueError(null)} />}

          {job && (
            <Card title={`Issuing a certificate for ${job.domain}`} actions={<button className="btn btn-sm" onClick={() => { setJob(null); refetch(); }}>Close</button>}>
              <JobProgress jobId={job.id} onFinished={refetch} message={`Issuing a certificate for ${job.domain}; the table updates in a minute.`} />
            </Card>
          )}

          <Card padded={false}>
            {!loading && domains.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="No domains to secure yet">
                <p>Each domain of this account appears here with its certificate, issuer and expiry date.</p>
                <p className="muted">Add a domain under Domains first; the main domain shows up as soon as the account is provisioned.</p>
              </EmptyState>
            ) : (
              <DataTable
                columns={columns} rows={rows} loading={loading} rowKey={(r) => r.domain}
                searchable q={q} onSearch={setQ} searchPlaceholder="Search domains…"
                emptyText="No domain matches that search"
                rowActions={(r) => [
                  autossl?.enabled && { label: busy === r.domain ? 'Working…' : 'Issue now', primary: true, disabled: busy === r.domain, onClick: () => issue(r.domain) },
                  { label: 'Details', primary: !autossl?.enabled, onClick: () => setDetails(r.domain) },
                  { label: r.certificate ? 'Replace certificate' : 'Install certificate', onClick: () => navigate(`${INSTALL_PATH}?domain=${encodeURIComponent(r.domain)}`) },
                  r.certificate && r.certificate.state !== 'stored' && { label: 'Remove certificate', danger: true, disabled: busy === r.domain, onClick: () => remove(r.domain) },
                ]}
              />
            )}
          </Card>
          <p className="muted small">Stored certificates, keys and signing requests live under <Link to={CERTS_PATH}>Certificates</Link>.</p>
        </>
      )}
      <DomainDetails domain={details} onClose={() => setDetails(null)} />
    </PanelPage>
  );
}
