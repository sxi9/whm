import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Sparkles, Upload } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, Select, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
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
  const { t } = useT();
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
  const typeName = { sub: t('panel.ssl.type_sub', 'subdomain'), addon: t('panel.ssl.type_addon', 'addon'), parked: t('panel.ssl.type_parked', 'parked'), alias: t('panel.ssl.type_alias', 'alias') };

  const issue = async () => {
    setBusy(true);
    setIssueError(null);
    try {
      const { data } = await panelApi.post(`/ssl/domains/${encodeURIComponent(domain)}/issue`, {});
      setJob({ id: data.job?.id, domain });
      toast.success(fill(t('panel.ssl.issuing_free_for', 'Issuing a free certificate for {domain}'), { domain }));
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
      toast.success(data.web === 'applied' ? fill(t('panel.ssl.installed_on', 'Certificate installed on {domain}'), { domain }) : fill(t('panel.ssl.saved_for', 'Certificate saved for {domain}; the web server applies it once it is available'), { domain }));
      domains.refetch();
      stored.refetch();
    } catch (err) { setError(err); if (!err.fields) toast.error(err); } finally { setBusy(false); }
  };

  const pageError = domains.error && (domains.error.status === 403 || isCapabilityError(domains.error)) ? domains.error : null;

  return (
    <PanelPage fn={fn} actions={<Link className="btn" to={STATUS_PATH}>{t('panel.ssl/status.label', 'SSL status')}</Link>}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={domains.refetch} />}
      {!pageError && (
        <>
          {domains.error && <ErrorBanner error={domains.error} onRetry={domains.refetch} />}
          <Card title={t('panel.ssl.col_domain', 'Domain')} subtitle={t('panel.ssl.pick_domain', 'Pick the domain the certificate is for.')}>
            <div className="form-grid">
              <Field label={t('panel.ssl.install_on', 'Install on')} required error={error?.fields?.domain}>
                <Select value={domain} onChange={(v) => { setDomain(v); setCertId(''); setResult(null); }} options={list.map((d) => ({ value: d.domain, label: d.type === 'main' ? d.domain : `${d.domain} (${typeName[d.type] || d.type})` }))} placeholder={domains.loading ? t('panel.ssl.loading', 'Loading…') : list.length ? t('panel.ssl.select_domain', 'Select a domain') : t('panel.ssl.no_domains_on_account', 'No domains on this account')} />
              </Field>
              {domain && (
                <KeyValue items={[
                  [t('panel.ssl.current_certificate', 'Current certificate'), current ? <StatePill key="s" state={current.state} /> : <StatusPill key="n" status="warning">{t('panel.ssl.none', 'none')}</StatusPill>],
                  current && [t('panel.ssl.issued_by', 'Issued by'), current.selfSigned ? t('panel.ssl.self_signed', 'Self-signed') : current.issuer || '—'],
                  current && [t('panel.ssl.expires', 'Expires'), <ExpiryPill key="e" notAfter={current.notAfter} daysRemaining={current.daysRemaining} />],
                ]} />
              )}
            </div>
          </Card>

          <Card title={t('panel.ssl.free_certificate', 'Free certificate')} subtitle={autossl?.enabled ? fill(t('panel.ssl.free_help_on', 'Issued by {provider} and renewed automatically. The domain must already point at this server.'), { provider: autossl.provider }) : t('panel.ssl.free_help_off', 'Automatic certificates are not enabled on this server; ask your hosting provider, or install your own certificate below.')}
            actions={<Button variant="primary" icon={Sparkles} loading={busy && !job} disabled={!domain || !autossl?.enabled} onClick={issue}>{t('panel.ssl.issue_now', 'Issue now')}</Button>}>
            {issueError && <PanelCapabilityState error={issueError} onRetry={() => setIssueError(null)} />}
            {job && <JobProgress jobId={job.id} onFinished={domains.refetch} message={fill(t('panel.ssl.issuing_free_progress', 'Issuing a free certificate for {domain}; the current certificate above updates in a minute.'), { domain: job.domain })} />}
            {!job && !issueError && <p className="muted">{autossl?.enabled ? t('panel.ssl.issue_takes_minute', 'Issuing takes about a minute. Progress shows here.') : t('panel.ssl.nothing_until_autossl', 'Nothing to do here until AutoSSL is enabled on the server.')}</p>}
          </Card>

          <Card title={t('panel.ssl.own_certificate', 'Your own certificate')} subtitle={t('panel.ssl.own_help', 'From a certificate authority, or one you stored under Certificates.')}
            actions={(
              <div className="segmented" role="tablist">
                <button type="button" role="tab" aria-selected={source === 'paste'} className={source === 'paste' ? 'active' : ''} onClick={() => setSource('paste')}>{t('panel.ssl.paste', 'Paste')}</button>
                <button type="button" role="tab" aria-selected={source === 'stored'} className={source === 'stored' ? 'active' : ''} onClick={() => setSource('stored')}>{t('panel.ssl.stored_certificate', 'Stored certificate')}</button>
              </div>
            )}>
            {source === 'stored' && (
              <>
                <Field label={t('panel.ssl.stored_certificate', 'Stored certificate')} help={candidates.length ? t('panel.ssl.stored_key_used', 'The key stored with it is used automatically.') : t('panel.ssl.no_stored_for_domain', 'No stored certificate covers this domain yet. Upload one under Certificates, or paste it instead.')} error={error?.fields?.certId}>
                  <Select value={certId} onChange={setCertId} placeholder={candidates.length ? t('panel.ssl.select_certificate', 'Select a certificate') : t('panel.ssl.nothing_stored_for_domain', 'Nothing stored for this domain')} options={candidates.map((c) => ({ value: String(c.id), label: `${c.domain} · ${c.selfSigned ? t('panel.ssl.self_signed_lower', 'self-signed') : c.issuer || t('panel.ssl.unknown_issuer', 'unknown issuer')} · ${fill(t('panel.ssl.expires_on', 'expires {date}'), { date: c.notAfter ? c.notAfter.slice(0, 10) : '?' })}${c.hasKey ? '' : ` ${t('panel.ssl.no_key_stored', '(no key stored)')}`}` }))} />
                </Field>
                {chosen && !chosen.hasKey && <div className="banner banner-warning"><Upload size={18} /><div>{t('panel.ssl.no_key_help', 'This certificate has no private key stored with it. Paste the certificate together with its key instead.')}</div></div>}
                <p className="muted small">{t('panel.ssl.manage_stored_under', 'Manage stored items under')} <Link to={CERTS_PATH}>{t('panel.ssl/certificates.label', 'Certificates')}</Link>.</p>
              </>
            )}
            {source === 'paste' && (
              <div className="form-grid">
                <Field label={t('panel.ssl.cert_pem', 'Certificate (PEM)')} required error={error?.fields?.certPem}><Textarea value={form.certPem} onChange={(v) => setForm({ ...form, certPem: v })} rows={7} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
                <Field label={t('panel.ssl.key_pem', 'Private key (PEM)')} required error={error?.fields?.keyPem} help={t('panel.ssl.key_pem_help', 'Unencrypted. It is stored encrypted and never shown again.')}><Textarea value={form.keyPem} onChange={(v) => setForm({ ...form, keyPem: v })} rows={7} mono spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
                <Field label={t('panel.ssl.chain_pem', 'Chain / CA bundle (PEM)')} help={t('panel.ssl.chain_pem_help', 'Intermediate certificates from your certificate authority, if any.')} error={error?.fields?.chainPem}><Textarea value={form.chainPem} onChange={(v) => setForm({ ...form, chainPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
              </div>
            )}
            {error && !isCapabilityError(error) && !error.fields && <ErrorBanner error={error} />}
            {error && isCapabilityError(error) && <PanelCapabilityState error={error} onRetry={() => setError(null)} />}
            {error?.fields && !error.fields.certPem && !error.fields.keyPem && !error.fields.chainPem && !error.fields.domain && !error.fields.certId && <ErrorBanner error={error} />}
            <FormActions>
              <Button variant="primary" loading={busy && !job} disabled={!canInstall} onClick={install}>{t('panel.ssl.install_certificate', 'Install certificate')}</Button>
            </FormActions>
          </Card>

          {result && (
            <Card title={fill(t('panel.ssl.installed_on_title', 'Installed on {domain}'), { domain })}>
              <KeyValue items={[
                [t('panel.ssl.state', 'State'), <StatePill key="s" state={result.cert?.state} />],
                [t('panel.ssl.web_server', 'Web server'), <WebStatus key="w" web={result.web} detail={result.webDetail} />],
              ]} />
              <div style={{ marginTop: 12 }}><CertificateSummary certificate={result.certificate} /></div>
            </Card>
          )}
        </>
      )}
    </PanelPage>
  );
}
