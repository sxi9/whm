import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { TextInput, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ManagerBadge, RebootBanner, useJobRunner, JobPanel, JobHistory, RuntimeInstaller, CodeList } from '../../software/Shared.jsx';

export const TABS = ['runtimes', 'tools', 'search', 'installed', 'history'];

export function readDeepLink(params) {
  const tab = params.get('tab');
  const q = (params.get('q') || '').trim();
  const install = [...new Set((params.get('install') || '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9+._-]{0,127}$/.test(s)))];
  return { tab: TABS.includes(tab) ? tab : install.length || q ? 'search' : 'runtimes', q, install };
}

export default function InstallSoftware({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const link = readDeepLink(params);
  const detect = useApi('/software/pkg/detect');
  const recent = useApi('/software/pkg/recent');
  const runtimeJobs = useApi('/software/runtimes/recent');
  const [tab, setTabState] = useState(link.tab);
  const [q, setQ] = useState(link.q || link.install.join(' '));
  const [searched, setSearched] = useState(link.q || link.install.join(' '));
  const search = useApi(searched ? `/software/pkg/search?q=${encodeURIComponent(searched)}&limit=200` : null, { enabled: Boolean(searched) });
  const table = useTableState({ pageSize: 50 });
  const installed = useApi(`/software/pkg/installed${queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q || undefined })}`, { enabled: tab === 'installed' });
  const [selected, setSelected] = useState(link.install);
  const [preselected, setPreselected] = useState(link.install);
  const [info, setInfo] = useState(null);
  const runner = useJobRunner({ onFinished: () => { search.refetch(); installed.refetch(); recent.refetch(); runtimeJobs.refetch(); detect.refetch(); } });

  const setTab = (next) => {
    setTabState(next);
    const p = new URLSearchParams(params);
    if (next === 'runtimes') p.delete('tab'); else p.set('tab', next);
    setParams(p, { replace: true });
  };
  useEffect(() => { if (link.tab !== tab && params.has('tab')) setTabState(link.tab); }, [link.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = (names) => runner.start(() => api.post('/software/pkg/install', { packages: names }), `Install ${names.join(', ')}`).then(() => { setSelected([]); setPreselected([]); });
  const remove = async (names) => {
    if (!(await confirm({ title: `Remove ${names.length === 1 ? names[0] : `${names.length} packages`}?`, message: 'Packages that depend on these are removed as well. Configuration files are kept (no purge).', confirmLabel: 'Remove', danger: true }))) return;
    runner.start(() => api.post('/software/pkg/remove', { packages: names }), `Remove ${names.join(', ')}`).then(() => setSelected([]));
  };
  const showInfo = async (name) => {
    try { setInfo({ name, loading: true }); const { data } = await api.get(`/software/pkg/info/${encodeURIComponent(name)}`); setInfo(data); } catch (err) { toast.error(err); setInfo(null); }
  };
  const doSearch = (e) => { e?.preventDefault(); const term = q.trim(); if (term) setSearched(term); };

  const columns = [
    { key: 'name', label: 'Package', render: (p) => <button className="link-button" onClick={() => showInfo(p.name)}><code>{p.name}</code></button> },
    { key: 'summary', label: 'Summary', render: (p) => <span className="muted">{p.summary || '—'}</span> },
    { key: 'installed', label: 'Installed', render: (p) => (p.installed || p.version ? <StatusPill status="installed">{p.installedVersion || p.version || 'yes'}</StatusPill> : <StatusPill status="not-installed">no</StatusPill>) },
  ];
  const rowActions = (p) => [
    !(p.installed || p.version) && { label: 'Install', primary: true, onClick: () => install([p.name]) },
    (p.installed || p.version) && { label: 'Remove', danger: true, primary: true, onClick: () => remove([p.name]) },
    { label: 'Details', onClick: () => showInfo(p.name) },
  ];
  const historyJobs = [...(recent.data || []), ...(runtimeJobs.data || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  return (
    <>
      <PageHeader fn={fn} actions={<ManagerBadge detect={detect.data} />} />
      <RequestError error={detect.error} onRetry={detect.refetch} />
      {detect.data && !detect.data.capability && <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>No supported package manager</strong><p>This host has neither apt-get nor dnf/yum; package management is unavailable.</p></div></div>}
      <RebootBanner required={detect.data?.rebootRequired} />
      <Card title="Software" subtitle="PHP, Node.js and Python versions and common tools install with one click (a PHP version no repository carries for this OS is built from the php.net source); anything else is in the repository search." actions={<Button onClick={() => runner.start(() => api.post('/software/pkg/update-index'), 'Refresh package index')} loading={runner.busy}>Refresh package index</Button>}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'runtimes', label: 'Runtimes' }, { value: 'tools', label: 'Tools' }, { value: 'search', label: 'Search repositories' }, { value: 'installed', label: 'Installed packages', count: installed.meta?.installedTotal }, { value: 'history', label: 'History', count: historyJobs.length || undefined }]} />
        {tab === 'runtimes' && <RuntimeInstaller tools={false} onFinished={() => { installed.refetch(); runtimeJobs.refetch(); }} />}
        {tab === 'tools' && <ToolsTab onFinished={() => { installed.refetch(); runtimeJobs.refetch(); }} />}
        {tab === 'search' && (
          <>
            <form className="search" onSubmit={doSearch} style={{ marginBottom: 12 }}>
              <TextInput placeholder="Package name, e.g. imagemagick, php-redis, nginx" value={q} onChange={setQ} />
              <Button type="submit" variant="primary" disabled={!q.trim()}>Search</Button>
            </form>
            {preselected.length > 0 && (
              <div className="action-row" style={{ marginBottom: 12 }}>
                <span>Requested: <CodeList names={preselected} /></span>
                <Button variant="primary" onClick={() => install(preselected)} loading={runner.busy}>Install {preselected.join(', ')}</Button>
                <Button onClick={() => { setPreselected([]); setSelected([]); }}>Dismiss</Button>
              </div>
            )}
            <RequestError error={search.error} onRetry={search.refetch} />
            {search.loading && <Loading text="Searching repositories…" />}
            {search.data && (
              <>
                {selected.length > 0 && <div className="action-row"><Button variant="primary" onClick={() => install(selected)} loading={runner.busy}>Install {selected.length} selected</Button> <Button onClick={() => setSelected([])}>Clear selection</Button></div>}
                <DataTable dense columns={columns} rows={search.data.results} rowKey={(p) => p.name} selectable selected={selected} onSelectedChange={setSelected} rowActions={rowActions} emptyText={`Nothing in the repositories matches "${search.data.q}"`} />
              </>
            )}
            {!searched && <p className="muted">Search the distribution repositories. Installs run non-interactively as a background job with a live log; the panel never prompts for confirmation on the host.</p>}
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
        {tab === 'history' && <JobHistory jobs={historyJobs} emptyText="No software jobs have run yet; runtime and package installs appear here with their logs" onSelect={(id) => runner.setJobId(id)} />}
      </Card>
      <ErrorBanner error={runner.error} />
      <JobPanel runner={runner} />
      <Modal open={Boolean(info)} title={info?.name} onClose={() => setInfo(null)} footer={<Button variant="primary" onClick={() => setInfo(null)}>Close</Button>}>
        {info?.loading ? <Loading /> : info && (
          <KeyValue items={[
            ['Installed', info.installed ? <StatusPill key="i" status="installed">{info.installed}</StatusPill> : <StatusPill key="i" status="not-installed">no</StatusPill>],
            ['Candidate', info.candidate || '—'],
            ['Section / repo', info.section || '—'],
            ['Summary', info.summary || '—'],
            info.homepage && ['Homepage', <a key="h" href={info.homepage} target="_blank" rel="noreferrer">{info.homepage}</a>],
          ]} />
        )}
      </Modal>
    </>
  );
}

// The Tools tab is the catalog's tool grid alone (no runtime cards).
function ToolsTab({ onFinished }) {
  return <RuntimeInstaller only={[]} tools onFinished={onFinished} />;
}
