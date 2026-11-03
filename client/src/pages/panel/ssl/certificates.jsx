import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileKey, Upload, FilePlus, ShieldCheck } from 'lucide-react';
import { Card, StatusPill, EmptyState, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Textarea, NumberInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, usePanelMe } from '../../../panel/hooks/usePanel.js';
import { queryString } from '../../../api/client.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { RequestError, ExpiryPill, StatePill, PemView, CertificateSummary, accountDomains, downloadText, isCapabilityError, parseSans, cleanSubject, pem, KEY_TYPES, RSA_BITS, EC_CURVES } from './parts/Shared.jsx';

const INSTALL_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/install']?.path || '/panel/ssl/install';
const KINDS = [{ value: '', label: 'All' }, { value: 'cert', label: 'Certificates' }, { value: 'key', label: 'Keys' }, { value: 'csr', label: 'Signing requests' }];
const COUNTRY = /^[A-Z]{2}$/;

export function ContentsPills({ item }) {
  return (
    <span className="row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
      {item.hasCert && <StatusPill status="ok">certificate</StatusPill>}
      {item.hasKey && <StatusPill status="pending">private key</StatusPill>}
      {item.hasCsr && <StatusPill status="unknown">signing request</StatusPill>}
      {item.hasChain && <StatusPill status="unknown">chain</StatusPill>}
    </span>
  );
}

function KeyFields({ value, onChange }) {
  return (
    <div className="form-grid">
      <Field label="Key type"><Select value={value.type} onChange={(v) => onChange({ ...value, type: v })} options={KEY_TYPES} /></Field>
      {value.type === 'rsa'
        ? <Field label="Key size"><Select value={value.bits} onChange={(v) => onChange({ ...value, bits: v })} options={RSA_BITS.map((b) => ({ value: b, label: `${b} bits` }))} /></Field>
        : <Field label="Curve"><Select value={value.curve} onChange={(v) => onChange({ ...value, curve: v })} options={EC_CURVES} /></Field>}
    </div>
  );
}

function SubjectFields({ value, onChange, error }) {
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <Field label="Organization" error={error?.['subject.O']}><TextInput value={value.O} onChange={set('O')} placeholder="Example Ltd" /></Field>
      <Field label="Department" error={error?.['subject.OU']}><TextInput value={value.OU} onChange={set('OU')} placeholder="IT" /></Field>
      <Field label="City" error={error?.['subject.L']}><TextInput value={value.L} onChange={set('L')} /></Field>
      <Field label="State or province" error={error?.['subject.ST']}><TextInput value={value.ST} onChange={set('ST')} /></Field>
      <Field label="Country (two letters)" error={error?.['subject.C'] || (value.C && !COUNTRY.test(value.C) ? 'Two-letter ISO country code, for example DE' : null)}><TextInput value={value.C} onChange={(v) => set('C')(v.toUpperCase())} maxLength={2} placeholder="DE" /></Field>
      <Field label="Email" error={error?.['subject.emailAddress']}><TextInput type="email" value={value.emailAddress} onChange={set('emailAddress')} /></Field>
    </div>
  );
}

// Body for POST /ssl/certs/csr and /ssl/certs/self-signed.
export function generateBody(form) {
  const key = form.key.type === 'rsa' ? { type: 'rsa', bits: Number(form.key.bits) } : { type: 'ec', curve: form.key.curve };
  return { domain: form.domain.trim().toLowerCase(), sans: parseSans(form.sans), key, subject: cleanSubject(form.subject) };
}

const EMPTY_GENERATE = { domain: '', sans: '', key: { type: 'rsa', bits: '2048', curve: 'prime256v1' }, subject: { O: '', OU: '', L: '', ST: '', C: '', emailAddress: '' }, days: 365 };

