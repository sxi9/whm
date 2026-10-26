import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, Textarea, NumberInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, DaemonNotice } from '../../service-config/Shared.jsx';

export default function ManageServiceSslCertificates({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/service-config/service-certs');
  const [editing, setEditing] = useState(null);
  const [pems, setPems] = useState({ certPem: '', keyPem: '', chainPem: '' });
  const [busy, setBusy] = useState(null);
  const [formError, setFormError] = useState(null);
  const [days, setDays] = useState(365);

  const install = async () => {
    setBusy('install'); setFormError(null);
    try {
      const { data: d } = await api.post(`/service-config/service-certs/${editing.service}`, { certPem: pems.certPem.trim(), keyPem: pems.keyPem.trim(), ...(pems.chainPem.trim() ? { chainPem: pems.chainPem.trim() } : {}) });
      toast.success(`${editing.label}: certificate installed${d.reload?.reloaded ? `, ${d.reload.unit} reloaded` : ''}`);
      setEditing(null); setPems({ certPem: '', keyPem: '', chainPem: '' }); refetch();
    } catch (err) { setFormError(err); } finally { setBusy(null); }
  };
  const reset = async (row) => {
    if (!(await confirm({ title: `Reset ${row.label} to a self-signed certificate?`, message: `A new self-signed certificate for ${data.hostname} (valid ${days} days) replaces the current one. Clients will show a trust warning until a signed certificate is installed.`, confirmLabel: 'Reset', danger: true }))) return;
    setBusy(row.service);
    try { const { data: d } = await api.post(`/service-config/service-certs/${row.service}/self-signed`, { days }); toast.success(`${row.label}: self-signed certificate installed${d.reload?.reloaded ? ` and ${d.reload.unit} reloaded` : ''}`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Certificates used by Exim, Dovecot, the FTP server, Apache's default SSL host and the panel itself. Install a signed certificate or reset a service to a fresh self-signed one for the server hostname." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <DaemonNotice installed={data.openssl} message="openssl is not installed on this server; certificates cannot be inspected or generated until the openssl package is installed." onRetry={refetch} />
          <Card title="Service certificates" subtitle={`Server hostname: ${data.hostname}. Stored under /etc/ssl/whm/service/<service>/ and wired into each daemon's configuration.`} actions={<Field label="Self-signed validity (days)"><NumberInput value={days} onChange={(v) => setDays(v || 365)} min={1} max={3650} nullable={false} /></Field>}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Service</th><th>Daemon</th><th>Certificate</th><th>Expires</th><th>Issuer</th><th /></tr></thead>
                <tbody>
                  {data.services.map((s) => {
                    const days = s.daysRemaining;
                    return (
                      <tr key={s.service}>
                        <td><strong>{s.label}</strong><div className="small muted">{s.paths?.dir}</div></td>
                        <td>{s.daemonPresent == null ? <StatusPill status="unknown">—</StatusPill> : s.daemonPresent ? <StatusPill status="installed">installed</StatusPill> : <StatusPill status="not-installed">not installed</StatusPill>}</td>
                        <td>{s.hasCertificate ? <span><StatusPill status={s.selfSigned ? 'warning' : 'ok'}>{s.selfSigned ? 'self-signed' : 'signed'}</StatusPill> <span className="small">{s.subject}</span></span> : <StatusPill status="pending">none installed</StatusPill>}</td>
                        <td>{s.notAfter ? <StatusPill status={days < 0 ? 'failed' : days <= 14 ? 'warning' : 'ok'}>{days < 0 ? `expired ${-days}d ago` : `${days}d · ${formatDate(s.notAfter).split(',')[0]}`}</StatusPill> : '—'}</td>
                        <td className="small">{s.issuer || '—'}</td>
                        <td className="actions-col">
                          <div className="row-actions">
                            <Button size="sm" onClick={() => { setEditing(s); setFormError(null); }} disabled={!data.openssl}>Install</Button>
                            <Button size="sm" variant="danger-ghost" loading={busy === s.service} onClick={() => reset(s)} disabled={!data.openssl}>Reset to self-signed</Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>Per-domain website certificates are managed under <Link to="/ssl-tls/manage-ssl-hosts">Manage SSL Hosts</Link>{data.sslCategory ? '' : ' (SSL/TLS category not loaded; installs go straight to the agent)'}. The panel certificate needs WHM_TLS_CERT/WHM_TLS_KEY pointed at /etc/whm/tls and a panel restart.</p>
          </Card>
          <Modal open={Boolean(editing)} title={editing ? `Install certificate for ${editing.label}` : ''} onClose={() => setEditing(null)} size="lg" footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={busy === 'install'} disabled={!pems.certPem.trim() || !pems.keyPem.trim()} onClick={install}>Install</Button></>}>
            <ErrorBanner error={formError} />
            <Field label="Certificate (PEM)" required><Textarea value={pems.certPem} onChange={(v) => setPems({ ...pems, certPem: v })} rows={7} mono placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label="Private key (PEM)" required help="Must match the certificate; stored 0600 and encrypted in the panel database"><Textarea value={pems.keyPem} onChange={(v) => setPems({ ...pems, keyPem: v })} rows={7} mono placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
            <Field label="CA bundle / chain (PEM, optional)"><Textarea value={pems.chainPem} onChange={(v) => setPems({ ...pems, chainPem: v })} rows={5} mono /></Field>
            <FormActions><span className="muted small">The daemon is reloaded after the files are written.</span></FormActions>
          </Modal>
        </>
      )}
    </>
  );
}
