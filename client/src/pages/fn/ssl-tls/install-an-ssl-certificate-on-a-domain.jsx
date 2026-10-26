import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, Textarea, Select, Button, FormActions, Toggle, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, DomainSelect, CertificateSummary, StatePill, ExpiryPill } from '../../ssl/Shared.jsx';

export default function InstallCertificate({ fn }) {
  const toast = useToast();
  const stored = useApi('/ssl/certs?kind=cert&pageSize=200&sort=created_at&dir=desc');
  const domains = useApi('/ssl/domains');
  const [form, setForm] = useState({ domain: '', certId: '', certPem: '', keyPem: '', chainPem: '', force: false });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const current = domains.data?.find((d) => d.domain === form.domain)?.certificate || null;
  const candidates = (stored.data || []).filter((c) => !form.domain || c.domain === form.domain || c.domain === `*.${form.domain.split('.').slice(1).join('.')}`);

  useEffect(() => {
    if (!form.certPem.trim()) { setPreview(null); return undefined; }
    const t = setTimeout(async () => {
      try { const { data } = await api.post('/ssl/certs/inspect', { certPem: form.certPem.trim() + '\n', ...(form.chainPem.trim() ? { chainPem: form.chainPem.trim() + '\n' } : {}), ...(form.domain ? { domain: form.domain } : {}) }); setPreview(data); } catch (err) { setPreview({ error: err }); }
    }, 500);
    return () => clearTimeout(t);
  }, [form.certPem, form.chainPem, form.domain]);

  const pickStored = async (id) => {
    setForm((f) => ({ ...f, certId: id, certPem: '', keyPem: '', chainPem: '' }));
    setPreview(null);
    if (!id) return;
    try {
      const { data } = await api.get(`/ssl/certs/${id}/download?part=cert`);
      const { data: info } = await api.post('/ssl/certs/inspect', { certPem: data.content });
      setPreview(info);
    } catch (err) { toast.error(err); }
  };

  const install = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = { domain: form.domain.trim().toLowerCase(), force: form.force };
      if (form.certId) body.certId = Number(form.certId);
      if (form.certPem.trim()) body.certPem = form.certPem.trim() + '\n';
      if (form.keyPem.trim()) body.keyPem = form.keyPem.trim() + '\n';
      if (form.chainPem.trim()) body.chainPem = form.chainPem.trim() + '\n';
      const { data } = await api.post('/ssl/install', body);
      setResult(data);
      toast.success(data.web === 'applied' ? `Certificate installed on ${body.domain}` : `Certificate files written for ${body.domain}; vhost update pending`);
      domains.refetch();
      stored.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={domains.error} onRetry={domains.refetch} />
      <div className="form-grid">
        <Card title="Domain">
          <Field label="Install on" required error={error?.fields?.domain}><DomainSelect value={form.domain} onChange={(v) => setForm({ ...form, domain: v, certId: '' })} /></Field>
          {form.domain && (
            <KeyValue items={[
              ['Current certificate', current ? <span key="c"><StatePill state={current.state} /> {current.issuer}</span> : <StatusPill key="n" status="inactive">none</StatusPill>],
              current && ['Expires', <ExpiryPill key="e" notAfter={current.notAfter} daysRemaining={current.daysRemaining} />],
            ]} />
          )}
          <Field label="Use a stored certificate" help={candidates.length ? 'From the SSL Storage Manager. Its stored key is used automatically.' : 'No stored certificate matches this domain; paste one below.'}>
            <Select value={form.certId} onChange={pickStored} placeholder="Paste a certificate instead" options={candidates.map((c) => ({ value: String(c.id), label: `#${c.id} ${c.domain} · ${c.selfSigned ? 'self-signed' : c.issuer || 'unknown issuer'} · expires ${c.notAfter ? c.notAfter.slice(0, 10) : '?'}${c.hasKey ? '' : ' (no key stored)'}` }))} />
          </Field>
          <Field inline><Toggle checked={form.force} onChange={(v) => setForm({ ...form, force: v })} label="Install even if the certificate does not cover this domain or has expired" /></Field>
        </Card>
        <Card title="Or paste the certificate" subtitle="The private key is optional when a matching key is already stored for one of your accounts.">
          <Field label="Certificate (PEM)" error={error?.fields?.certPem}><Textarea value={form.certPem} onChange={(v) => setForm({ ...form, certPem: v, certId: '' })} rows={6} mono placeholder="-----BEGIN CERTIFICATE-----" disabled={Boolean(form.certId)} /></Field>
          <Field label="Private key (PEM)" error={error?.fields?.keyPem}><Textarea value={form.keyPem} onChange={(v) => setForm({ ...form, keyPem: v })} rows={5} mono placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
          <Field label="CA bundle / chain (PEM)" help="Intermediate certificates from your CA, if any."><Textarea value={form.chainPem} onChange={(v) => setForm({ ...form, chainPem: v })} rows={4} mono placeholder="-----BEGIN CERTIFICATE-----" /></Field>
        </Card>
      </div>
      {preview && !preview.error && <Card title="Certificate preview"><CertificateSummary certificate={preview.certificate} chain={preview.chain} /></Card>}
      {preview?.error && <ErrorBanner error={preview.error} />}
      <Card>
        <FormActions>
          <Button variant="primary" loading={busy} disabled={!form.domain || (!form.certId && !form.certPem.trim())} onClick={install}>Install</Button>
          <Link className="btn" to="/ssl-tls/manage-ssl-hosts">Manage SSL Hosts</Link>
        </FormActions>
        {error && error.status === 422 && !error.fields?.domain && !error.fields?.certPem && !error.fields?.keyPem && <ErrorBanner error={error} />}
        {error && error.status !== 422 && <RequestError error={error} />}
        {result && (
          <div className="action-result">
            <KeyValue items={[
              ['Status', <StatePill key="s" state={result.cert.state} />],
              ['Files', <code key="f" className="small">{result.paths.dir}/</code>],
              ['Web server', result.web === 'applied' ? 'vhost updated and reloaded' : `pending — ${typeof result.webDetail === 'string' ? result.webDetail : 'the vhost is updated when the web server category applies it'}`],
            ]} />
            <CertificateSummary certificate={result.certificate} />
          </div>
        )}
      </Card>
    </>
  );
}
