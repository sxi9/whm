import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { Field, Textarea, Button, FormActions, Select } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ExpiryPill, StatePill, PemView, CertificateSummary, AccountSelect, DomainSelect, downloadText } from '../../ssl/Shared.jsx';

const KIND_LABEL = { key: 'Private key', csr: 'Signing request', cert: 'Certificate' };

export default function SslStorageManager({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [account, setAccount] = useState('');
  const { data, loading, error, refetch } = useApi(`/ssl/storage${account ? `?account=${encodeURIComponent(account)}` : ''}`);
  const [kind, setKind] = useState('all');
  const [viewing, setViewing] = useState(null);
  const [upload, setUpload] = useState({ open: false, account: '', domain: '', certPem: '', keyPem: '', chainPem: '', csrPem: '' });
  const [busy, setBusy] = useState(false);

  const items = (data?.items || []).filter((i) => kind === 'all' || i.kind === kind);

  const download = async (item) => {
    try { const { data: d } = await api.get(`/ssl/certs/${item.id}/download?part=${item.kind}`); downloadText(d.filename, d.content); } catch (err) { toast.error(err); }
  };
  const view = async (item) => {
    if (item.kind === 'key' && !(await confirm({ title: 'Show the private key?', message: 'Anyone who sees this key can impersonate the site. The export is recorded in the audit log.', confirmLabel: 'Show key' }))) return;
    try {
      const { data: d } = await api.get(`/ssl/certs/${item.id}/download?part=${item.kind}`);
      let info = null;
      if (item.kind === 'cert') info = (await api.post('/ssl/certs/inspect', { certPem: d.content })).data;
      setViewing({ item, content: d.content, filename: d.filename, info });
    } catch (err) { toast.error(err); }
  };
  const remove = async (item) => {
    if (!(await confirm({ title: `Delete this ${KIND_LABEL[item.kind].toLowerCase()} for ${item.domain}?`, message: item.kind === 'key' ? 'Without the private key the matching certificate can no longer be installed anywhere. This cannot be undone.' : 'This cannot be undone.', confirmLabel: 'Delete', danger: true, typeToConfirm: item.kind === 'key' ? item.domain : undefined }))) return;
    try { await api.delete(`/ssl/certs/${item.id}/${item.kind}`); toast.success(`${KIND_LABEL[item.kind]} deleted`); refetch(); } catch (err) { toast.error(err); }
  };
  const doUpload = async () => {
    setBusy(true);
    try {
      const body = {};
      for (const k of ['certPem', 'keyPem', 'chainPem', 'csrPem']) if (upload[k].trim()) body[k] = upload[k].trim() + '\n';
      if (upload.account) body.account = upload.account;
      if (upload.domain) body.domain = upload.domain.trim().toLowerCase();
      await api.post('/ssl/certs/upload', body);
      toast.success('Stored');
      setUpload({ open: false, account: '', domain: '', certPem: '', keyPem: '', chainPem: '', csrPem: '' });
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} actions={<><Button variant="primary" onClick={() => setUpload({ ...upload, open: true })}>Upload</Button><Link className="btn" to="/ssl-tls/generate-an-ssl-certificate-and-signing-request">Generate</Link></>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <Card padded={false} title="Stored items" subtitle="Keys are encrypted at rest with the panel master key; viewing or downloading a key is audited.">
          <div style={{ padding: '12px 16px 0', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tabs value={kind} onChange={setKind} tabs={[{ value: 'all', label: 'All', count: data.items.length }, { value: 'key', label: 'Keys', count: data.counts.key }, { value: 'csr', label: 'CSRs', count: data.counts.csr }, { value: 'cert', label: 'Certificates', count: data.counts.cert }]} />
            <div style={{ minWidth: 240, marginBottom: 14 }}><AccountSelect value={account} onChange={setAccount} placeholder="All accounts" /></div>
          </div>
          <DataTable dense columns={[
            { key: 'kind', label: 'Type', render: (i) => <StatusPill status={i.kind === 'key' ? 'warning' : i.kind === 'cert' ? 'ok' : 'pending'}>{KIND_LABEL[i.kind]}</StatusPill> },
            { key: 'domain', label: 'Domain', render: (i) => <code>{i.domain}</code> },
            { key: 'account', label: 'Account', render: (i) => i.account || <span className="muted">server</span> },
            { key: 'subject', label: 'Subject / issuer', render: (i) => <span className="small">{i.kind === 'cert' ? (i.selfSigned ? 'self-signed' : (i.issuer || '—').replace(/^CN=/, '')) : (i.subject || '—')}</span> },
            { key: 'notAfter', label: 'Expires', render: (i) => (i.kind === 'cert' ? <ExpiryPill notAfter={i.notAfter} daysRemaining={i.daysRemaining} /> : <span className="muted">—</span>) },
            { key: 'state', label: 'State', render: (i) => (i.kind === 'csr' ? <span className="muted">—</span> : <StatePill state={i.state} />) },
            { key: 'createdAt', label: 'Created', render: (i) => formatDate(i.createdAt) },
          ]} rows={items} rowKey={(i) => i.itemId} emptyText="Nothing stored yet. Generate a CSR or upload a certificate."
            rowActions={(i) => [
              { label: 'View', primary: true, onClick: () => view(i) },
              { label: 'Download', onClick: () => download(i) },
              i.kind === 'cert' && i.state === 'stored' && { label: 'Install', onClick: () => navigate('/ssl-tls/install-an-ssl-certificate-on-a-domain') },
              { label: 'Delete', danger: true, onClick: () => remove(i), disabled: i.state !== 'stored' && i.kind !== 'csr' },
            ]} />
        </Card>
      )}
      <Modal open={Boolean(viewing)} title={viewing ? `${KIND_LABEL[viewing.item.kind]}: ${viewing.item.domain}` : ''} onClose={() => setViewing(null)} size="lg" footer={<Button variant="primary" onClick={() => setViewing(null)}>Close</Button>}>
        {viewing && <>{viewing.info && <CertificateSummary certificate={viewing.info.certificate} chain={viewing.info.chain} />}<PemView label="PEM" value={viewing.content} filename={viewing.filename} rows={12} /></>}
      </Modal>
      <Modal open={upload.open} title="Upload to SSL storage" onClose={() => setUpload({ ...upload, open: false })} size="lg"
        footer={<><Button onClick={() => setUpload({ ...upload, open: false })}>Cancel</Button><Button variant="primary" loading={busy} disabled={!upload.certPem.trim() && !upload.keyPem.trim() && !upload.csrPem.trim()} onClick={doUpload}>Store</Button></>}>
        <p className="muted">Paste any combination. A certificate's domain is read from it; a key alone needs a domain. Keys are checked against the certificate or CSR they are pasted with.</p>
        <Field label="Account"><AccountSelect value={upload.account} onChange={(v) => setUpload({ ...upload, account: v })} /></Field>
        <Field label="Domain" help="Required for a key without a certificate."><DomainSelect value={upload.domain} onChange={(v) => setUpload({ ...upload, domain: v })} placeholder="From the certificate" /></Field>
        <Field label="Certificate"><Textarea value={upload.certPem} onChange={(v) => setUpload({ ...upload, certPem: v })} rows={4} mono /></Field>
        <Field label="Private key"><Textarea value={upload.keyPem} onChange={(v) => setUpload({ ...upload, keyPem: v })} rows={4} mono /></Field>
        <Field label="CA bundle"><Textarea value={upload.chainPem} onChange={(v) => setUpload({ ...upload, chainPem: v })} rows={3} mono /></Field>
        <Field label="CSR"><Textarea value={upload.csrPem} onChange={(v) => setUpload({ ...upload, csrPem: v })} rows={3} mono /></Field>
      </Modal>
    </>
  );
}
