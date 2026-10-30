import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner, Select } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ManagerBadge, RebootBanner, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';
import { PackageCatalog, SearchResults } from '../../software/PackageCatalog.jsx';

const SEARCH_LIMIT = 60;
const SEARCH_LIMIT_ALL = 500;

// Opens on the curated catalog; ?entry=<key> highlights one entry (the WHM
// Marketplace "Add" buttons land here) and ?q=<term> is the repository search
// behind it, used on its own or as the fallback when the entry is unknown.
export default function InstallDistroPackages({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const entryParam = params.get('entry') || '';
  const qParam = params.get('q') || '';
  const detect = useApi('/software/pkg/detect');
  const recent = useApi('/software/pkg/recent');
  const catalog = useApi('/software/pkg/catalog');
  const [tab, setTab] = useState(entryParam ? 'catalog' : qParam ? 'search' : 'catalog');
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [q, setQ] = useState(qParam);
  const [searched, setSearched] = useState(entryParam ? '' : qParam);
  const [showAll, setShowAll] = useState(false);
  const search = useApi(searched ? `/software/pkg/search${queryString({ q: searched, limit: showAll ? SEARCH_LIMIT_ALL : SEARCH_LIMIT, all: showAll ? 'true' : undefined })}` : null, { enabled: Boolean(searched) });
  const table = useTableState({ pageSize: 50 });
  const installed = useApi(`/software/pkg/installed${queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q || undefined })}`, { enabled: tab === 'installed' });
  const [info, setInfo] = useState(null);
  const runner = useJobRunner({ onFinished: () => { catalog.refetch(); search.refetch(); installed.refetch(); recent.refetch(); detect.refetch(); } });

  const entryKnown = Boolean(entryParam) && Boolean(catalog.data?.groups.some((g) => g.entries.some((e) => e.key === entryParam)));
  // A deep link to something the catalog does not carry falls back to the search for it.
  useEffect(() => {
    if (!entryParam || !catalog.data || entryKnown) return;
    const term = qParam || entryParam;
    setTab('search'); setQ(term); setSearched(term);
  }, [entryParam, qParam, catalog.data, entryKnown]);
  useEffect(() => {
    if (!entryKnown || typeof document === 'undefined') return;
    document.getElementById(`pkg-${entryParam}`)?.scrollIntoView({ block: 'center' });
  }, [entryKnown, entryParam]);

  const install = (names) => runner.start(() => api.post('/software/pkg/install', { packages: names }), `Install ${names.join(', ')}`);
  const installEntry = (entry, { phpVersion } = {}) => runner.start(() => api.post(`/software/pkg/catalog/${encodeURIComponent(entry.key)}/install`, phpVersion ? { phpVersion } : {}), `Install ${entry.label}${phpVersion ? ` for PHP ${phpVersion}` : ''}`);
  const remove = async (names) => {
    if (!(await confirm({ title: `Remove ${names.length === 1 ? names[0] : `${names.length} packages`}?`, message: 'Packages that depend on these are removed as well. Configuration files are kept (no purge).', confirmLabel: 'Remove', danger: true }))) return;
    runner.start(() => api.post('/software/pkg/remove', { packages: names }), `Remove ${names.join(', ')}`);
  };
  const showInfo = async (name) => {
    try { setInfo({ name, loading: true }); const { data } = await api.get(`/software/pkg/info/${encodeURIComponent(name)}`); setInfo(data); } catch (err) { toast.error(err); setInfo(null); }
  };
  const doSearch = (e) => { e?.preventDefault(); const term = q.trim(); if (term) { setShowAll(false); setSearched(term); } };
  const recheck = async () => {
    setRechecking(true);
    try { const { data } = await api.get('/software/pkg/catalog?refresh=true'); catalog.setData(data); toast.success('Repository offers re-checked'); } catch (err) { toast.error(err); } finally { setRechecking(false); }
  };

  const columns = [
    { key: 'name', label: 'Package', render: (p) => <button className="link-button" onClick={() => showInfo(p.name)}><code>{p.name}</code></button> },
    { key: 'summary', label: 'Summary', render: (p) => <span className="small">{p.summary || '—'}</span> },
  ];
  const groupOptions = (catalog.data?.groups || []).map((g) => ({ value: g.key, label: g.label }));
  const catalogView = catalog.data && group ? { ...catalog.data, groups: catalog.data.groups.filter((g) => g.key === group) } : catalog.data;
  const installedCount = catalog.data ? catalog.data.groups.reduce((n, g) => n + g.entries.filter((e) => e.installed).length, 0) : null;

  return (
    <>
      <PageHeader fn={fn} actions={<ManagerBadge detect={detect.data} />} />
      <RequestError error={detect.error} onRetry={detect.refetch} />
      {detect.data && !detect.data.capability && <div className="banner banner-warning"><div><strong>No supported package manager</strong><p>This host has neither apt-get nor dnf/yum; package management is unavailable.</p></div></div>}
      <RebootBanner required={detect.data?.rebootRequired} />
      <Card title="Packages" actions={<Button onClick={() => runner.start(() => api.post('/software/pkg/update-index'), 'Refresh package index').then((d) => { if (d) setTab('installed'); })} loading={runner.busy}>Refresh package index</Button>}>
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'catalog', label: 'Catalog', count: catalog.data ? `${installedCount}/${catalog.data.total}` : undefined },
          { value: 'search', label: 'Search repositories' },
          { value: 'installed', label: 'Installed packages', count: installed.meta?.installedTotal },
          { value: 'history', label: 'History', count: recent.data?.length },
        ]} />
        {tab === 'catalog' && (
          <>
            <RequestError error={catalog.error} onRetry={catalog.refetch} />
            {catalog.data && (
              <div className="datatable-toolbar" style={{ padding: '0 0 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="input" placeholder="Filter the catalog (redis, imagick, fail2ban…)" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 300 }} />
                <Select value={group} onChange={setGroup} options={groupOptions} placeholder="All groups" style={{ maxWidth: 200 }} />
                <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> Only what is not installed</label>
                <span className="muted small" style={{ marginLeft: 'auto' }}>
                  {catalog.data.family === 'rhel' ? 'RHEL family' : 'Debian/Ubuntu'} package names
                  {catalog.data.phpVersions?.length ? ` · PHP ${catalog.data.phpVersions.map((v) => v.id).join(', ')}` : ' · no PHP installed yet'}
                  {catalog.data.offersKnown === false ? ' · repository offers unknown' : ''}
                </span>
                <Button size="sm" loading={rechecking} onClick={recheck}>Re-check repositories</Button>
              </div>
            )}
            <PackageCatalog data={catalogView} loading={catalog.loading} highlight={entryKnown ? entryParam : null} onInstall={installEntry} busy={runner.busy} filter={filter} onlyMissing={onlyMissing} />
            {catalog.data && <p className="muted small" style={{ marginTop: 8 }}>Not in the list? Search the repositories under <button type="button" className="link-button" onClick={() => setTab('search')}>Search repositories</button>. Installs run non-interactively as a background job with a live log; the panel never prompts for confirmation on the host.</p>}
          </>
        )}
        {tab === 'search' && (
          <>
            <form className="search" onSubmit={doSearch} style={{ marginBottom: 12 }}>
              <input className="input" placeholder="Package name, e.g. imagemagick, php-redis, nginx" value={q} onChange={(e) => setQ(e.target.value)} />
              <Button type="submit" variant="primary" disabled={!q.trim()}>Search</Button>
            </form>
            <RequestError error={search.error} onRetry={search.refetch} />
            {search.loading && <Loading text="Searching repositories…" />}
            {search.data && <SearchResults data={search.data} onInstall={install} onRemove={remove} onInfo={showInfo} busy={runner.busy} showAll={showAll} onShowAll={setShowAll} />}
            {!searched && <p className="muted">Searches the distribution repositories by name and shows one row per piece of software; its -dev, -doc, per-version and language-binding packages fold underneath. The curated list of what a hosting server needs is under Catalog.</p>}
          </>
        )}
        {tab === 'installed' && (
          <>
            <RequestError error={installed.error} onRetry={installed.refetch} />
            <DataTable dense searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Filter installed packages" columns={[columns[0], columns[1], { key: 'version', label: 'Version', render: (p) => <code className="small">{p.version}</code> }, { key: 'arch', label: 'Arch' }]}
              rows={installed.data || []} loading={installed.loading} total={installed.meta?.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage} rowKey={(p) => p.name}
              rowActions={(p) => [{ label: 'Remove', danger: true, primary: true, onClick: () => remove([p.name]) }, { label: 'Details', onClick: () => showInfo(p.name) }]} />
          </>
        )}
        {tab === 'history' && <JobHistory jobs={recent.data} emptyText="No package jobs have run yet" onSelect={(id) => runner.setJobId(id)} />}
      </Card>
      <ErrorBanner error={runner.error} />
      <JobPanel runner={runner} />
      <Modal open={Boolean(info)} title={info?.name} onClose={() => setInfo(null)} footer={<Button variant="primary" onClick={() => setInfo(null)}>Close</Button>}>
        {info?.loading ? <Loading /> : info && (
          <dl className="kv">
            <div><dt>Installed</dt><dd>{info.installed ? <StatusPill status="installed">{info.installed}</StatusPill> : <StatusPill status="not-installed">no</StatusPill>}</dd></div>
            <div><dt>Candidate</dt><dd>{info.candidate || '—'}</dd></div>
            <div><dt>Section / repo</dt><dd>{info.section || '—'}</dd></div>
            <div><dt>Summary</dt><dd>{info.summary || '—'}</dd></div>
            {info.homepage && <div><dt>Homepage</dt><dd><a href={info.homepage} target="_blank" rel="noreferrer">{info.homepage}</a></dd></div>}
          </dl>
        )}
      </Modal>
    </>
  );
}
