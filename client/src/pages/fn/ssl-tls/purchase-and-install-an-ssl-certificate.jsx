import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Textarea, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, DomainSelect, SubjectFields, PemView, CertificateSummary, cleanSubject } from '../../ssl/Shared.jsx';

const money = (p, c) => (p == null ? '—' : `${Number(p).toFixed(2)} ${c || 'USD'}`);

export default function PurchaseAndInstall({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const providers = useApi('/ssl/market/providers');
  const orders = useApi('/ssl/market/orders');
  const [form, setForm] = useState({ provider: '', product: '', domain: '', subject: { O: '', OU: '', L: '', ST: '', C: '', emailAddress: '' } });
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [complete, setComplete] = useState({ certPem: '', chainPem: '', orderRef: '' });
  const [result, setResult] = useState(null);

  const provider = providers.data?.find((p) => p.name === form.provider);
  const enabled = (providers.data || []).filter((p) => p.enabled);

  const order = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/ssl/market/orders', { provider: form.provider, product: form.product, domain: form.domain.trim().toLowerCase(), subject: cleanSubject(form.subject) });
      setPlaced(data);
      toast.success(`Order #${data.order.id} recorded for ${data.order.domain}`);
      orders.refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const finish = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/ssl/market/orders/${completing.id}/complete`, { certPem: complete.certPem.trim() + '\n', ...(complete.chainPem.trim() ? { chainPem: complete.chainPem.trim() + '\n' } : {}), ...(complete.orderRef ? { orderRef: complete.orderRef } : {}) });
      setResult(data);
      setCompleting(null);
      setComplete({ certPem: '', chainPem: '', orderRef: '' });
      toast.success(`Certificate installed on ${data.order.domain}`);
      orders.refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const cancel = async (o) => {
    if (!(await confirm({ title: `Cancel order #${o.id}?`, message: 'The generated CSR and key stay in the SSL Storage Manager.', confirmLabel: 'Cancel order', danger: true }))) return;
    try { await api.delete(`/ssl/market/orders/${o.id}`); orders.refetch(); } catch (err) { toast.error(err); }
  };
  const csrFor = async (o) => {
    try { const { data } = await api.get(`/ssl/certs/${o.certId}/download?part=csr`); setPlaced({ order: o, csrPem: data.content, provider: providers.data.find((p) => p.name === o.provider), product: providers.data.find((p) => p.name === o.provider)?.products.find((x) => x.id === o.product) }); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={providers.error || orders.error} onRetry={() => { providers.refetch(); orders.refetch(); }} />
      {providers.loading && !providers.data && <Loading />}
      {providers.data && (
        <>
          <Card title="Providers" subtitle="Certificate vendors come from the Market category. Enable one and add its credentials in Market → Market Provider Manager; this page records orders against it." padded={false}>
            <DataTable dense columns={[
              { key: 'displayName', label: 'Provider' },
              { key: 'enabled', label: 'Status', render: (p) => <StatusPill status={p.enabled ? 'enabled' : 'disabled'} /> },
              { key: 'products', label: 'Products', render: (p) => p.products.map((x) => `${x.name} (${money(x.price, x.currency)}/${x.termMonths}mo)`).join(' · ') || '—' },
              { key: 'url', label: 'Site', render: (p) => (p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a> : '—') },
            ]} rows={providers.data} rowKey={(p) => p.name} emptyText="No providers are configured. Add one in Market Provider Manager." />
            <div style={{ padding: '0 16px 12px' }}><Link className="btn btn-sm" to="/market/market-provider-manager">Market Provider Manager</Link></div>
          </Card>
          <div className="form-grid">
            <Card title="Order a certificate" subtitle={enabled.length ? 'A key and CSR are generated and stored for the domain; the CSR is what you submit to the provider.' : 'Enable a provider first.'}>
              <Field label="Provider"><Select value={form.provider} onChange={(v) => setForm({ ...form, provider: v, product: '' })} placeholder="Select…" options={(providers.data || []).map((p) => ({ value: p.name, label: `${p.displayName}${p.enabled ? '' : ' (disabled)'}`, disabled: !p.enabled }))} /></Field>
              <Field label="Product"><Select value={form.product} onChange={(v) => setForm({ ...form, product: v })} placeholder="Select…" options={(provider?.products || []).map((x) => ({ value: x.id, label: `${x.name} — ${money(x.price, x.currency)} / ${x.termMonths} months` }))} /></Field>
              <Field label="Domain" required><DomainSelect value={form.domain} onChange={(v) => setForm({ ...form, domain: v })} /></Field>
              {provider?.products.find((x) => x.id === form.product)?.wildcard && <p className="muted">Wildcard product: the CSR covers {form.domain || 'example.com'} and *.{form.domain || 'example.com'}.</p>}
            </Card>
            <Card title="Organization (for OV/EV products)">
              <SubjectFields value={form.subject} onChange={(subject) => setForm({ ...form, subject })} />
              <FormActions><Button variant="primary" loading={busy} disabled={!form.provider || !form.product || !form.domain} onClick={order}>Record order and generate CSR</Button></FormActions>
            </Card>
          </div>
        </>
      )}
      {placed && (
        <Card title={`Order #${placed.order.id}: ${placed.order.domain}`} subtitle={placed.order.notes}>
          <KeyValue items={[['Provider', placed.provider?.displayName || placed.order.provider], ['Product', placed.product?.name || placed.order.product], ['Price', money(placed.order.price, placed.order.currency)], ['Status', <StatusPill key="s" status={placed.order.status} />]]} />
          <PemView label="Certificate signing request (submit this to the provider)" value={placed.csrPem} filename={`${placed.order.domain}.csr`} />
          <FormActions><Button variant="primary" onClick={() => { setCompleting(placed.order); setPlaced(null); }}>I have the certificate: install it</Button></FormActions>
        </Card>
      )}
      {result && <Card title={`Installed on ${result.order.domain}`}><CertificateSummary certificate={result.certificate} /><p className="muted">Web server: {result.web === 'applied' ? 'vhost updated' : 'files written; vhost update pending'}.</p></Card>}
      <Card padded={false} title="Orders">
        <DataTable dense columns={[
          { key: 'id', label: '#' },
          { key: 'domain', label: 'Domain', render: (o) => <code>{o.domain}</code> },
          { key: 'account', label: 'Account' },
          { key: 'provider', label: 'Provider' },
          { key: 'product', label: 'Product' },
          { key: 'price', label: 'Price', render: (o) => money(o.price, o.currency) },
          { key: 'status', label: 'Status', render: (o) => <StatusPill status={o.status === 'installed' ? 'ok' : o.status === 'cancelled' ? 'cancelled' : 'pending'}>{o.status}</StatusPill> },
          { key: 'createdAt', label: 'Placed', render: (o) => formatDate(o.createdAt) },
        ]} rows={orders.data || []} emptyText="No orders yet." rowActions={(o) => [
          ['pending', 'submitted', 'issued'].includes(o.status) && { label: 'Install certificate', primary: true, onClick: () => setCompleting(o) },
          o.certId && o.status !== 'installed' && { label: 'Show CSR', onClick: () => csrFor(o) },
          o.status !== 'installed' && o.status !== 'cancelled' && { label: 'Cancel', danger: true, onClick: () => cancel(o) },
        ]} />
      </Card>
      <Modal open={Boolean(completing)} title={`Install the issued certificate for ${completing?.domain}`} onClose={() => setCompleting(null)} size="lg"
        footer={<><Button onClick={() => setCompleting(null)}>Later</Button><Button variant="primary" loading={busy} disabled={!complete.certPem.trim()} onClick={finish}>Install</Button></>}>
        <p className="muted">The private key generated with the order is used automatically; the certificate must match it.</p>
        <Field label="Certificate (PEM)"><Textarea value={complete.certPem} onChange={(v) => setComplete({ ...complete, certPem: v })} rows={7} mono /></Field>
        <Field label="CA bundle (PEM)"><Textarea value={complete.chainPem} onChange={(v) => setComplete({ ...complete, chainPem: v })} rows={4} mono /></Field>
        <Field label="Provider order reference"><TextInput value={complete.orderRef} onChange={(v) => setComplete({ ...complete, orderRef: v })} /></Field>
      </Modal>
    </>
  );
}
