import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import { StatusPill, EmptyState, Loading } from '../../components/Common.jsx';
import { Button } from '../../components/Form.jsx';

// The Install Distro Packages page: a curated catalog of what a hosting server
// installs (server/src/lib/package-catalog.js) grouped by area, and the
// repository search behind it with one row per piece of software. Other pages
// deep-link into a catalog entry with installDistroHref().

export const INSTALL_DISTRO_PATH = '/software/install-distro-packages';

// ?entry= opens the catalog on that entry; ?q= is the fallback search when the
// entry is not in the catalog (a marketplace item the catalog does not carry).
export function installDistroHref({ entry, q } = {}) {
  const sp = new URLSearchParams();
  if (entry) sp.set('entry', entry);
  if (q) sp.set('q', q);
  const s = sp.toString();
  return s ? `${INSTALL_DISTRO_PATH}?${s}` : INSTALL_DISTRO_PATH;
}

export function catalogEntryState(entry) {
  if (entry.installed) return { status: 'installed', label: 'installed' };
  if (entry.partial) return { status: 'warning', label: `${entry.packages.filter((p) => p.installed).length} of ${entry.packages.length} installed` };
  if (entry.offered === false) return { status: 'not-installed', label: entry.missing.length === entry.packages.length ? 'not offered' : 'partly offered' };
  if (entry.offered === null) return { status: 'unknown', label: 'not installed' };
  return { status: 'not-installed', label: 'available' };
}

// Install stays available while any missing package is offered: the install
// job installs that subset and reports the rest as skipped.
export const canInstallEntry = (entry) => !entry.installed && entry.packages.some((p) => !p.installed && p.offered !== false);
export const installLabel = (entry, perVersion) => (entry.missing?.length ? 'Install what is offered' : perVersion ? (entry.partial ? 'Install for the rest' : 'Install for all versions') : entry.partial ? 'Install the rest' : 'Install');

export function CatalogEntryCard({ entry, highlight = false, onInstall, busy = false }) {
  const state = catalogEntryState(entry);
  const perVersion = entry.php && !entry.php.unversioned && entry.php.versions.length > 0;
  return (
    <section id={`pkg-${entry.key}`} data-testid={`catalog-${entry.key}`} className={`card catalog-entry ${highlight ? 'is-highlighted' : ''}`} style={{ margin: 0, ...(highlight ? { outline: '2px solid var(--primary)', outlineOffset: 2 } : {}) }}>
      <div className="card-body" style={{ padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{entry.label}{entry.recommended && <span className="pill pill-info" title="Recommended on a hosting server" style={{ marginLeft: 8, verticalAlign: 'middle' }}><Star size={11} /> recommended</span>}</h3>
          </div>
          <StatusPill status={state.status}>{state.label}</StatusPill>
        </div>
        <p className="muted" style={{ margin: '6px 0 8px', fontSize: 13 }}>{entry.description}</p>
        <div className="small muted" style={{ wordBreak: 'break-word' }}>
          {entry.packages.map((p) => <code key={p.name} style={{ marginRight: 6, textDecoration: p.offered === false ? 'line-through' : 'none' }} title={p.installed ? `installed ${p.version || ''}` : p.offered === false ? 'not offered by the configured repositories' : p.candidate ? `candidate ${p.candidate}` : ''}>{p.name}</code>)}
        </div>
        {entry.offered === false && <p className="field-message" style={{ marginTop: 6 }}>Not offered by the configured repositories: {entry.missing.join(', ')}.{entry.requires ? ` ${entry.requires}` : ''}</p>}
        {entry.offered !== false && entry.requires && !entry.installed && <p className="muted small" style={{ marginTop: 6 }}>{entry.requires}</p>}
        {perVersion && (
          <ul className="catalog-php-versions" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 4 }}>
            {entry.php.versions.map((v) => (
              <li key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ minWidth: 64 }}>{v.label}</span>
                <code className="small">{v.name}</code>
                {v.installed ? <StatusPill status="installed">{v.version || 'installed'}</StatusPill> : v.offered === false ? <StatusPill status="not-installed">not offered</StatusPill> : <Button size="sm" loading={busy} onClick={() => onInstall?.(entry, { phpVersion: v.id })}>Install for {v.label}</Button>}
              </li>
            ))}
          </ul>
        )}
        <div className="row-actions" style={{ marginTop: 10, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          {canInstallEntry(entry) && <Button variant="primary" size="sm" loading={busy} onClick={() => onInstall?.(entry)}>{installLabel(entry, perVersion)}</Button>}
          {entry.installed && entry.configure && <Link className="btn btn-sm" to={entry.configure}>Configure</Link>}
        </div>
      </div>
    </section>
  );
}

