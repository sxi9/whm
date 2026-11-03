import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Sparkles, Upload } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, Select, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { RequestError, JobProgress, ExpiryPill, StatePill, CertificateSummary, WebStatus, isCapabilityError, pem } from './parts/Shared.jsx';

const STATUS_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/status']?.path || '/panel/ssl/status';
const CERTS_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/certificates']?.path || '/panel/ssl/certificates';

// Stored certificates that can go on a hostname: same name, or a wildcard one
// level up (*.example.com covers shop.example.com).
export function certificateCandidates(certs, domain) {
  const list = (certs || []).filter((c) => c.hasCert);
  if (!domain) return list;
  const parent = domain.split('.').slice(1).join('.');
  return list.filter((c) => c.domain === domain || c.domain === `*.${parent}`);
}

export default function InstallCertificate({ fn }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const domains = usePanelApi('/ssl/domains');
  const stored = usePanelApi('/ssl/certs?kind=cert&pageSize=200&sort=created_at&dir=desc');
  const [domain, setDomain] = useState(params.get('domain') || '');
  const [source, setSource] = useState(params.get('certId') ? 'stored' : 'paste');
  const [certId, setCertId] = useState(params.get('certId') || '');
  const [form, setForm] = useState({ certPem: '', keyPem: '', chainPem: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [job, setJob] = useState(null);
  const [issueError, setIssueError] = useState(null);

  const list = domains.data?.domains || [];
  const autossl = domains.data?.autossl;
  useEffect(() => { if (!domain && list.length) setDomain(list[0].domain); }, [list, domain]);
  useEffect(() => { const next = {}; if (domain) next.domain = domain; if (certId) next.certId = certId; setParams(next, { replace: true }); }, [domain, certId, setParams]);

  const current = list.find((d) => d.domain === domain)?.certificate || null;
  const candidates = useMemo(() => certificateCandidates(stored.data, domain), [stored.data, domain]);
  const chosen = candidates.find((c) => String(c.id) === String(certId)) || null;
  const canInstall = Boolean(domain) && (source === 'stored' ? Boolean(certId) : Boolean(form.certPem.trim() && form.keyPem.trim()));

  const issue = async () => {
    setBusy(true);
    setIssueError(null);
    try {
      const { data } = await panelApi.post(`/ssl/domains/${encodeURIComponent(domain)}/issue`, {});
      setJob({ id: data.job?.id, domain });
      toast.success(`Issuing a free certificate for ${domain}`);
    } catch (err) {
      if (isCapabilityError(err)) setIssueError(err); else toast.error(err);
    } finally { setBusy(false); }
  };

  const install = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = source === 'stored' ? { certId: Number(certId) } : { certPem: pem(form.certPem), keyPem: pem(form.keyPem), ...(form.chainPem.trim() ? { chainPem: pem(form.chainPem) } : {}) };
      const { data } = await panelApi.post(`/ssl/domains/${encodeURIComponent(domain)}/install`, body);
      setResult(data);
      toast.success(data.web === 'applied' ? `Certificate installed on ${domain}` : `Certificate saved for ${domain}; the web server applies it once it is available`);
      domains.refetch();
      stored.refetch();
    } catch (err) { setError(err); if (!err.fields) toast.error(err); } finally { setBusy(false); }
  };

  const pageError = domains.error && (domains.error.status === 403 || isCapabilityError(domains.error)) ? domains.error : null;

  return (
    <PanelPage fn={fn} actions={<Link className="btn" to={STATUS_PATH}>SSL status</Link>}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={domains.refetch} />}
      {!pageError && (
        <>
          {domains.error && <ErrorBanner error={domains.error} onRetry={domains.refetch} />}
          <Card title="Domain" subtitle="Pick the domain the certificate is for.">
            <div className="form-grid">
              <Field label="Install on" required error={error?.fields?.domain}>
                <Select value={domain} onChange={(v) => { setDomain(v); setCertId(''); setResult(null); }} options={list.map((d) => ({ value: d.domain, label: d.type === 'main' ? d.domain : `${d.domain} (${d.type === 'sub' ? 'subdomain' : d.type})` }))} placeholder={domains.loading ? 'Loading…' : list.length ? 'Select a domain' : 'No domains on this account'} />
              </Field>
              {domain && (
                <KeyValue items={[
                  ['Current certificate', current ? <StatePill key="s" state={current.state} /> : <StatusPill key="n" status="warning">none</StatusPill>],
                  current && ['Issued by', current.selfSigned ? 'Self-signed' : current.issuer || '—'],
                  current && ['Expires', <ExpiryPill key="e" notAfter={current.notAfter} daysRemaining={current.daysRemaining} />],
                ]} />
              )}
            </div>
          </Card>

          <Card title="Free certificate" subtitle={autossl?.enabled ? `Issued by ${autossl.provider} and renewed automatically. The domain must already point at this server.` : 'Automatic certificates are not enabled on this server; ask your hosting provider, or install your own certificate below.'}
            actions={<Button variant="primary" icon={Sparkles} loading={busy && !job} disabled={!domain || !autossl?.enabled} onClick={issue}>Issue now</Button>}>
            {issueError && <PanelCapabilityState error={issueError} onRetry={() => setIssueError(null)} />}
            {job && <JobProgress jobId={job.id} onFinished={domains.refetch} message={`Issuing a free certificate for ${job.domain}; the current certificate above updates in a minute.`} />}
            {!job && !issueError && <p className="muted">{autossl?.enabled ? 'Issuing takes about a minute. Progress shows here.' : 'Nothing to do here until AutoSSL is enabled on the server.'}</p>}
          </Card>

          <Card title="Your own certificate" subtitle="From a certificate authority, or one you stored under Certificates."
            actions={(
              <div className="segmented" role="tablist">
                <button type="button" role="tab" aria-selected={source === 'paste'} className={source === 'paste' ? 'active' : ''} onClick={() => setSource('paste')}>Paste</button>
                <button type="button" role="tab" aria-selected={source === 'stored'} className={source === 'stored' ? 'active' : ''} onClick={() => setSource('stored')}>Stored certificate</button>
              </div>
            )}>
            {source === 'stored' && (
              <>
                <Field label="Stored certificate" help={candidates.length ? 'The key stored with it is used automatically.' : 'No stored certificate covers this domain yet. Upload one under Certificates, or paste it instead.'} error={error?.fields?.certId}>
                  <Select value={certId} onChange={setCertId} placeholder={candidates.length ? 'Select a certificate' : 'Nothing stored for this domain'} options={candidates.map((c) => ({ value: String(c.id), label: `${c.domain} · ${c.selfSigned ? 'self-signed' : c.issuer || 'unknown issuer'} · expires ${c.notAfter ? c.notAfter.slice(0, 10) : '?'}${c.hasKey ? '' : ' (no key stored)'}` }))} />
                </Field>
                {chosen && !chosen.hasKey && <div className="banner banner-warning"><Upload size={18} /><div>This certificate has no private key stored with it. Paste the certificate together with its key instead.</div></div>}
                <p className="muted small">Manage stored items under <Link to={CERTS_PATH}>Certificates</Link>.</p>
              </>
            )}
            {source === 'paste' && (
              <div className="form-grid">
                <Field label="Certificate (PEM)" required error={error?.fields?.certPem}><Textarea value={form.certPem} onChange={(v) => setForm({ ...form, certPem: v })} rows={7} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
                <Field label="Private key (PEM)" required error={error?.fields?.keyPem} help="Unencrypted. It is stored encrypted and never shown again."><Textarea value={form.keyPem} onChange={(v) => setForm({ ...form, keyPem: v })} rows={7} mono spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
                <Field label="Chain / CA bundle (PEM)" help="Intermediate certificates from your certificate authority, if any." error={error?.fields?.chainPem}><Textarea value={form.chainPem} onChange={(v) => setForm({ ...form, chainPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
              </div>
            )}
            {error && !isCapabilityError(error) && !error.fields && <ErrorBanner error={error} />}
            {error && isCapabilityError(error) && <PanelCapabilityState error={error} onRetry={() => setError(null)} />}
            {error?.fields && !error.fields.certPem && !error.fields.keyPem && !error.fields.chainPem && !error.fields.domain && !error.fields.certId && <ErrorBanner error={error} />}
            <FormActions>
              <Button variant="primary" loading={busy && !job} disabled={!canInstall} onClick={install}>Install certificate</Button>
            </FormActions>
          </Card>

          {result && (
            <Card title={`Installed on ${domain}`}>
              <KeyValue items={[
                ['State', <StatePill key="s" state={result.cert?.state} />],
                ['Web server', <WebStatus key="w" web={result.web} detail={result.webDetail} />],
              ]} />
              <div style={{ marginTop: 12 }}><CertificateSummary certificate={result.certificate} /></div>
            </Card>
          )}
        </>
      )}
    </PanelPage>
  );
}
