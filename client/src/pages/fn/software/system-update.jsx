import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Button, Toggle, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, RebootBanner, useJobRunner, JobPanel, JobHistory } from '../../software/Shared.jsx';

export default function SystemUpdate({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/software/update/status');
  const history = useApi('/system/jobs?type=software.system.update&limit=10');
  const [opts, setOpts] = useState({ dist: true, autoremove: false, refreshIndex: true });
  const [selected, setSelected] = useState([]);
  const runner = useJobRunner({ onFinished: () => { refetch(); history.refetch(); } });

  const run = async (packages) => {
    const what = packages?.length ? `${packages.length} selected package(s)` : `all ${data?.count ?? ''} pending updates`;
    if (!(await confirm({ title: 'Apply operating system updates?', message: `This upgrades ${what} non-interactively (existing config files are kept). Services restarted by the package manager will drop connections briefly.`, confirmLabel: 'Update now' }))) return;
    runner.start(() => api.post('/software/update/run', { ...opts, ...(packages?.length ? { packages } : {}) }), 'System update').then(() => setSelected([]));
  };
  const setAuto = async (autoApply) => {
    try { await api.put('/software/update/auto', { autoApply }); toast.success(autoApply ? 'Nightly automatic updates enabled' : 'Automatic updates disabled'); refetch(); } catch (err) { toast.error(err); }
  };
  const toggleAll = () => setSelected(selected.length === data.packages.length ? [] : data.packages.map((p) => p.name));

  return (
    <>
      <PageHeader fn={fn} actions={data && <Button onClick={() => refetch()} loading={loading}>Re-check</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading text="Checking for updates…" />}
      {data && (
        <>
          <RebootBanner required={data.rebootRequired} />
          <Card title="Pending updates" subtitle={`${data.manager === 'apt' ? 'apt-get dist-upgrade' : `${data.manager} upgrade`} simulation`} actions={<StatusPill status={data.count ? (data.security ? 'warning' : 'info') : 'ok'}>{data.count ? `${data.count} pending · ${data.security} security` : 'up to date'}</StatusPill>}>
            <KeyValue items={[
              ['Last update run', data.lastRun ? <span key="l"><StatusPill status={data.lastRun.status} /> {formatDate(data.lastRun.finished_at || data.lastRun.started_at)}</span> : 'never'],
              ['Last nightly check', data.lastCheck?.at ? `${formatDate(data.lastCheck.at)} · ${data.lastCheck.count} pending` : 'not yet (runs daily at 05:41)'],
              ['Release tier', data.tier],
            ]} />
            <div className="form-grid" style={{ marginTop: 12 }}>
              <Toggle checked={opts.dist} onChange={(v) => setOpts({ ...opts, dist: v })} label="Full upgrade (dist-upgrade)" description="Allows the package manager to install or remove dependencies when a package requires it." />
              <Toggle checked={opts.autoremove} onChange={(v) => setOpts({ ...opts, autoremove: v })} label="Remove unused dependencies afterwards" />
              <Toggle checked={opts.refreshIndex} onChange={(v) => setOpts({ ...opts, refreshIndex: v })} label="Refresh the package index first" />
              <Toggle checked={data.autoApply} onChange={setAuto} label="Apply updates automatically every night" description="The nightly check queues a full upgrade when updates are pending." />
            </div>
            <div className="action-row">
              <Button variant="primary" loading={runner.busy} disabled={!data.count && !selected.length} onClick={() => run()}>Update everything</Button>
              {selected.length > 0 && <Button loading={runner.busy} onClick={() => run(selected)}>Update {selected.length} selected</Button>}
            </div>
            <ErrorBanner error={runner.error} />
            {data.packages.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th className="select-col"><input type="checkbox" checked={selected.length === data.packages.length} onChange={toggleAll} aria-label="Select all" /></th><th>Package</th><th>Installed</th><th>Available</th><th>Repository</th></tr></thead>
                  <tbody>
                    {data.packages.map((p) => (
                      <tr key={p.name}>
                        <td className="select-col"><input type="checkbox" checked={selected.includes(p.name)} onChange={() => setSelected(selected.includes(p.name) ? selected.filter((n) => n !== p.name) : [...selected, p.name])} aria-label={`Select ${p.name}`} /></td>
                        <td><code>{p.name}</code>{p.security && <StatusPill status="warning">security</StatusPill>}</td>
                        <td className="small">{p.current || '—'}</td>
                        <td className="small">{p.candidate}</td>
                        <td className="small">{p.repo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <JobPanel runner={runner} title="Update log" />
      <Card title="Previous runs"><JobHistory jobs={history.data} onSelect={(id) => runner.setJobId(id)} /></Card>
    </>
  );
}
