import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Textarea, Button, FormActions, RadioGroup, NumberInput, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, DomainSelect, AccountSelect, KeySpecFields, SubjectFields, PemView, CertificateSummary, cleanSubject, parseSans, downloadText } from '../../ssl/Shared.jsx';

export default function GenerateCsr({ fn }) {
  const toast = useToast();
  const recent = useApi('/ssl/certs?kind=csr&sort=created_at&dir=desc&pageSize=10');
  const [mode, setMode] = useState('csr');
  const [form, setForm] = useState({ account: '', domain: '', sans: '', days: 365, key: { type: 'rsa', bits: 2048, curve: 'prime256v1' }, subject: { O: '', OU: '', L: '', ST: '', C: '', emailAddress: '' } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { domain: form.domain.trim().toLowerCase(), sans: parseSans(form.sans), key: form.key, subject: cleanSubject(form.subject), ...(form.account ? { account: form.account } : {}) };
      const { data } = await api.post(mode === 'csr' ? '/ssl/certs/csr' : '/ssl/certs/self-signed', mode === 'csr' ? body : { ...body, days: Number(form.days) || 365 });
      setResult(data);
      toast.success(mode === 'csr' ? `CSR and private key generated for ${body.domain}` : `Self-signed certificate generated for ${body.domain}`);
      recent.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setBusy(false); }
  };

  const downloadFromStore = async (row, part) => {
    try { const { data } = await api.get(`/ssl/certs/${row.id}/download?part=${part}`); downloadText(data.filename, data.content); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <div className="form-grid">
        <Card title="Certificate details" subtitle="The key and CSR are stored encrypted in the SSL Storage Manager under the account that owns the domain.">
          <Field label="What to generate">
            <RadioGroup name="mode" value={mode} onChange={setMode} options={[
              { value: 'csr', label: 'Private key + signing request (CSR)', description: 'Send the CSR to a certificate authority; install the certificate it returns.' },
              { value: 'self-signed', label: 'Self-signed certificate', description: 'Immediate, but browsers warn: use it for testing or internal services.' },
            ]} />
          </Field>
          <Field label="Account" help="Optional: defaults to the account that owns the domain."><AccountSelect value={form.account} onChange={(v) => setForm({ ...form, account: v })} /></Field>
          <Field label="Domain (common name)" required error={error?.fields?.domain}><DomainSelect value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} /></Field>
          <Field label="Additional names (SANs)" help="One per line or comma-separated. www.<domain> is common; *.example.com for wildcards." error={error?.fields?.sans}>
            <Textarea value={form.sans} onChange={(v) => setForm({ ...form, sans: v })} rows={3} mono placeholder={form.domain ? `www.${form.domain}` : 'www.example.com'} />
          </Field>
          {mode === 'self-signed' && <Field label="Valid for (days)"><NumberInput value={form.days} onChange={(v) => setForm({ ...form, days: v })} min={1} max={3650} nullable={false} /></Field>}
          <KeySpecFields value={form.key} onChange={(key) => setForm({ ...form, key })} />
        </Card>
        <Card title="Subject" subtitle="Organization details embedded in the request. CAs issuing DV certificates ignore everything except the domain.">
          <SubjectFields value={form.subject} onChange={(subject) => setForm({ ...form, subject })} />
          <FormActions>
            <Button variant="primary" loading={busy} disabled={!form.domain.trim()} onClick={generate}>{mode === 'csr' ? 'Generate key + CSR' : 'Generate certificate'}</Button>
          </FormActions>
          {error && error.status !== 422 && <RequestError error={error} />}
          {error?.status === 422 && !error.fields?.domain && !error.fields?.sans && <ErrorBanner error={error} />}
        </Card>
      </div>
      {result && (
        <Card title={`Generated for ${result.cert.domain}`} subtitle="Copy or download now: the private key is shown once here and otherwise only retrievable from the SSL Storage Manager (audited).">
          {result.certificate && <CertificateSummary certificate={result.certificate} />}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <PemView label="Private key" value={result.keyPem} filename={`${result.cert.domain}.key`} />
            {result.csrPem && <PemView label="Certificate signing request" value={result.csrPem} filename={`${result.cert.domain}.csr`} />}
            {result.certPem && <PemView label="Certificate" value={result.certPem} filename={`${result.cert.domain}.crt`} />}
          </div>
          <p className="muted">Next: {result.csrPem ? <>submit the CSR to your CA (or <Link to="/ssl-tls/purchase-and-install-an-ssl-certificate">purchase one</Link>), then </> : null}<Link to="/ssl-tls/install-an-ssl-certificate-on-a-domain">install the certificate on {result.cert.domain}</Link>.</p>
        </Card>
      )}
      <Card title="Recent signing requests" padded={false}>
        <RequestError error={recent.error} onRetry={recent.refetch} />
        {recent.loading && !recent.data && <Loading />}
        {recent.data && (
          <DataTable dense columns={[
            { key: 'domain', label: 'Domain', render: (r) => <code>{r.domain}</code> },
            { key: 'account', label: 'Account' },
            { key: 'subject', label: 'Subject', render: (r) => <span className="small">{r.subject || '—'}</span> },
            { key: 'hasKey', label: 'Key', render: (r) => (r.hasKey ? 'stored' : '—') },
            { key: 'createdAt', label: 'Created', render: (r) => formatDate(r.createdAt) },
          ]} rows={recent.data} emptyText="No CSRs yet." rowActions={(r) => [
            { label: 'Download CSR', primary: true, onClick: () => downloadFromStore(r, 'csr') },
            r.hasKey && { label: 'Download key', onClick: () => downloadFromStore(r, 'key') },
          ]} />
        )}
      </Card>
    </>
  );
}