// Groups as sections of cards. `highlight` is the entry key a deep link named.
export function PackageCatalog({ data, loading = false, highlight = null, onInstall, busy = false, filter = '', onlyMissing = false }) {
  if (loading && !data) return <Loading text="Reading the package list of this host…" />;
  if (!data) return null;
  const needle = filter.trim().toLowerCase();
  const keep = (e) => (!onlyMissing || !e.installed) && (!needle || [e.key, e.label, e.description, ...e.packages.map((p) => p.name)].some((t) => String(t).toLowerCase().includes(needle)));
  const groups = data.groups.map((g) => ({ ...g, entries: g.entries.filter(keep) })).filter((g) => g.entries.length);
  if (!groups.length) return <EmptyState title="Nothing in the catalog matches">Try the repository search for packages outside this list.</EmptyState>;
  return (
    <div className="package-catalog">
      {groups.map((g) => (
        <section key={g.key} className="catalog-group" data-testid={`catalog-group-${g.key}`} style={{ marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 2px' }}>{g.label} <span className="pill pill-muted" style={{ marginLeft: 6 }}>{g.entries.filter((e) => e.installed).length} / {g.entries.length} installed</span></h3>
          <p className="muted small" style={{ margin: '0 0 10px' }}>{g.description}</p>
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {g.entries.map((e) => <CatalogEntryCard key={e.key} entry={e} highlight={e.key === highlight} onInstall={onInstall} busy={busy} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

const KIND_LABEL = { dev: 'development files', debug: 'debug symbols', doc: 'documentation', common: 'shared files', source: 'source', arch: 'another architecture', version: 'another version', runtime: 'runtime library', flavor: 'variant' };
export const variantLabel = (kind) => KIND_LABEL[kind] || kind || 'variant';

function InstalledCell({ p }) {
  return p.installed ? <StatusPill status="installed">{p.installedVersion || 'yes'}</StatusPill> : <StatusPill status="not-installed">no</StatusPill>;
}

// Deduped repository results: one row per piece of software, its folded
// variants behind "Show N more variants", and the "Show everything" switch
// that asks for the raw list instead.
export function SearchResults({ data, onInstall, onRemove, onInfo, busy = false, showAll = false, onShowAll }) {
  const [open, setOpen] = useState({});
  if (!data) return null;
  const toggle = (name) => setOpen((o) => ({ ...o, [name]: !o[name] }));
  const actions = (p) => (
    <div className="row-actions">
      {!p.installed && <Button size="sm" loading={busy} onClick={() => onInstall?.([p.name])}>Install</Button>}
      {p.installed && <Button size="sm" variant="danger-ghost" onClick={() => onRemove?.([p.name])}>Remove</Button>}
      <Button size="sm" variant="ghost" onClick={() => onInfo?.(p.name)}>Details</Button>
    </div>
  );
  const summary = showAll
    ? `${data.shown} of ${data.total} matching package names${data.more ? ` (the first ${data.shown}; narrow the search for the rest)` : ''}`
    : `${data.shown} ${data.shown === 1 ? 'package' : 'packages'}${data.collapsed ? `, ${data.collapsed} ${data.collapsed === 1 ? 'variant' : 'variants'} folded underneath` : ''}${data.more ? `, ${data.truncated} more not shown` : ''} · ${data.total} matching names in the repositories`;
  return (
    <div className="search-results-dedupe">
      <div className="datatable-toolbar" style={{ padding: '0 0 10px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="muted small" data-testid="search-summary">{summary}</span>
        {(data.collapsed > 0 || data.more || showAll) && (
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
            <input type="checkbox" checked={showAll} onChange={(e) => onShowAll?.(e.target.checked)} /> Show everything
          </label>
        )}
      </div>
      <div className="table-wrap">
        <table className="dense">
          <thead><tr><th>Package</th><th>Summary</th><th>Installed</th><th className="actions-col" /></tr></thead>
          <tbody>
            {data.results.length === 0 && <tr><td colSpan={4} className="table-state">Nothing in the repositories matches "{data.q}"</td></tr>}
            {data.results.map((p) => (
              <RowGroup key={p.name} p={p} open={Boolean(open[p.name])} onToggle={() => toggle(p.name)} actions={actions} onInfo={onInfo} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowGroup({ p, open, onToggle, actions, onInfo }) {
  const n = p.variantCount ?? p.variants?.length ?? 0;
  return (
    <>
      <tr>
        <td>
          <button className="link-button" onClick={() => onInfo?.(p.name)}><code>{p.name}</code></button>
          {n > 0 && <div><button type="button" className="link-button small" data-testid={`variants-${p.name}`} onClick={onToggle}>{open ? 'Hide' : 'Show'} {n} more {n === 1 ? 'variant' : 'variants'}</button></div>}
        </td>
        <td><span className="small">{p.summary || '—'}</span></td>
        <td><InstalledCell p={p} /></td>
        <td className="actions-col">{actions(p)}</td>
      </tr>
      {open && p.variants.map((v) => (
        <tr key={v.name} className="catalog-variant" style={{ background: 'var(--surface-2)' }}>
          <td style={{ paddingLeft: 28 }}><button className="link-button" onClick={() => onInfo?.(v.name)}><code>{v.name}</code></button> <span className="pill pill-muted" style={{ marginLeft: 6 }}>{variantLabel(v.kind)}</span></td>
          <td><span className="small">{v.summary || '—'}</span></td>
          <td><InstalledCell p={v} /></td>
          <td className="actions-col">{actions(v)}</td>
        </tr>
      ))}
    </>
  );
}
