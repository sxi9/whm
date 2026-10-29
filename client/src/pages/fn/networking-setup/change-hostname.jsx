import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { ChangeHostname } from '../../networking/ChangeHostname.jsx';

const STEP_LABELS = { landing: 'Hostname landing page', certificate: 'Hostname certificate' };

function CertificateSteps({ steps }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((s) => (
        <li key={s.step} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
          <StatusPill status={s.ok ? (s.skipped ? 'disabled' : 'ok') : 'failed'}>{s.ok ? (s.skipped ? 'skipped' : 'done') : 'failed'}</StatusPill>
          <div>
            <strong>{STEP_LABELS[s.step] || s.step}</strong>
            {s.detail && <div className="muted"><code>{s.detail}</code></div>}
            {s.error && <div className="muted">{s.error}</div>}
            {s.step === 'certificate' && s.capability === 'acme' && <div className="muted">Install certbot or acme.sh and pick it under <Link to="/ssl-tls/manage-autossl">Manage AutoSSL</Link>.</div>}
            {s.step === 'certificate' && s.failed?.length > 0 && <div className="muted">Install it by hand for <strong>{s.failed.map((f) => f.service).join(', ')}</strong> from <Link to="/service-configuration/manage-service-ssl-certificates">Manage Service SSL Certificates</Link>.</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// The hostname's own certificate: issued through AutoSSL once the name
// resolves here, installed for the panel, Exim, Dovecot and FTP and for the
// landing-page virtual host. The hostname change does this on its own; this
// card repeats it (after DNS propagated, or when a client was installed later).
function HostnameCertificate() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, refetch } = useApi('/networking/hostname');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const reissue = async () => {
    if (!status?.configured) return;
    const ok = await confirm({
      title: `Issue a certificate for ${status.configured}?`,
      message: 'A new certificate is requested from the AutoSSL provider (this counts against its rate limits), then installed for the panel (2087), Exim, Dovecot, FTP and the hostname landing page. The name must already resolve to this server.',
      confirmLabel: 'Reissue certificate',
    });
    if (!ok) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { data } = await api.post('/networking/hostname/certificate', {});
      setResult(data);
      if (data.ok) toast.success(`Certificate issued for ${data.hostname}`);
      else toast.warning(`Certificate run for ${data.hostname} finished with problems; see below`);
      await refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  const cert = status?.certificate;
  const landing = status?.landing;
  return (
    <Card title="Hostname certificate and landing page" subtitle="Visitors who open the hostname see the branded landing page (Account Functions › Web Template Editor, template “landing”); the panel, mail and FTP services present the hostname certificate." actions={<Button variant="primary" onClick={reissue} loading={busy} disabled={!status?.configured || !status?.capability?.ssl}>Reissue hostname certificate</Button>}>
      {status && (
        <KeyValue items={[
          ['Certificate', cert ? <span key="c">{cert.issuer || 'unknown issuer'} {cert.expired ? <StatusPill status="failed">expired</StatusPill> : <StatusPill status={cert.autossl ? 'ok' : 'enabled'}>{cert.autossl ? 'AutoSSL' : cert.selfSigned ? 'self-signed' : 'installed'}</StatusPill>} <span className="muted">valid until {formatDate(cert.notAfter)}{cert.daysRemaining != null ? ` (${cert.daysRemaining} days)` : ''}</span></span> : <span key="c"><StatusPill status="warning">none for {status.configured || 'the hostname'}</StatusPill> <span className="muted">service certificates are self-signed until one is issued</span></span>],
          ['Landing page', landing ? <span key="l"><StatusPill status={landing.status === 'applied' ? 'ok' : landing.status === 'pending' ? 'pending' : 'failed'}>{landing.status}</StatusPill> <code>{landing.docroot}</code>{landing.ssl ? ' over HTTPS' : ''}{landing.error ? <span className="muted"> — {landing.error}</span> : null}</span> : <span key="l" className="muted">not rendered yet; it is written when the hostname changes or the panel starts</span>],
          ['Resolves here', status.resolves ? (status.resolves.matches ? <StatusPill key="r" status="ok">yes</StatusPill> : <StatusPill key="r" status="warning">{status.resolves.answers?.length ? `resolves to ${status.resolves.answers.join(', ')}` : status.resolves.error || 'no answer'} — the certificate can only be issued once the DNS records point here</StatusPill>) : <span key="r" className="muted">not checked</span>],
          ['AutoSSL', status.capability?.ssl ? <span key="a">available — provider chosen under <Link to="/ssl-tls/manage-autossl">Manage AutoSSL</Link></span> : <span key="a" className="muted">SSL/TLS is not available on this panel</span>],
        ]} />
      )}
      <ErrorBanner error={error} />
      {result && <div style={{ marginTop: 12 }}><CertificateSteps steps={result.steps} /></div>}
    </Card>
  );
}

export default function ChangeHostnamePage({ fn }) {
  return (
    <>
      <PageHeader fn={fn} description="Sets the kernel hostname with hostnamectl, maps it in /etc/hosts, updates the panel's hostname setting, publishes the hostname's A/AAAA, www and MX records, renders the branded landing page for it and issues its certificate for the panel, mail and FTP." />
      <ChangeHostname />
      <HostnameCertificate />
    </>
  );
}