function GenerateModal({ mode, open, onClose, domains, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ ...EMPTY_GENERATE, domain: domains[0]?.domain || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const selfSigned = mode === 'self-signed';
  const title = selfSigned ? 'Generate a self-signed certificate' : 'Generate a signing request';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...generateBody(form), ...(selfSigned ? { days: Number(form.days) || 365 } : {}) };
      const { data } = await panelApi.post(selfSigned ? '/ssl/certs/self-signed' : '/ssl/certs/csr', body);
      setResult(data);
      toast.success(selfSigned ? `Self-signed certificate for ${body.domain} generated` : `Signing request for ${body.domain} generated`);
      onDone();
    } catch (err) { setError(err); if (!err.fields && !isCapabilityError(err)) toast.error(err); } finally { setBusy(false); }
  };

  const close = () => { setResult(null); setError(null); onClose(); };
  const domainOptions = domains.map((d) => ({ value: d.domain, label: d.domain }));
  const known = domainOptions.some((o) => o.value === form.domain);

  return (
    <Modal open={open} title={title} onClose={close} size="lg" footer={result ? <button className="btn btn-primary" onClick={close}>Done</button> : (
      <>
        <button className="btn" onClick={close}>Cancel</button>
        <Button variant="primary" loading={busy} disabled={!form.domain.trim()} onClick={submit}>Generate</Button>
      </>
    )}>
      {!result && (
        <>
          <p className="muted">{selfSigned ? 'Fine for testing and internal use; browsers warn visitors about it. Use a free certificate or one from a certificate authority for a public site.' : 'Send the request to your certificate authority; the private key stays here, stored encrypted, and is matched automatically when you install the certificate you get back.'}</p>
          <div className="form-grid">
            <Field label="Domain" required help="One of your domains, or a wildcard under it such as *.example.com." error={error?.fields?.domain}>
              {known ? <Select value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} options={[...domainOptions, { value: '__custom', label: 'Type a name…' }]} /> : <TextInput value={form.domain === '__custom' ? '' : form.domain} onChange={(v) => setForm({ ...form, domain: v })} placeholder="*.example.com" autoFocus />}
            </Field>
            <Field label="Additional names" help="One per line or comma-separated (www.example.com, shop.example.com)." error={error?.fields?.sans}><Textarea value={form.sans} onChange={(v) => setForm({ ...form, sans: v })} rows={3} mono /></Field>
            {selfSigned && <Field label="Valid for (days)" error={error?.fields?.days}><NumberInput value={form.days} onChange={(v) => setForm({ ...form, days: v })} min={1} max={3650} nullable={false} /></Field>}
          </div>
          <KeyFields value={form.key} onChange={(key) => setForm({ ...form, key })} />
          <SubjectFields value={form.subject} onChange={(subject) => setForm({ ...form, subject })} error={error?.fields} />
          {error && isCapabilityError(error) && <PanelCapabilityState error={error} />}
          {error && !isCapabilityError(error) && !error.fields && <ErrorBanner error={error} />}
          {error?.fields && !Object.keys(error.fields).some((k) => ['domain', 'sans', 'days'].includes(k) || k.startsWith('subject')) && <ErrorBanner error={error} />}
        </>
      )}
      {result && (
        <>
          <div className="banner banner-warning"><FileKey size={18} /><div><strong>Save the private key now.</strong><p>It is stored encrypted for installs through this panel, but it can never be downloaded again.</p></div></div>
          {selfSigned ? <PemView label="Certificate" value={result.certPem} filename={`${form.domain.replace(/^\*\./, 'wildcard.')}.crt`} /> : <PemView label="Signing request (send this to your certificate authority)" value={result.csrPem} filename={`${form.domain.replace(/^\*\./, 'wildcard.')}.csr`} />}
          <PemView label="Private key" value={result.keyPem} filename={`${form.domain.replace(/^\*\./, 'wildcard.')}.key`} />
          {result.certificate && <CertificateSummary certificate={result.certificate} />}
        </>
      )}
    </Modal>
  );
}

