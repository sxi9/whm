import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Search } from 'lucide-react';
import { iconFor } from '../icons.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { FUNCTION_BY_KEY } from '../nav.js';
import { useMergedCategories, useSearch } from '../hooks/usePluginNav.js';
import { useFavorites } from '../hooks/useFavorites.js';
import { Card, KeyValue, StatusPill, Loading, formatBytes, formatDuration } from '../components/Common.jsx';
import { ErrorBanner } from '../components/Form.jsx';
import { NewsBanner } from './cpanel/NewsBanner.jsx';
import { MarketplaceUpdatesNotice } from './cpanel/MarketplaceTab.jsx';

export function HomePage() {
  const { user } = useAuth();
  const { data: status, error, loading, refetch } = useApi('/system/status', { refreshMs: 30_000 });
  const { favorites, toggle } = useFavorites();
  const [q, setQ] = useState('');
  const CATEGORIES = useMergedCategories();
  const searchFunctions = useSearch();
  const matches = useMemo(() => (q.trim() ? new Set(searchFunctions(q).map((f) => f.key)) : null), [q, searchFunctions]);
  const favoriteFns = favorites.map((k) => FUNCTION_BY_KEY[k]).filter(Boolean);
  const server = status?.server;
  const mem = server?.memory;
  const rootDisk = server?.disks?.find((d) => d.mountpoint === '/') || server?.disks?.[0];

  return (
    <div className="home">
      <div className="home-main">
        <NewsBanner />
        <MarketplaceUpdatesNotice />
        <Card title="Favorites" subtitle={favoriteFns.length ? 'Your pinned tools' : 'Click the star on any tool to pin it here.'}>
          {favoriteFns.length > 0 && (
            <div className="tool-grid">
              {favoriteFns.map((f) => <ToolCard key={f.key} fn={f} favorite onToggle={() => toggle(f.key)} />)}
            </div>
          )}
        </Card>

        <Card title="Tools" actions={(
          <div className="search inline">
            <Search size={16} />
            <input className="input" placeholder="Filter tools…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tools" />
          </div>
        )}>
          {CATEGORIES.map((cat) => {
            const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
            if (!fns.length) return null;
            const Icon = iconFor(cat.icon);
            return (
              <section key={cat.slug} className="tool-section">
                <h3><Icon size={18} /> {cat.label} <span className="count">{fns.length}</span></h3>
                <div className="tool-grid">
                  {fns.map((f) => <ToolCard key={f.key} fn={f} favorite={favorites.includes(f.key)} onToggle={() => toggle(f.key)} />)}
                </div>
              </section>
            );
          })}
          {matches && matches.size === 0 && <p className="muted">No tools match “{q}”.</p>}
        </Card>
      </div>

      <aside className="home-side">
        <Card title="Statistics" actions={<button className="link-button" onClick={() => refetch()}>Refresh</button>}>
          {loading && !status && <Loading />}
          <ErrorBanner error={error} onRetry={refetch} />
          {status && (
            <KeyValue items={[
              ['User', user.username],
              ['Hostname', status.hostname],
              ['Main IP', status.mainIp],
              ['Load averages', server.loadAverage.map((n) => n.toFixed(2)).join(' · ')],
              ['Uptime', formatDuration(server.uptimeSeconds)],
              ['Operating system', server.os.name],
              ['Kernel', server.os.kernel],
              ['CPU', `${server.cpu.count} × ${server.cpu.model}`],
              ['Memory', `${formatBytes(mem.totalBytes - mem.availableBytes)} used of ${formatBytes(mem.totalBytes)}`],
              rootDisk && ['Disk (/)', `${formatBytes(rootDisk.usedBytes)} used of ${formatBytes(rootDisk.sizeBytes)} (${rootDisk.usedPercent}%)`],
              ['Accounts', `${status.counts.accounts} (${status.counts.suspended} suspended)`],
              ['Resellers', status.counts.resellers],
              ['Panel', `WHM ${status.panel.version} · ${status.panel.mode}`],
              ['License', <StatusPill key="lic" status={status.license.status === 'unlicensed' ? 'warning' : 'ok'}>{status.license.status}</StatusPill>],
            ]} />
          )}
        </Card>
        <Card title="Service status" subtitle="Monitored services" actions={<Link className="link-button" to="/server-status/service-status">Details</Link>}>
          {status && (
            <ul className="service-dots">
              {status.services.map((s) => (
                <li key={s.name}>
                  <span className={`dot dot-${s.active ? 'ok' : s.installed ? 'bad' : 'muted'}`} />
                  <span>{s.displayName}</span>
                  <small className="muted">{s.active ? 'up' : s.installed ? 'down' : 'not installed'}</small>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>
    </div>
  );
}

function ToolCard({ fn, favorite, onToggle }) {
  return (
    <div className="tool-card">
      <Link to={fn.path} className="tool-link">
        <strong>{fn.label}</strong>
        <small>{fn.description}</small>
      </Link>
      <button className={`icon-button favorite ${favorite ? 'active' : ''}`} onClick={onToggle} aria-label={favorite ? 'Unpin' : 'Pin to favorites'}>
        <Star size={14} fill={favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
