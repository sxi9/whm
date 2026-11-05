import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileKey, Upload, FilePlus, ShieldCheck } from 'lucide-react';
import { Card, StatusPill, EmptyState, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Textarea, NumberInput, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, usePanelMe } from '../../../panel/hooks/usePanel.js';
import { queryString } from '../../../api/client.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { RequestError, ExpiryPill, StatePill, PemView, CertificateSummary, accountDomains, downloadText, isCapabilityError, parseSans, cleanSubject, pem, KEY_TYPES, RSA_BITS, EC_CURVES } from './parts/Shared.jsx';

const INSTALL_PATH = PANEL_FUNCTION_BY_KEY['panel:ssl/install']?.path || '/panel/ssl/install';
const KINDS = [{ value: '', label: 'All' }, { value: 'cert', label: 'Certificates' }, { value: 'key', label: 'Keys' }, { value: 'csr', label: 'Signing requests' }];
const COUNTRY = /^[A-Z]{2}$/;

export function ContentsPills({ item }) {
  const { t } = useT();
  return (
    <span className="row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
      {item.hasCert && <StatusPill status="ok">{t('panel.ssl.part_certificate', 'certificate')}</StatusPill>}
      {item.hasKey && <StatusPill status="pending">{t('panel.ssl.part_key', 'private key')}</StatusPill>}
      {item.hasCsr && <StatusPill status="unknown">{t('panel.ssl.part_csr', 'signing request')}</StatusPill>}
      {item.hasChain && <StatusPill status="unknown">{t('panel.ssl.part_chain', 'chain')}</StatusPill>}
    </span>
  );
}

function KeyFields({ value, onChange }) {
  const { t } = useT();
  return (
    <div className="form-grid">
      <Field label={t('panel.ssl.key_type', 'Key type')}><Select value={value.type} onChange={(v) => onChange({ ...value, type: v })} options={KEY_TYPES} /></Field>
      {value.type === 'rsa'
        ? <Field label={t('panel.ssl.key_size', 'Key size')}><Select value={value.bits} onChange={(v) => onChange({ ...value, bits: v })} options={RSA_BITS.map((b) => ({ value: b, label: fill(t('panel.ssl.n_bits', '{n} bits'), { n: b }) }))} /></Field>
        : <Field label={t('panel.ssl.curve', 'Curve')}><Select value={value.curve} onChange={(v) => onChange({ ...value, curve: v })} options={EC_CURVES} /></Field>}
    </div>
  );
}

