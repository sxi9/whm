import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { queryString } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, StatusPill, EmptyState } from '../../../components/Common.jsx';
import { TextInput, Select } from '../../../components/Form.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';
import { MarketplaceTab, MarketplaceDisabledNotice } from '../../cpanel/MarketplaceTab.jsx';

// Hub enabled → the hub catalog (resellers read-only, root manages) with the
// static distribution packages underneath; hub off → the static catalog alone.
export default function WhmMarketplace({ fn }) {
  const { user } = useAuth();
  const status = useApi('/marketplace/status');
  const hubOn = status.data?.enabled === true;
  return (
    <>
      <PageHeader fn={fn} description={hubOn ? 'Plugins published on the WHM marketplace hub, verified and signed by the vendor, plus the distribution packages that extend the host.' : 'Add-ons that extend the panel. This is a read-only catalog for now: each entry links to the distribution packages behind it and the page that configures it once installed.'} />
      {status.data && !hubOn && user?.role === 'root' && <MarketplaceDisabledNotice />}
      {hubOn && <MarketplaceTab manage={user?.role === 'root'} status={status.data} />}
      <StaticCatalog title={hubOn ? 'Distribution packages' : null} />
    </>
  );
}

export function StaticCatalog({ title = null }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const { data, loading, error, refetch } = useApi(`/server-config/marketplace${queryString({ q, category })}`);

  return (
    <>
      <RequestError error={error} onRetry={refetch} />
      {data?.note && !title && <div className="banner banner-info"><div><strong>Marketplace preview</strong><p>{data.note}</p></div></div>}
      <Card padded={false} title={title || undefined} subtitle={title ? 'Host software the panel can install through the package manager; not plugins.' : undefined}>
        <div className="datatable-toolbar" style={{ padding: 12 }}>
          <TextInput value={q} onChange={setQ} placeholder="Search add-ons…" style={{ maxWidth: 280 }} />
          <Select value={category} onChange={setCategory} options={data?.categories || []} placeholder="All categories" style={{ maxWidth: 220 }} />
          {data && <span className="muted">{data.items.length} of {data.total} add-ons · package manager: {data.packageManager || 'none detected'}</span>}
        </div>
        {loading && !data && <Loading />}
        {data && data.items.length === 0 && <EmptyState title="No add-ons match">Try a different search or category.</EmptyState>}
        {data && data.items.length > 0 && (
          <div className="stat-grid" style={{ padding: 12 }}>
            {data.items.map((item) => (
              <section key={item.id} className="card" style={{ margin: 0 }}>
                <div className="card-body">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                    <div><h3 style={{ margin: 0 }}>{item.name}</h3><small className="muted">{item.vendor} · {item.category}</small></div>
                    {item.installed == null ? <StatusPill status="unknown">not detected</StatusPill> : <StatusPill status={item.installed ? 'installed' : 'not-installed'}>{item.installed ? 'installed' : 'not installed'}</StatusPill>}
                  </div>
                  <p style={{ margin: '8px 0' }}>{item.description}</p>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {item.price} · {item.packagesForHost?.length ? <>packages: {item.packagesForHost.map((p) => <code key={p} style={{ marginRight: 4 }}>{p}</code>)}</> : 'packages: see distribution'}
                  </div>
                  <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    {!item.installed && <Link className="btn btn-sm btn-primary" to={item.installPath}>Install packages</Link>}
                    {item.installed && item.configure && <Link className="btn btn-sm" to={item.configure}>Configure</Link>}
                    {item.docs && <a className="btn btn-sm btn-ghost" href={item.docs} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Docs</a>}
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
