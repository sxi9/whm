import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../ssl/Shared.jsx';
import { LICENSE_PATH } from '../../server-configuration/LicenseTab.jsx';
import { useProviders, ProviderStatus, LastTest, ProviderFormModal, ConfigureModal, TestResultCard, money, TYPE_LABELS } from '../../market/Shared.jsx';

export default function MarketProviderManager({ fn }) {
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { providers, adapters, refetch } = useProviders({ isRoot });
  const [form, setForm] = useState({ open: false, provider: null });
  const [configuring, setConfiguring] = useState(null);
  const [testing, setTesting] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const rows = providers.data || [];
  const act = async (run) => {
    try { await run(); refetch(); } catch (err) { toast.error(err); }
  };
  const toggle = (p) => act(async () => {
    const { data } = await api.post(`/market/providers/${p.name}/${p.enabled ? 'disable' : 'enable'}`);
    toast.success(`${data.displayName} ${data.enabled ? 'enabled' : 'disabled'}`);
  });
  const test = async (p) => {
    setTesting(p.name);
    try {
      const { data } = await api.post(`/market/providers/${p.name}/test`);
      setLastResult(data);
      (data.result.ok ? toast.success : toast.error)(`${data.provider.displayName}: ${data.result.message}`);
      providers.refetch();
    } catch (err) { setLastResult(null); toast.error(err); } finally { setTesting(null); }
  };
  const sync = (p) => act(async () => {
    const { data } = await api.post(`/market/providers/${p.name}/products/sync`);
    toast.success(`${data.displayName}: ${data.products.length} product${data.products.length === 1 ? '' : 's'} synchronised`);
  });
  const remove = async (p) => {
    if (!(await confirm({ title: `Delete ${p.displayName}?`, message: `Orders already recorded against "${p.name}" keep their history; new orders can no longer be placed with it.`, confirmLabel: 'Delete provider', danger: true, typeToConfirm: p.name }))) return;
    act(async () => { await api.delete(`/market/providers/${p.name}`); toast.success(`${p.displayName} deleted`); });
  };

  const summary = {
    ssl: rows.filter((p) => p.type === 'ssl'), plugin: rows.filter((p) => p.type === 'plugin'),
    enabled: rows.filter((p) => p.enabled).length, attention: rows.filter((p) => !p.readOnly && !p.configured).length,
  };

  return (
    <>
      <PageHeader fn={fn} actions={isRoot && <Button variant="primary" icon={Plus} onClick={() => setForm({ open: true, provider: null })}>Add provider</Button>} />
      <RequestError error={providers.error || adapters.error} onRetry={refetch} />
      {providers.loading && !providers.data && <Loading />}
      {providers.data && (
        <>
          <Card title="Overview" subtitle="Providers supply certificates for Purchase and Install an SSL Certificate and plugins for the Marketplace. ACME clients are reflected from Manage AutoSSL.">
            <KeyValue items={[
              ['SSL providers', `${summary.ssl.length} (${summary.ssl.filter((p) => p.enabled).length} enabled)`],
              ['Plugin providers', `${summary.plugin.length} (${summary.plugin.filter((p) => p.enabled).length} enabled)`],
              ['Needing configuration', summary.attention ? `${summary.attention}` : 'none'],
              ['AutoSSL', (() => { const a = rows.find((p) => p.readOnly && p.enabled); return a ? <span>{a.displayName} · <Link to={a.manageAt}>Manage AutoSSL</Link></span> : <span className="muted">No ACME provider selected · <Link to="/ssl-tls/manage-autossl">Manage AutoSSL</Link></span>; })()],
            ]} />
          </Card>
          <TestResultCard result={lastResult} />
          <Card title="Providers" padded={false}>
            <DataTable dense rows={rows} rowKey={(p) => p.name} columns={[
              { key: 'displayName', label: 'Provider', render: (p) => (
                <div>
                  <strong>{p.displayName}</strong>
                  <div className="muted"><code>{p.name}</code> · {p.adapterLabel}</div>
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https:\/\//, '')}</a>}
                </div>
              ) },
              { key: 'type', label: 'Type', render: (p) => TYPE_LABELS[p.type] || p.type },
              { key: 'enabled', label: 'Status', render: (p) => <ProviderStatus p={p} /> },
              { key: 'products', label: isRoot ? 'Products (resale)' : 'Products', render: (p) => (p.type === 'ssl'
                ? (p.products.length ? <ul className="list-plain">{p.products.map((x) => <li key={x.id || x.name}>{x.name} <span className="muted">{money(x.price, x.currency)}</span></li>)}</ul> : <span className="muted">None</span>)
                : <span className="muted">Catalog from the hub{p.adapter === 'hub' && <><br /><Link to={LICENSE_PATH}>License key is entered under Basic Setup → License</Link></>}</span>) },
              ...(isRoot ? [
                { key: 'commissionPercent', label: 'Commission', align: 'right', render: (p) => (p.readOnly ? '—' : `${p.commissionPercent}%`) },
                { key: 'orders', label: 'Orders', align: 'right', render: (p) => (p.orders == null ? '—' : p.orders) },
                { key: 'lastTest', label: 'Last test', render: (p) => <LastTest p={p} /> },
              ] : []),
            ]} rowActions={(p) => (p.readOnly ? [
              { label: 'Manage AutoSSL', primary: true, onClick: () => navigate(p.manageAt) },
              isRoot && { label: testing === p.name ? 'Testing…' : 'Test', onClick: () => test(p), disabled: testing === p.name },
            ] : [
              isRoot && { label: p.enabled ? 'Disable' : 'Enable', primary: true, onClick: () => toggle(p), disabled: !p.enabled && !p.configured },
              isRoot && { label: 'Configure', primary: !p.configured, onClick: () => setConfiguring(p) },
              isRoot && { label: testing === p.name ? 'Testing…' : 'Test', onClick: () => test(p), disabled: testing === p.name },
              isRoot && { label: 'Edit', onClick: () => setForm({ open: true, provider: p }) },
              isRoot && p.hasProducts && { label: 'Sync products', onClick: () => sync(p) },
              isRoot && !p.builtin && { label: 'Delete', danger: true, onClick: () => remove(p) },
            ])} emptyText="No providers yet. Providers you add appear here next to the built-in marketplace hub and the ACME clients." />
          </Card>
          {!isRoot && <p className="muted">Only the server administrator can enable or configure providers. Enabled SSL providers are available under SSL/TLS › Purchase and Install an SSL Certificate.</p>}
        </>
      )}
      <ProviderFormModal open={form.open} provider={form.provider} adapters={adapters.data} onClose={() => setForm({ open: false, provider: null })} onSaved={() => { setForm({ open: false, provider: null }); refetch(); }} />
      <ConfigureModal open={Boolean(configuring)} provider={configuring} adapters={adapters.data} onClose={() => setConfiguring(null)} onSaved={() => { setConfiguring(null); refetch(); }} />
    </>
  );
}