function SubjectFields({ value, onChange, error }) {
  const { t } = useT();
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <Field label={t('panel.ssl.organization', 'Organization')} error={error?.['subject.O']}><TextInput value={value.O} onChange={set('O')} placeholder="Example Ltd" /></Field>
      <Field label={t('panel.ssl.department', 'Department')} error={error?.['subject.OU']}><TextInput value={value.OU} onChange={set('OU')} placeholder="IT" /></Field>
      <Field label={t('panel.ssl.city', 'City')} error={error?.['subject.L']}><TextInput value={value.L} onChange={set('L')} /></Field>
      <Field label={t('panel.ssl.state_province', 'State or province')} error={error?.['subject.ST']}><TextInput value={value.ST} onChange={set('ST')} /></Field>
      <Field label={t('panel.ssl.country', 'Country (two letters)')} error={error?.['subject.C'] || (value.C && !COUNTRY.test(value.C) ? t('panel.ssl.country_rule', 'Two-letter ISO country code, for example DE') : null)}><TextInput value={value.C} onChange={(v) => set('C')(v.toUpperCase())} maxLength={2} placeholder="DE" /></Field>
      <Field label={t('panel.ssl.email', 'Email')} error={error?.['subject.emailAddress']}><TextInput type="email" value={value.emailAddress} onChange={set('emailAddress')} /></Field>
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
  const { t } = useT();
  const toast = useToast();
  const [form, setForm] = useState({ ...EMPTY_GENERATE, domain: domains[0]?.domain || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const selfSigned = mode === 'self-signed';
  const title = selfSigned ? t('panel.ssl.generate_self_signed_title', 'Generate a self-signed certificate') : t('panel.ssl.generate_csr_title', 'Generate a signing request');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...generateBody(form), ...(selfSigned ? { days: Number(form.days) || 365 } : {}) };
      const { data } = await panelApi.post(selfSigned ? '/ssl/certs/self-signed' : '/ssl/certs/csr', body);
      setResult(data);
      toast.success(selfSigned ? fill(t('panel.ssl.self_signed_generated', 'Self-signed certificate for {domain} generated'), { domain: body.domain }) : fill(t('panel.ssl.csr_generated', 'Signing request for {domain} generated'), { domain: body.domain }));
      onDone();
    } catch (err) { setError(err); if (!err.fields && !isCapabilityError(err)) toast.error(err); } finally { setBusy(false); }
  };

  const close = () => { setResult(null); setError(null); onClose(); };
  const domainOptions = domains.map((d) => ({ value: d.domain, label: d.domain }));
  const known = domainOptions.some((o) => o.value === form.domain);
  const stem = form.domain.replace(/^\*\./, 'wildcard.');

  return (
    <Modal open={open} title={title} onClose={close} size="lg" footer={result ? <button className="btn btn-primary" onClick={close}>{t('panel.ssl.done', 'Done')}</button> : (
      <>
        <button className="btn" onClick={close}>{t('panel.ssl.cancel', 'Cancel')}</button>
        <Button variant="primary" loading={busy} disabled={!form.domain.trim()} onClick={submit}>{t('panel.ssl.generate', 'Generate')}</Button>
      </>
    )}>
      {!result && (
        <>
          <p className="muted">{selfSigned ? t('panel.ssl.self_signed_help', 'Fine for testing and internal use; browsers warn visitors about it. Use a free certificate or one from a certificate authority for a public site.') : t('panel.ssl.csr_help', 'Send the request to your certificate authority; the private key stays here, stored encrypted, and is matched automatically when you install the certificate you get back.')}</p>
          <div className="form-grid">
            <Field label={t('panel.ssl.col_domain', 'Domain')} required help={t('panel.ssl.generate_domain_help', 'One of your domains, or a wildcard under it such as *.example.com.')} error={error?.fields?.domain}>
              {known ? <Select value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} options={[...domainOptions, { value: '__custom', label: t('panel.ssl.type_a_name', 'Type a name…') }]} /> : <TextInput value={form.domain === '__custom' ? '' : form.domain} onChange={(v) => setForm({ ...form, domain: v })} placeholder="*.example.com" autoFocus />}
            </Field>
            <Field label={t('panel.ssl.additional_names', 'Additional names')} help={t('panel.ssl.additional_names_help', 'One per line or comma-separated (www.example.com, shop.example.com).')} error={error?.fields?.sans}><Textarea value={form.sans} onChange={(v) => setForm({ ...form, sans: v })} rows={3} mono /></Field>
            {selfSigned && <Field label={t('panel.ssl.valid_for_days', 'Valid for (days)')} error={error?.fields?.days}><NumberInput value={form.days} onChange={(v) => setForm({ ...form, days: v })} min={1} max={3650} nullable={false} /></Field>}
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
          <div className="banner banner-warning"><FileKey size={18} /><div><strong>{t('panel.ssl.save_key_now', 'Save the private key now.')}</strong><p>{t('panel.ssl.save_key_help', 'It is stored encrypted for installs through this panel, but it can never be downloaded again.')}</p></div></div>
          {selfSigned ? <PemView label={t('panel.ssl.certificate', 'Certificate')} value={result.certPem} filename={`${stem}.crt`} /> : <PemView label={t('panel.ssl.csr_send_label', 'Signing request (send this to your certificate authority)')} value={result.csrPem} filename={`${stem}.csr`} />}
          <PemView label={t('panel.ssl.private_key', 'Private key')} value={result.keyPem} filename={`${stem}.key`} />
          {result.certificate && <CertificateSummary certificate={result.certificate} />}
        </>
      )}
    </Modal>
  );
}

