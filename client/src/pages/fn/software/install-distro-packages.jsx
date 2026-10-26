import { useState } from 'react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, ManagerBadge, RebootBanner, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';

export default function InstallDistroPackages({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const detect = useApi('/software/pkg/detect');
  const recent = useApi('/software/pkg/recent');
  const [tab, setTab] = useState('search');
  const [q, setQ] = useState('');
  const [searched, setSearched] = useState('');
  const search = useApi(searched ? `/software/pkg/search?q=${encodeURIComponent(searched)}&limit=200` : null, { enabled: Boolean(searched) });
  const table = useTableState({ pageSize: 50 });
  const installed = useApi(`/software/pkg/installed${queryString({ page: table.state.page, pageSize: table.state.pageSize, q: table.state.q || undefined })}`, { enabled: tab === 'installed' });
  const [selected, setSelected] = useState([]);
  const [info, setInfo] = useState(null);
  const runner = useJobRunner({ onFinished: () => { search.refetch(); installed.refetch(); recent.refetch(); detect.refetch(); } });

  const install = (names) => runner.start(() => api.post('/software/pkg/install', { packages: names }), `Install ${names.join(', ')}`).then(() => setSelected([]));
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
    { key: 'summary', label: 'Summary', render: (p) => <span className="small">{p.summary || '—'}</span> },
    { key: 'installed', label: 'Installed', render: (p) => (p.installed || p.version ? <StatusPill status="installed">{p.installedVersion || p.version || 'yes'}</StatusPill> : <StatusPill status="not-installed">no</StatusPill>) },
  ];
  const rowActions = (p) => [
    !(p.installed || p.version) && { label: 'Install', primary: true, onClick: () => install([p.name]) },
    (p.installed || p.version) && { label: 'Remove', danger: true, primary: true, onClick: () => remove([p.name]) },
    { label: 'Details', onClick: () => showInfo(p.name) },
  ];

  return (
    <>
      <PageHeader fn={fn} actions={<ManagerBadge detect={detect.data} />} />
      <RequestError error={detect.error} onRetry={detect.refetch} />
      {detect.data && !detect.data.capability && <div className="banner banner-warning"><div><strong>No supported package manager</strong><p>This host has neither apt-get nor dnf/yum; package management is unavailable.</p></div></div>}
      <RebootBanner required={detect.data?.rebootRequired} />
      <Card title="Packages" actions={<Button onClick={() => runner.start(() => api.post('/software/pkg/update-index'), 'Refresh package index')} loading={runner.busy}>Refresh package index</Button>}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'search', label: 'Search repositories' }, { value: 'installed', label: 'Installed packages', count: installed.meta?.installedTotal }, { value: 'history', label: 'History', count: recent.data?.length }]} />
        {tab === 'search' && (
          <>
            <form className="search" onSubmit={doSearch} style={{ marginBottom: 12 }}>
              <input className="input" placeholder="Package name, e.g. imagemagick, php-redis, nginx" value={q} onChange={(e) => setQ(e.target.value)} />
              <Button type="submit" variant="primary" disabled={!q.trim()}>Search</Button>
            </form>
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
