import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, ExpiryPill, StatePill, CertificateSummary, Tabs } from '../../ssl/Shared.jsx';

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
    if (!(await confirm({ title: `Remove the certificate from ${h.domain}?`, message: 'The certificate files under /etc/ssl/whm are deleted and the vhost falls back to the server default certificate. The certificate itself stays in the SSL Storage Manager.', confirmLabel: 'Uninstall', danger: true }))) return;
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
      {data && (
        <Card padded={false} title="Installed certificates" subtitle={`Bundles live under ${data.bundleRoot}/<domain>/. ${data.webLinked ? 'Vhost changes are applied by the web server category.' : 'The web server category is not loaded: files are written and vhosts are updated once it is.'}`}>
          <div style={{ padding: '12px 16px 0' }}>
            <Tabs value={filter} onChange={setFilter} tabs={[{ value: 'all', label: 'All', count: counts.all }, { value: 'expiring', label: 'Expiring ≤ 30d', count: counts.expiring }, { value: 'autossl', label: 'AutoSSL', count: counts.autossl }, { value: 'pending', label: 'Pending / unmanaged', count: counts.pending }]} />
          </div>
          <DataTable dense searchable q={q} onSearch={setQ} searchPlaceholder="Filter by domain or account" columns={[
            { key: 'domain', label: 'Domain', render: (h) => <code>{h.domain}</code> },
            { key: 'account', label: 'Account', render: (h) => h.account || <span className="muted">—</span> },
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