function UploadModal({ open, onClose, domains, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ domain: '', certPem: '', keyPem: '', chainPem: '', csrPem: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const filled = ['certPem', 'keyPem', 'chainPem', 'csrPem'].filter((k) => form[k].trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(filled.map((k) => [k, pem(form[k])]));
      if (form.domain) body.domain = form.domain;
      const { data } = await panelApi.post('/ssl/certs/upload', body);
      setResult(data);
      toast.success(`Stored ${data.cert?.domain ? `for ${data.cert.domain}` : 'successfully'}`);
      onDone();
    } catch (err) { setError(err); if (!err.fields && !isCapabilityError(err)) toast.error(err); } finally { setBusy(false); }
  };
  const close = () => { setResult(null); setError(null); setForm({ domain: '', certPem: '', keyPem: '', chainPem: '', csrPem: '' }); onClose(); };

  return (
    <Modal open={open} title="Upload a certificate, key or signing request" onClose={close} size="lg" footer={result ? <button className="btn btn-primary" onClick={close}>Done</button> : (
      <>
        <button className="btn" onClick={close}>Cancel</button>
        <Button variant="primary" loading={busy} disabled={filled.length === 0} onClick={submit}>Upload</Button>
      </>
    )}>
      {!result && (
        <>
          <p className="muted">Paste any combination. A certificate is matched to a stored key automatically when you install it.</p>
          <Field label="Domain" help="Optional; read from the certificate when left empty." error={error?.fields?.domain}>
            <Select value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} placeholder="From the certificate" options={domains.map((d) => ({ value: d.domain, label: d.domain }))} />
          </Field>
          <div className="form-grid">
            <Field label="Certificate (PEM)" error={error?.fields?.certPem}><Textarea value={form.certPem} onChange={(v) => setForm({ ...form, certPem: v })} rows={6} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label="Private key (PEM)" help="Unencrypted; stored encrypted, never shown again." error={error?.fields?.keyPem}><Textarea value={form.keyPem} onChange={(v) => setForm({ ...form, keyPem: v })} rows={6} mono spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
            <Field label="Chain / CA bundle (PEM)" error={error?.fields?.chainPem}><Textarea value={form.chainPem} onChange={(v) => setForm({ ...form, chainPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label="Signing request (PEM)" error={error?.fields?.csrPem}><Textarea value={form.csrPem} onChange={(v) => setForm({ ...form, csrPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE REQUEST-----" /></Field>
          </div>
          {error && isCapabilityError(error) && <PanelCapabilityState error={error} />}
          {error && !isCapabilityError(error) && !error.fields && <ErrorBanner error={error} />}
          {error?.fields && !['domain', 'certPem', 'keyPem', 'chainPem', 'csrPem'].some((k) => error.fields[k]) && <ErrorBanner error={error} />}
        </>
      )}
      {result && (
        <>
          <KeyValue items={[['Stored as', result.cert?.domain], ['Contents', <ContentsPills key="c" item={result.cert || {}} />]]} />
          {result.certificate && <div style={{ marginTop: 12 }}><CertificateSummary certificate={result.certificate} /></div>}
        </>
      )}
    </Modal>
  );
}

export default function Certificates({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { me } = usePanelMe();
  const table = useTableState({ pageSize: 25, sort: 'created_at', dir: 'desc' });
  const [kind, setKind] = useState('');
  const [modal, setModal] = useState(null);
  const query = queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q, sort: table.state.sort, dir: table.state.dir, kind });
  const certs = usePanelApi(`/ssl/certs${query}`);
  const storage = usePanelApi('/ssl/certs/storage');
  const domains = useMemo(() => accountDomains(me), [me]);
  const counts = storage.data?.counts;
  const reload = () => { certs.refetch(); storage.refetch(); };

  const download = async (item, part) => {
    try {
      const { data } = await panelApi.get(`/ssl/certs/${item.id}/download?part=${part}`);
      downloadText(data.filename, data.content);
    } catch (err) { toast.error(err); }
  };

  const remove = async (item) => {
    const what = [item.hasCert && 'certificate', item.hasKey && 'private key', item.hasCsr && 'signing request'].filter(Boolean).join(', ');
    const ok = await confirm({ title: `Delete the stored ${what} for ${item.domain}?`, message: item.installed ? 'It is installed on a domain; the installed files stay in place, only the stored copy is removed. You will not be able to reinstall it from here.' : 'This cannot be undone. A private key deleted here is gone for good.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await panelApi.delete(`/ssl/certs/${item.id}`);
      toast.success(`Deleted the stored items for ${item.domain}`);
      reload();
    } catch (err) { toast.error(err); }
  };

  const pageError = certs.error && (certs.error.status === 403 || isCapabilityError(certs.error)) ? certs.error : null;
  const unavailable = isCapabilityError(certs.error);
  const rows = certs.data || [];
  const empty = !certs.loading && !certs.error && rows.length === 0 && !table.state.q && !kind;

  const columns = [
    { key: 'domain', label: 'Name', sortable: true, render: (r) => <><strong>{r.domain}</strong>{r.autossl && <> <StatusPill status="pending">AutoSSL</StatusPill></>}</> },
    { key: 'contents', label: 'Contents', render: (r) => <ContentsPills item={r} /> },
    { key: 'issuer', label: 'Issued by', render: (r) => (r.hasCert ? (r.selfSigned ? 'Self-signed' : r.issuer || '—') : <span className="muted">—</span>) },
    { key: 'not_after', label: 'Expires', sortable: true, render: (r) => <ExpiryPill notAfter={r.notAfter} daysRemaining={r.daysRemaining} /> },
    { key: 'state', label: 'State', render: (r) => <StatePill state={r.state} /> },
    { key: 'created_at', label: 'Added', sortable: true, render: (r) => formatDate(r.createdAt).split(',')[0] },
  ];

  return (
    <PanelPage fn={fn} actions={(
      <>
        <button className="btn" disabled={unavailable} onClick={() => setModal('csr')}><FilePlus size={16} /> Generate signing request</button>
        <button className="btn" disabled={unavailable} onClick={() => setModal('self-signed')}><ShieldCheck size={16} /> Self-signed certificate</button>
        <button className="btn btn-primary" disabled={unavailable} onClick={() => setModal('upload')}><Upload size={16} /> Upload</button>
      </>
    )}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={reload} />}
      {!pageError && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat" data-stat="cert"><div className="label">Certificates</div><div className="value">{counts ? counts.cert : '—'}</div></div>
            <div className="stat" data-stat="key"><div className="label">Private keys</div><div className="value">{counts ? counts.key : '—'}</div></div>
            <div className="stat" data-stat="csr"><div className="label">Signing requests</div><div className="value">{counts ? counts.csr : '—'}</div></div>
          </div>
          <Card padded={false}>
            {empty ? (
              <EmptyState icon={FileKey} title="Nothing stored yet">
                <p>Certificates, private keys and signing requests you upload or generate appear here, ready to install on a domain.</p>
                <p className="muted">Start with a signing request for your certificate authority, or upload a certificate you already have.</p>
              </EmptyState>
            ) : (
              <DataTable
                columns={columns} rows={rows} loading={certs.loading} error={certs.error} rowKey={(r) => r.id}
                total={certs.meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
                sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
                searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search by name or issuer…"
                emptyText="No stored item matches"
                toolbar={(
                  <div className="segmented" role="tablist">
                    {KINDS.map((k) => <button key={k.value} type="button" role="tab" aria-selected={kind === k.value} className={kind === k.value ? 'active' : ''} onClick={() => { setKind(k.value); table.setPage(1); }}>{k.label}</button>)}
                  </div>
                )}
                rowActions={(r) => [
                  r.hasCert && { label: 'Install', primary: true, onClick: () => navigate(`${INSTALL_PATH}?certId=${r.id}${r.domain.startsWith('*.') ? '' : `&domain=${encodeURIComponent(r.domain)}`}`) },
                  r.hasCert && { label: 'Download certificate', onClick: () => download(r, 'cert') },
                  r.hasCert && r.hasChain && { label: 'Download full chain', onClick: () => download(r, 'fullchain') },
                  r.hasCsr && { label: 'Download signing request', onClick: () => download(r, 'csr') },
                  { label: 'Delete', danger: true, onClick: () => remove(r) },
                ]}
              />
            )}
          </Card>
          <p className="muted small">Private keys are stored encrypted and are never downloadable; save the key when you generate it. Installing uses the stored key automatically — see <Link to={INSTALL_PATH}>Install certificate</Link>.</p>
        </>
      )}
      {modal === 'upload' && <UploadModal open onClose={() => setModal(null)} domains={domains} onDone={reload} />}
      {(modal === 'csr' || modal === 'self-signed') && <GenerateModal open mode={modal} onClose={() => setModal(null)} domains={domains} onDone={reload} />}
    </PanelPage>
  );
}