function UploadModal({ open, onClose, domains, onDone }) {
  const { t } = useT();
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
      toast.success(data.cert?.domain ? fill(t('panel.ssl.stored_for', 'Stored for {domain}'), { domain: data.cert.domain }) : t('panel.ssl.stored_ok', 'Stored successfully'));
      onDone();
    } catch (err) { setError(err); if (!err.fields && !isCapabilityError(err)) toast.error(err); } finally { setBusy(false); }
  };
  const close = () => { setResult(null); setError(null); setForm({ domain: '', certPem: '', keyPem: '', chainPem: '', csrPem: '' }); onClose(); };

  return (
    <Modal open={open} title={t('panel.ssl.upload_title', 'Upload a certificate, key or signing request')} onClose={close} size="lg" footer={result ? <button className="btn btn-primary" onClick={close}>{t('panel.ssl.done', 'Done')}</button> : (
      <>
        <button className="btn" onClick={close}>{t('panel.ssl.cancel', 'Cancel')}</button>
        <Button variant="primary" loading={busy} disabled={filled.length === 0} onClick={submit}>{t('panel.ssl.upload', 'Upload')}</Button>
      </>
    )}>
      {!result && (
        <>
          <p className="muted">{t('panel.ssl.upload_help', 'Paste any combination. A certificate is matched to a stored key automatically when you install it.')}</p>
          <Field label={t('panel.ssl.col_domain', 'Domain')} help={t('panel.ssl.upload_domain_help', 'Optional; read from the certificate when left empty.')} error={error?.fields?.domain}>
            <Select value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} placeholder={t('panel.ssl.from_certificate', 'From the certificate')} options={domains.map((d) => ({ value: d.domain, label: d.domain }))} />
          </Field>
          <div className="form-grid">
            <Field label={t('panel.ssl.cert_pem', 'Certificate (PEM)')} error={error?.fields?.certPem}><Textarea value={form.certPem} onChange={(v) => setForm({ ...form, certPem: v })} rows={6} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label={t('panel.ssl.key_pem', 'Private key (PEM)')} help={t('panel.ssl.key_pem_help_short', 'Unencrypted; stored encrypted, never shown again.')} error={error?.fields?.keyPem}><Textarea value={form.keyPem} onChange={(v) => setForm({ ...form, keyPem: v })} rows={6} mono spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" /></Field>
            <Field label={t('panel.ssl.chain_pem', 'Chain / CA bundle (PEM)')} error={error?.fields?.chainPem}><Textarea value={form.chainPem} onChange={(v) => setForm({ ...form, chainPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" /></Field>
            <Field label={t('panel.ssl.csr_pem', 'Signing request (PEM)')} error={error?.fields?.csrPem}><Textarea value={form.csrPem} onChange={(v) => setForm({ ...form, csrPem: v })} rows={5} mono spellCheck={false} placeholder="-----BEGIN CERTIFICATE REQUEST-----" /></Field>
          </div>
          {error && isCapabilityError(error) && <PanelCapabilityState error={error} />}
          {error && !isCapabilityError(error) && !error.fields && <ErrorBanner error={error} />}
          {error?.fields && !['domain', 'certPem', 'keyPem', 'chainPem', 'csrPem'].some((k) => error.fields[k]) && <ErrorBanner error={error} />}
        </>
      )}
      {result && (
        <>
          <KeyValue items={[[t('panel.ssl.stored_as', 'Stored as'), result.cert?.domain], [t('panel.ssl.col_contents', 'Contents'), <ContentsPills key="c" item={result.cert || {}} />]]} />
          {result.certificate && <div style={{ marginTop: 12 }}><CertificateSummary certificate={result.certificate} /></div>}
        </>
      )}
    </Modal>
  );
}

export default function Certificates({ fn }) {
  const { t } = useT();
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
    const what = [item.hasCert && t('panel.ssl.part_certificate', 'certificate'), item.hasKey && t('panel.ssl.part_key', 'private key'), item.hasCsr && t('panel.ssl.part_csr', 'signing request')].filter(Boolean).join(', ');
    const ok = await confirm({ title: fill(t('panel.ssl.delete_stored_title', 'Delete the stored {what} for {domain}?'), { what, domain: item.domain }), message: item.installed ? t('panel.ssl.delete_installed_help', 'It is installed on a domain; the installed files stay in place, only the stored copy is removed. You will not be able to reinstall it from here.') : t('panel.ssl.delete_stored_help', 'This cannot be undone. A private key deleted here is gone for good.'), confirmLabel: t('panel.ssl.delete', 'Delete'), danger: true });
    if (!ok) return;
    try {
      await panelApi.delete(`/ssl/certs/${item.id}`);
      toast.success(fill(t('panel.ssl.deleted_stored', 'Deleted the stored items for {domain}'), { domain: item.domain }));
      reload();
    } catch (err) { toast.error(err); }
  };

  const pageError = certs.error && (certs.error.status === 403 || isCapabilityError(certs.error)) ? certs.error : null;
  const unavailable = isCapabilityError(certs.error);
  const rows = certs.data || [];
  const empty = !certs.loading && !certs.error && rows.length === 0 && !table.state.q && !kind;

  const columns = [
    { key: 'domain', label: t('panel.ssl.col_name', 'Name'), sortable: true, render: (r) => <><strong>{r.domain}</strong>{r.autossl && <> <StatusPill status="pending">AutoSSL</StatusPill></>}</> },
    { key: 'contents', label: t('panel.ssl.col_contents', 'Contents'), render: (r) => <ContentsPills item={r} /> },
    { key: 'issuer', label: t('panel.ssl.issued_by', 'Issued by'), render: (r) => (r.hasCert ? (r.selfSigned ? t('panel.ssl.self_signed', 'Self-signed') : r.issuer || '—') : <span className="muted">—</span>) },
    { key: 'not_after', label: t('panel.ssl.expires', 'Expires'), sortable: true, render: (r) => <ExpiryPill notAfter={r.notAfter} daysRemaining={r.daysRemaining} /> },
    { key: 'state', label: t('panel.ssl.state', 'State'), render: (r) => <StatePill state={r.state} /> },
    { key: 'created_at', label: t('panel.ssl.col_added', 'Added'), sortable: true, render: (r) => formatDate(r.createdAt).split(',')[0] },
  ];

  return (
    <PanelPage fn={fn} actions={(
      <>
        <button className="btn" disabled={unavailable} onClick={() => setModal('csr')}><FilePlus size={16} /> {t('panel.ssl.generate_csr', 'Generate signing request')}</button>
        <button className="btn" disabled={unavailable} onClick={() => setModal('self-signed')}><ShieldCheck size={16} /> {t('panel.ssl.self_signed_certificate', 'Self-signed certificate')}</button>
        <button className="btn btn-primary" disabled={unavailable} onClick={() => setModal('upload')}><Upload size={16} /> {t('panel.ssl.upload', 'Upload')}</button>
      </>
    )}>
      {pageError && <RequestError error={pageError} fn={fn} onRetry={reload} />}
      {!pageError && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <div className="stat" data-stat="cert"><div className="label">{t('panel.ssl.stat_certificates', 'Certificates')}</div><div className="value">{counts ? counts.cert : '—'}</div></div>
            <div className="stat" data-stat="key"><div className="label">{t('panel.ssl.stat_keys', 'Private keys')}</div><div className="value">{counts ? counts.key : '—'}</div></div>
            <div className="stat" data-stat="csr"><div className="label">{t('panel.ssl.stat_csrs', 'Signing requests')}</div><div className="value">{counts ? counts.csr : '—'}</div></div>
          </div>
          <Card padded={false}>
            {empty ? (
              <EmptyState icon={FileKey} title={t('panel.ssl.nothing_stored', 'Nothing stored yet')}>
                <p>{t('panel.ssl.nothing_stored_help', 'Certificates, private keys and signing requests you upload or generate appear here, ready to install on a domain.')}</p>
                <p className="muted">{t('panel.ssl.nothing_stored_hint', 'Start with a signing request for your certificate authority, or upload a certificate you already have.')}</p>
              </EmptyState>
            ) : (
              <DataTable
                columns={columns} rows={rows} loading={certs.loading} error={certs.error} rowKey={(r) => r.id}
                total={certs.meta?.total ?? null} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
                sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort}
                searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder={t('panel.ssl.search_stored', 'Search by name or issuer…')}
                emptyText={t('panel.ssl.search_stored_empty', 'No stored item matches')}
                toolbar={(
                  <div className="segmented" role="tablist">
                    {KINDS.map((k) => <button key={k.value} type="button" role="tab" aria-selected={kind === k.value} className={kind === k.value ? 'active' : ''} onClick={() => { setKind(k.value); table.setPage(1); }}>{t(`panel.ssl.kind_${k.value || 'all'}`, k.label)}</button>)}
                  </div>
                )}
                rowActions={(r) => [
                  r.hasCert && { label: t('panel.ssl.install', 'Install'), primary: true, onClick: () => navigate(`${INSTALL_PATH}?certId=${r.id}${r.domain.startsWith('*.') ? '' : `&domain=${encodeURIComponent(r.domain)}`}`) },
                  r.hasCert && { label: t('panel.ssl.download_certificate', 'Download certificate'), onClick: () => download(r, 'cert') },
                  r.hasCert && r.hasChain && { label: t('panel.ssl.download_fullchain', 'Download full chain'), onClick: () => download(r, 'fullchain') },
                  r.hasCsr && { label: t('panel.ssl.download_csr', 'Download signing request'), onClick: () => download(r, 'csr') },
                  { label: t('panel.ssl.delete', 'Delete'), danger: true, onClick: () => remove(r) },
                ]}
              />
            )}
          </Card>
          <p className="muted small">{t('panel.ssl.keys_never_downloadable', 'Private keys are stored encrypted and are never downloadable; save the key when you generate it. Installing uses the stored key automatically — see')} <Link to={INSTALL_PATH}>{t('panel.ssl/install.label', 'Install certificate')}</Link>.</p>
        </>
      )}
      {modal === 'upload' && <UploadModal open onClose={() => setModal(null)} domains={domains} onDone={reload} />}
      {(modal === 'csr' || modal === 'self-signed') && <GenerateModal open mode={modal} onClose={() => setModal(null)} domains={domains} onDone={reload} />}
    </PanelPage>
  );
}
