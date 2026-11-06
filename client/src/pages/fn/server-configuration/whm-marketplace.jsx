import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Info } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { queryString } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, StatusPill, EmptyState } from '../../../components/Common.jsx';
import { TextInput, Select, Button } from '../../../components/Form.jsx';
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
      <PageHeader fn={fn} description={hubOn ? 'Plugins published on the Keel marketplace hub, verified and signed by the vendor, plus the distribution packages that extend the host.' :'Add-ons that extend the panel. This is a read-only catalog for now: each entry links to the distribution packages behind it and the page that configures it once installed.'} />
      {status.data && !hubOn && user?.role === 'root' && <MarketplaceDisabledNotice />}
      {hubOn && <MarketplaceTab manage={user?.role === 'root'} status={status.data} />}
      <StaticCatalog title={hubOn ? 'Distribution packages' : null} showNote={!(status.data && !hubOn && user?.role === 'root')} />
    </>
  );
}

export function StaticCatalog({ title = null, showNote = true }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const { data, loading, error, refetch } = useApi(`/server-config/marketplace${queryString({ q, category })}`);

  return (
    <>
      <RequestError error={error} onRetry={refetch} />
      {data?.note && !title && showNote && <div className="banner banner-info"><Info size={18} /><div><strong>Marketplace preview</strong><p>{data.note}</p></div></div>}
      <Card padded={false} title={title || undefined} subtitle={title ? 'Host software the panel can install through the package manager; not plugins.' : undefined}>
        <div className="datatable-toolbar">
          <TextInput value={q} onChange={setQ} placeholder="Search add-ons…" style={{ maxWidth: 280 }} aria-label="Search add-ons" />
          <Select value={category} onChange={setCategory} options={data?.categories || []} placeholder="All categories" style={{ maxWidth: 220 }} aria-label="Category" />
          {data && <span className="muted">{data.items.length} of {data.total} add-ons · package manager: {data.packageManager || 'none detected'}</span>}
        </div>
        {loading && !data && <Loading />}
        {data && data.items.length === 0 && <EmptyState title="No add-ons match">Add-ons matching the search and category appear here; try a different search or category.</EmptyState>}
        {data && data.items.length > 0 && (
          <div className="grid-2" style={{ padding: 16 }}>
            {data.items.map((item) => (
              <article key={item.id} className="stat" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}><h3>{item.name}</h3><small className="muted">{item.vendor} · {item.category}</small></div>
                  {item.installed == null ? <StatusPill status="unknown">not detected</StatusPill> : <StatusPill status={item.installed ? 'installed' : 'not-installed'}>{item.installed ? 'installed' : 'not installed'}</StatusPill>}
                </div>
                <p style={{ margin: 0 }}>{item.description}</p>
                <small className="muted">
                  {item.price} · {item.packagesForHost?.length ? <>packages: {item.packagesForHost.map((p) => <code key={p} style={{ marginRight: 4 }}>{p}</code>)}</> : 'packages: see distribution'}
                </small>
                <div className="row-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: 'auto', paddingTop: 4 }}>
                  {!item.installed && (data.packageManager ? <Link className="btn btn-sm" to={item.installPath}>Install packages</Link> : <Button size="sm" disabled title="No package manager was detected on this host">Install packages</Button>)}
                  {item.installed && item.configure && <Link className="btn btn-sm" to={item.configure}>Configure</Link>}
                  {item.docs && <a className="btn btn-sm btn-ghost" href={item.docs} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Docs</a>}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
