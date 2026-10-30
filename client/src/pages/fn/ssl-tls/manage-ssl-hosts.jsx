import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, RefreshCw } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, ExpiryPill, StatePill, CertificateSummary, Tabs, downloadText } from '../../ssl/Shared.jsx';

const SERVICE_LABEL = { panel: 'Panel (2087)', exim: 'Exim (SMTP)', dovecot: 'Dovecot (IMAP/POP3)', ftp: 'FTP' };

// One pill per service the hostname certificate is installed for.
export function ServicePills({ services }) {
  if (!services?.length) return <span className="muted">—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {services.map((s) => {
        const status = !s.hasCertificate ? 'inactive' : s.expired ? 'failed' : s.coversHostname === false ? 'warning' : 'ok';
        const text = !s.hasCertificate ? 'none' : s.coversHostname === false ? 'other name' : s.selfSigned ? 'self-signed' : 'installed';
        return <StatusPill key={s.service} status={status}>{`${SERVICE_LABEL[s.service] || s.service}: ${text}${s.daysRemaining != null && s.hasCertificate ? ` · ${s.daysRemaining}d` : ''}`}</StatusPill>;
      })}
    </span>
  );
}

// The server hostname's own row (root only): its certificate, where it is
// installed, the renewal schedule and the AutoSSL state, with Reissue and
// Download. Issuance itself belongs to Networking Setup (Change Hostname).
export function ServerHostnameCard({ server, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  if (!server) return null;
  const cert = server.certificate;
  const reissue = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const { data } = await api.post(server.reissue?.path || '/networking/hostname/certificate', { force: true });
      setOutcome(data);
      if (data.ok) toast.success(`Certificate re-issued for ${data.hostname}`); else toast.error(new Error((data.steps || []).find((s) => !s.ok)?.error || 'The certificate could not be re-issued'));
      onChanged?.();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const download = async (part) => {
    try {
      const { data } = await api.get(`/ssl/certs/${cert.id}/download?part=${part}`);
      downloadText(data.filename, data.content);
    } catch (err) { toast.error(err); }
  };
  if (!server.valid) {
    return (
      <Card title="Server hostname" subtitle="The hostname's own certificate, installed for the panel, mail and FTP.">
        <p className="muted">No fully qualified hostname is set{server.hostname ? ` (${server.hostname})` : ''}. Set one under <Link to="/networking-setup/change-hostname">Networking Setup › Change Hostname</Link>; its certificate is issued there and listed here.</p>
      </Card>
    );
  }
  const actions = (
    <>
      <Button icon={RefreshCw} loading={busy} onClick={reissue} disabled={!server.reissue?.available} title={server.autossl?.enabled ? 'Issue or renew the hostname certificate through AutoSSL now' : 'Enable AutoSSL first (SSL/TLS › Manage AutoSSL)'}>Reissue</Button>
      {cert && <Button icon={Download} onClick={() => download('fullchain')}>Download</Button>}
    </>
  );
  return (
    <Card title="Server hostname" subtitle="The hostname's own certificate, installed for the panel, mail and FTP, and served by the landing page on the bare address." actions={actions}>
      <KeyValue items={[
        ['Hostname', <code key="h">{server.hostname}</code>],
        ['Certificate', cert
          ? <span key="c" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span className="small">{(cert.subject || '').replace(/^CN=/, '')}</span><span className="muted small">issued by {cert.selfSigned ? 'itself (self-signed)' : (cert.issuer || '—').replace(/^CN=/, '').split(',')[0]}</span><ExpiryPill notAfter={cert.notAfter} daysRemaining={cert.daysRemaining} /><StatePill state={cert.state} /><StatusPill status={cert.autossl ? 'ok' : 'inactive'}>{cert.autossl ? 'AutoSSL' : 'manual'}</StatusPill></span>
          : <span key="c" className="muted">none installed yet{server.autossl?.enabled ? ' — use Reissue once the hostname resolves to this server' : ' — enable AutoSSL, then Reissue'}</span>],
        ['Installed for', <ServicePills key="s" services={server.services} />],
        ['Auto-renew', server.renewal
          ? <span key="r"><StatusPill status={server.renewal.enabled ? 'ok' : 'inactive'}>{server.renewal.enabled ? 'scheduled' : 'paused'}</StatusPill> <span className="small muted">{server.renewal.cron} · renews within {server.renewal.renewDays} days of expiry{server.renewal.nextRunAt ? ` · next check ${formatDate(server.renewal.nextRunAt)}` : ''}{server.renewal.lastRunAt ? ` · last ${formatDate(server.renewal.lastRunAt)}` : ''}</span></span>
          : <span key="r" className="muted">no renewal schedule</span>],
        ['AutoSSL', <span key="a"><StatusPill status={server.autossl?.enabled ? 'ok' : 'inactive'}>{server.autossl?.enabled ? server.autossl.provider : 'disabled'}</StatusPill> {server.autossl?.lastEntry ? <span className="small muted">last run: {server.autossl.lastEntry.action} — {server.autossl.lastEntry.message}{server.autossl.lastEntry.finishedAt ? ` (${formatDate(server.autossl.lastEntry.finishedAt)})` : ''}</span> : <span className="small muted">no AutoSSL run has visited the hostname; Reissue and the daily renewal pass do</span>}</span>],
        ['Landing page', server.landing
          ? <span key="l"><StatusPill status={server.landing.status === 'applied' ? 'ok' : server.landing.status === 'pending' ? 'pending' : 'failed'}>{server.landing.status}</StatusPill> <span className="small muted">{server.landing.docroot}{server.landing.ssl ? ' · HTTPS' : ' · HTTP only'}{server.landing.error ? ` · ${server.landing.error}` : ''}</span></span>
          : <span key="l" className="muted">no hostname virtual host yet (written at boot and on a hostname change)</span>],
      ]} />
      {outcome && (
        <div style={{ marginTop: 10 }}>
          {(outcome.steps || []).map((s) => <div key={s.step} className="small" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><StatusPill status={s.ok ? 'ok' : s.skipped ? 'inactive' : 'failed'}>{s.step}</StatusPill><span>{s.detail || s.error || (s.skipped ? 'skipped' : 'done')}</span></div>)}
        </div>
      )}
    </Card>
  );
}

export default function ManageSslHosts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/ssl/hosts');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [viewing, setViewing] = useState(null);

  const hosts = (data?.hosts || []).filter((h) => {
    if (filter === 'expiring') return h.daysRemaining != null && h.daysRemaining <= 30;
    if (filter === 'autossl') return h.autossl;
    if (filter === 'pending') return h.state === 'pending' || h.state === 'unmanaged';
    return true;
  }).filter((h) => !q || h.domain.includes(q.toLowerCase()) || (h.account || '').includes(q.toLowerCase()));

  const uninstall = async (h) => {
    if (!(await confirm({ title: `Remove the certificate from ${h.domain}?`, message: h.hostname ? 'This is the server hostname: the panel, mail and FTP keep their copies until the next reissue, and the landing page falls back to the server default certificate.' : 'The certificate files under /etc/ssl/whm are deleted and the vhost falls back to the server default certificate. The certificate itself stays in the SSL Storage Manager.', confirmLabel: 'Uninstall', danger: true }))) return;
    try { await api.delete(`/ssl/hosts/${h.domain}`); toast.success(`Certificate removed from ${h.domain}`); refetch(); } catch (err) { toast.error(err); }
  };
  // Reads what is actually on disk, so unmanaged directories (no panel row) have details too.
  const view = async (h) => {
    try {
      const { data: info } = await api.get(`/ssl/hosts/${h.domain}`);
      setViewing({ host: h, ...info });
    } catch (err) { toast.error(err); }
  };

  const counts = { all: data?.hosts.length, expiring: data?.hosts.filter((h) => h.daysRemaining != null && h.daysRemaining <= 30).length, autossl: data?.hosts.filter((h) => h.autossl).length, pending: data?.hosts.filter((h) => h.state === 'pending' || h.state === 'unmanaged').length };

  return (
    <>
      <PageHeader fn={fn} actions={<Link className="btn btn-primary" to="/ssl-tls/install-an-ssl-certificate-on-a-domain">Install a certificate</Link>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data?.serverHostname && <ServerHostnameCard server={data.serverHostname} onChanged={refetch} />}
      {data && (
        <Card padded={false} title="Installed certificates" subtitle={`Bundles live under ${data.bundleRoot}/<domain>/. ${data.webLinked ? 'Vhost changes are applied by the web server category.' : 'The web server category is not loaded: files are written and vhosts are updated once it is.'}`}>
          <div style={{ padding: '12px 16px 0' }}>
            <Tabs value={filter} onChange={setFilter} tabs={[{ value: 'all', label: 'All', count: counts.all }, { value: 'expiring', label: 'Expiring ≤ 30d', count: counts.expiring }, { value: 'autossl', label: 'AutoSSL', count: counts.autossl }, { value: 'pending', label: 'Pending / unmanaged', count: counts.pending }]} />
          </div>
          <DataTable dense searchable q={q} onSearch={setQ} searchPlaceholder="Filter by domain or account" columns={[
            { key: 'domain', label: 'Domain', render: (h) => <code>{h.domain}</code> },
            { key: 'account', label: 'Account', render: (h) => (h.hostname ? <StatusPill status="ok">server hostname</StatusPill> : h.account || <span className="muted">—</span>) },
            { key: 'issuer', label: 'Issuer', render: (h) => (h.selfSigned ? <StatusPill status="warning">self-signed</StatusPill> : <span className="small">{(h.issuer || '—').replace(/^CN=/, '').split(',')[0]}</span>) },
            { key: 'notAfter', label: 'Expires', render: (h) => <ExpiryPill notAfter={h.notAfter} daysRemaining={h.daysRemaining} /> },
            { key: 'autossl', label: 'Source', render: (h) => <StatusPill status={h.autossl ? 'ok' : 'inactive'}>{h.autossl ? 'AutoSSL' : 'manual'}</StatusPill> },
            { key: 'state', label: 'State', render: (h) => <StatePill state={h.state} /> },
            { key: 'files', label: 'Files', render: (h) => (h.files?.present == null ? <span className="muted" title={data.bundlesListed === false ? 'The bundle directory could not be listed' : ''}>—</span> : <StatusPill status={h.files.present ? 'ok' : 'warning'}>{h.files.present ? `on disk${h.files.hasKey ? '' : ', key missing'}` : 'missing on disk'}</StatusPill>) },
          ]} rows={hosts} rowKey={(h) => h.domain} emptyText="No certificates are installed. Install one or enable AutoSSL."
            rowActions={(h) => [
              { label: 'Details', primary: true, onClick: () => view(h) },
              { label: 'Uninstall', danger: true, onClick: () => uninstall(h) },
            ]} />
        </Card>
      )}
      <Modal open={Boolean(viewing)} title={`Certificate on ${viewing?.host.domain}`} onClose={() => setViewing(null)} size="lg" footer={<Button variant="primary" onClick={() => setViewing(null)}>Close</Button>}>
        {viewing && (
          <>
            <p className="muted small">{viewing.files?.exists ? <>Files: <code>{viewing.files.paths?.dir}/</code>{viewing.files.hasChain ? ' (with chain)' : ''}</> : viewing.files?.error ? `Bundle not readable: ${viewing.files.error}` : 'No bundle files on disk; showing the stored certificate.'}</p>
            <CertificateSummary certificate={viewing.certificate} chain={viewing.chain} />
          </>
        )}
      </Modal>
    </>
  );
}
