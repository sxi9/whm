import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, Search, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { iconFor, colorFor } from '../icons.js';
import { useApi } from '../hooks/useApi.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { FUNCTION_BY_KEY } from '../nav.js';
import { useMergedCategories, useSearch } from '../hooks/usePluginNav.js';
import { useFavorites } from '../hooks/useFavorites.js';
import { useCollapsedSections } from '../hooks/useCollapsedSections.js';
import { Card, KeyValue, StatusPill, Loading, formatBytes, formatDuration } from '../components/Common.jsx';
import { ErrorBanner } from '../components/Form.jsx';
import { NewsBanner } from './cpanel/NewsBanner.jsx';
import { MarketplaceUpdatesNotice } from './cpanel/MarketplaceTab.jsx';
import { UpdatesBanner } from './home/UpdatesBanner.jsx';

const FAVORITES_KEY = '__favorites';

export function HomePage() {
  const { user } = useAuth();
  const { data: status, error, loading, refetch } = useApi('/system/status', { refreshMs: 30_000 });
  const { favorites, toggle } = useFavorites();
  const sections = useCollapsedSections('whm.home.sections');
  const [q, setQ] = useState('');
  const CATEGORIES = useMergedCategories();
  const searchFunctions = useSearch();
  const matches = useMemo(() => (q.trim() ? new Set(searchFunctions(q).map((f) => f.key)) : null), [q, searchFunctions]);
  const favoriteFns = favorites.map((k) => FUNCTION_BY_KEY[k]).filter(Boolean);
  const favoritesOpen = sections.isOpen(FAVORITES_KEY);
  const server = status?.server;
  const mem = server?.memory;
  const rootDisk = server?.disks?.find((d) => d.mountpoint === '/') || server?.disks?.[0];

  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="home">
      <div className="home-main">
        <div className="home-hero">
          <div>
            <h1>{greeting}, {user.username}</h1>
            <p>{status ? `${status.hostname} · ${status.counts.accounts} accounts · load ${server.loadAverage[0].toFixed(2)}` : 'Loading server status…'}</p>
          </div>
        </div>
        <NewsBanner />
        <MarketplaceUpdatesNotice />
        <UpdatesBanner />
        {favoriteFns.length > 0 && (
          <Card title="Favorites" subtitle="Your pinned tools" className={favoritesOpen ? '' : 'collapsed'} actions={(
            <button type="button" className="icon-button section-toggle" onClick={() => sections.toggle(FAVORITES_KEY)} aria-expanded={favoritesOpen} aria-controls="tools-favorites" aria-label={favoritesOpen ? 'Collapse Favorites' : 'Expand Favorites'}>
              <ChevronDown size={16} />
            </button>
          )}>
            <div id="tools-favorites" className="tool-grid" hidden={!favoritesOpen}>
              {favoritesOpen && favoriteFns.map((f) => <ToolCard key={f.key} fn={f} favorite onToggle={() => toggle(f.key)} />)}
            </div>
          </Card>
        )}

        <Card title="Tools" actions={(
          <>
            <button type="button" className="link-button" onClick={() => sections.expandAll(CATEGORIES.map((c) => c.slug))}><ChevronsUpDown size={14} /> Expand all</button>
            <button type="button" className="link-button" onClick={() => sections.collapseAll(CATEGORIES.map((c) => c.slug))}><ChevronsDownUp size={14} /> Collapse all</button>
            <div className="search inline">
              <Search size={16} />
              <input className="input" placeholder="Filter tools…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tools" />
            </div>
          </>
        )}>
          {CATEGORIES.map((cat) => {
            const fns = matches ? cat.functions.filter((f) => matches.has(f.key)) : cat.functions;
            if (!fns.length) return null;
            const Icon = iconFor(cat.icon);
            // A filter keeps every matching group open so hits are never hidden.
            const open = matches ? true : sections.isOpen(cat.slug);
            const gridId = `tools-${cat.slug}`;
            return (
              <section key={cat.slug} className={`tool-section ${open ? '' : 'collapsed'}`}>
                <h3>
                  <button type="button" className="tool-section-head" onClick={() => sections.toggle(cat.slug)} aria-expanded={open} aria-controls={gridId} disabled={Boolean(matches)}>
                    <ChevronDown size={16} aria-hidden="true" />
                    <span className="nav-tile" style={{ '--tile': colorFor(cat.slug) }}><Icon size={14} strokeWidth={2.25} /></span>
                    <span>{cat.label}</span>
                    <span className="count">{fns.length}</span>
                  </button>
                </h3>
                <div id={gridId} className="tool-grid" hidden={!open}>
                  {open && fns.map((f) => <ToolCard key={f.key} fn={f} favorite={favorites.includes(f.key)} onToggle={() => toggle(f.key)} />)}
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
              ['Panel', `${status.panel.name} ${status.panel.version} · ${status.panel.mode}`],
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
