import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../../components/Common.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, useJobRunner, JobPanel } from '../../software/Shared.jsx';

export default function RebuildRpmDatabase({ fn }) {
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/software/rpmdb');
  const runner = useJobRunner({ onFinished: () => refetch() });

  const rebuild = async () => {
    if (!(await confirm({ title: fn?.label, message: 'rpm --rebuilddb rewrites the Berkeley DB / SQLite indexes under /var/lib/rpm from the package headers. It runs in the background and can take several minutes on a large host; do not run package operations while it is in progress.', confirmLabel: 'Rebuild RPM database' }))) return;
    runner.start(() => api.post('/software/rpmdb/rebuild'), 'RPM database rebuild');
  };

  if (loading && !data) return <><PageHeader fn={fn} /><Loading /></>;
  if (error) return <><PageHeader fn={fn} /><RequestError error={error} onRetry={refetch} /></>;
  if (data && !data.supported) {
    return (
      <>
        <PageHeader fn={fn} />
        <Card title="Not applicable on this server">
          <div className="banner banner-info">
            <div>
              <strong>This is not an RPM-based system</strong>
              <p>The RPM database only exists on RHEL-family distributions (AlmaLinux, Rocky Linux, CloudLinux, CentOS, Fedora). This host uses <code>{data.manager || 'an unknown package manager'}</code>{data.family === 'debian' ? ' (dpkg), whose database does not need rebuilding; dpkg --configure -a runs as part of System Update when needed.' : '.'}</p>
            </div>
          </div>
          <div className="action-row"><Button variant="primary" disabled>Rebuild RPM database</Button></div>
        </Card>
      </>
    );
  }

  const last = data?.lastRun;
  return (
    <>
      <PageHeader fn={fn} />
      <Card>
        <div className="action-status">
          <KeyValue items={[
            ['Package manager', data.manager],
            ['RPM database', <StatusPill key="s" status="ok">present</StatusPill>],
            ['Last rebuild', last ? <span key="l"><StatusPill status={last.status} /> {formatDate(last.finished_at || last.started_at)}{last.result ? ` · ${last.result.packagesBefore} packages before, ${last.result.packagesAfter} after` : ''}{last.error ? ` · ${last.error}` : ''}</span> : 'never'],
          ]} />
        </div>
        <p className="muted">Use this when rpm or dnf reports a corrupt database (DB_RUNRECOVERY, "rpmdb open failed", stale locks after an interrupted update).</p>
        <div className="action-row"><Button variant="primary" loading={runner.busy} onClick={rebuild}>Rebuild RPM database</Button></div>
        <ErrorBanner error={runner.error} />
      </Card>
      <JobPanel runner={runner} title="Rebuild log" />
    </>
  );
}
