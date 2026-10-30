import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { api, queryString } from '../../../api/client.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, StatusPill, EmptyState } from '../../../components/Common.jsx';
import { TextInput, Select, Button } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../server-configuration/Shared.jsx';
import { MarketplaceTab, MarketplaceDisabledNotice, canSeeHubOrigin, hubLabelOf } from '../../cpanel/MarketplaceTab.jsx';

// Hub enabled → the hub catalog (resellers read-only, root manages) with the
// static distribution packages underneath; hub off → the static catalog alone.
// The hub is named by its origin for the panel owner only; everyone else
// (the API answers them with `hubUrl: null`) sees the generic label.
export default function WhmMarketplace({ fn }) {
  const { user } = useAuth();
  const status = useApi('/marketplace/status');
  const hubOn = status.data?.enabled === true;
  const hubName = canSeeHubOrigin(user) && status.data?.hubUrl ? `the marketplace hub at ${status.data.hubUrl.replace(/^https:\/\//, '').replace(/\/$/, '')}` : `the ${hubLabelOf(status.data)}`;
  return (
    <>
      <PageHeader fn={fn} description={hubOn ? `Plugins published on ${hubName}, verified and signed by the vendor, plus the distribution packages that extend the host.` : 'Add-ons that extend the panel. This is a read-only catalog for now: each entry links to the distribution packages behind it and the page that configures it once installed.'} />
      {status.data && !hubOn && user?.role === 'root' && <MarketplaceDisabledNotice />}
      {hubOn && <MarketplaceTab manage={user?.role === 'root'} status={status.data} />}
      <StaticCatalog title={hubOn ? 'Distribution packages' : null} />
    </>
  );
}

export function StaticCatalog({ title = null }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const { data, loading, error, refetch } = useApi(`/server-config/marketplace${queryString({ q, category })}`);
  // One install job at a time; the item that started it shows the log inline.
  const [install, setInstall] = useState({ itemId: null, jobId: null, busy: null });

  const installPackages = async (item) => {
    setInstall({ itemId: item.id, jobId: null, busy: item.id });
    try {
      const { data: d } = await api.post('/software/pkg/install', { packages: item.packagesForHost });
      setInstall({ itemId: item.id, jobId: d.job.id, busy: null });
    } catch (err) { toast.error(err); setInstall({ itemId: null, jobId: null, busy: null }); }
  };

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
                    {!item.installed && item.packagesForHost?.length > 0 && <Button variant="primary" size="sm" loading={install.busy === item.id} disabled={Boolean(install.jobId) && install.itemId !== item.id} onClick={() => installPackages(item)}>Install packages</Button>}
                    {!item.installed && !item.packagesForHost?.length && <Link className="btn btn-sm btn-primary" to={item.installPath}>Install packages</Link>}
                    {item.installed && item.configure && <Link className="btn btn-sm" to={item.configure}>Configure</Link>}
                    {item.docs && <a className="btn btn-sm btn-ghost" href={item.docs} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Docs</a>}
                  </div>
                  {install.itemId === item.id && install.jobId && (
                    <div style={{ marginTop: 10 }}>
                      <ProgressLog jobId={install.jobId} onFinished={(event) => { if (event.type === 'done') toast.success(`${item.name} packages installed`); refetch(); }} />
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
