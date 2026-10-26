import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle, Field } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, JobCard, LastJob, YesNo } from '../../server-configuration/Shared.jsx';

function quotaState(f) {
  if (f.active.user === true) return <StatusPill status="active">active</StatusPill>;
  if (f.active.user === false) return <StatusPill status="inactive">off</StatusPill>;
  if (!f.supported) return <StatusPill status="unknown">unsupported ({f.fstype})</StatusPill>;
  if (f.userQuotaMounted || f.ext4QuotaFeature) return <StatusPill status="pending">ready (quotaon needed)</StatusPill>;
  return <StatusPill status="warning">not configured</StatusPill>;
}

export default function InitialQuotaSetup({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/server-config/quota');
  const [jobId, setJobId] = useState(null);
  const [groupQuota, setGroupQuota] = useState(true);
  const [busy, setBusy] = useState(null);
  const [capError, setCapError] = useState(null);

  const enable = async (f, updateFstab) => {
    const message = updateFstab
      ? `The line for ${f.mountpoint} in /etc/fstab is rewritten (a backup is kept as /etc/fstab.whm-bak), the filesystem is remounted with the quota options, then quotacheck scans every file before quotaon turns quotas on. The scan can take a long time on large disks.`
      : `quotacheck scans every file on ${f.mountpoint} to build the quota files, then quotaon turns quotas on. The scan can take a long time on large disks.`;
    if (!(await confirm({ title: `Enable quotas on ${f.mountpoint}?`, message, confirmLabel: 'Enable quotas', danger: updateFstab }))) return;
    setBusy(f.mountpoint); setCapError(null);
    try { const { data: d } = await api.post('/server-config/quota/enable', { mountpoint: f.mountpoint, groupQuota, updateFstab }); setJobId(d.job.id); toast.info('Quota setup started; follow the job below'); } catch (err) { if (err.status === 501) setCapError(err); else toast.error(err); } finally { setBusy(null); }
  };
  const disable = async (f) => {
    if (!(await confirm({ title: `Turn quotas off on ${f.mountpoint}?`, message: 'Accounts keep their limits in the panel but the kernel stops enforcing them until quotas are turned on again.', confirmLabel: 'Turn off', danger: true }))) return;
    setBusy(f.mountpoint);
    try { await api.post('/server-config/quota/disable', { mountpoint: f.mountpoint }); toast.success(`Quotas turned off on ${f.mountpoint}`); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  const installTools = async () => {
    setBusy('install');
    try { const { data: d } = await api.post('/server-config/quota/install-tools'); if (d.job) { setJobId(d.job.id); toast.info('Installing the quota package'); } else { toast.success('Quota tools already installed'); refetch(); } } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Disk quotas let packages limit how much space each account may use. This checks the filesystem that holds account home directories, enables user quotas where the mount allows it and otherwise shows the exact /etc/fstab change required." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="form-grid">
            <Card title="Summary" actions={<LastJob job={data.lastJob} />}>
              <KeyValue items={[['Account homes', <code key="h">{data.homeRoot}</code>], ['Filesystem holding homes', data.homeFilesystem ? <code key="f">{data.homeFilesystem}</code> : 'not found'], ['User quotas on that filesystem', <YesNo key="q" value={data.enabled} yes="enabled" no="not enabled" />], ['Quota tools (quotacheck, quotaon, quotaoff, repquota, setquota)', <YesNo key="t" value={data.toolsInstalled} yes="installed" no="missing" />], ['Package disk limits enforceable', <YesNo key="e" value={data.enforceable} yes="yes" no={data.enabled ? 'no: tools missing' : 'no: quotas not enabled'} />]]} />
              {!data.toolsInstalled && (
                <div style={{ marginTop: 12 }}>
                  <CapabilityNotice error={{ code: 'capability_missing', message: `The quota tools are not installed. Install the "${data.installPackages.join('", "')}" package, then enable quotas below.` }} onRetry={refetch} />
                  <div className="row-actions" style={{ marginTop: 8 }}>
                    {data.pkgAvailable ? <Button variant="primary" loading={busy === 'install'} onClick={installTools}>Install quota tools</Button> : <Link className="btn" to="/software/install-distro-packages">Open Install Distro Packages</Link>}
                  </div>
                </div>
              )}
            </Card>
            <Card title="Options">
              <Field inline><Toggle checked={groupQuota} onChange={setGroupQuota} label="Also enable group quotas" description="Adds grpquota alongside usrquota; needed for per-group limits only." /></Field>
              <p className="muted">Quotas are enforced by the kernel per filesystem. The <code>usrquota</code> mount option (or the ext4 <code>quota</code> feature) must be present; <code>quotacheck</code> then builds the accounting files and <code>quotaon</code> activates them. XFS reads its <code>uquota</code> option only at mount time, so it needs a reboot after the fstab change.</p>
            </Card>
          </div>
          <CapabilityNotice error={capError} onRetry={() => { setCapError(null); refetch(); }} />
          <JobCard jobId={jobId} title="Quota setup" onFinished={() => refetch()} />
          <Card title="Filesystems" padded={false}>
            <DataTable
              rows={data.filesystems} rowKey={(f) => f.mountpoint}
              columns={[
                { key: 'mountpoint', label: 'Mount point', render: (f) => <><code>{f.mountpoint}</code>{f.holdsHomes && <> <StatusPill status="info">homes</StatusPill></>}<br /><small className="muted">{f.device} · {f.fstype}</small></> },
                { key: 'state', label: 'User quota', render: quotaState },
                { key: 'mount', label: 'Mounted with quota option', render: (f) => <YesNo value={f.userQuotaMounted || Boolean(f.ext4QuotaFeature)} yes={f.ext4QuotaFeature && !f.userQuotaMounted ? 'ext4 quota feature' : 'yes'} no="no" /> },
                { key: 'fstab', label: '/etc/fstab', render: (f) => (f.fstab ? <YesNo value={f.fstab.hasUserQuota} yes="has usrquota" no="missing usrquota" /> : <span className="muted">no entry</span>) },
                { key: 'files', label: 'Quota files', render: (f) => <span className="muted">{f.quotaFiles.user ? 'aquota.user' : '—'}{f.quotaFiles.group ? ', aquota.group' : ''}</span> },
              ]}
              rowActions={(f) => [
                f.supported && f.active.user !== true && { label: 'Enable quotas', primary: true, disabled: busy === f.mountpoint || !data.toolsInstalled, onClick: () => enable(f, false) },
                f.supported && f.fstab && !f.fstab.hasUserQuota && { label: 'Update fstab and enable', danger: true, disabled: busy === f.mountpoint || !data.toolsInstalled, onClick: () => enable(f, true) },
                f.active.user === true && { label: 'Turn off', danger: true, disabled: busy === f.mountpoint, onClick: () => disable(f) },
              ]}
            />
          </Card>
          {data.filesystems.filter((f) => f.proposedFstabLine).length > 0 && (
            <Card title="Required /etc/fstab change" subtitle="Apply this with the button above, or edit the file yourself and remount (or reboot for XFS)">
              {data.filesystems.filter((f) => f.proposedFstabLine).map((f) => (
                <div key={f.mountpoint} style={{ marginBottom: 10 }}>
                  <div className="muted">{f.mountpoint} (line {f.fstab.lineNo}):</div>
                  <pre className="log">{`- ${f.fstab.line}\n+ ${f.proposedFstabLine}\n\n# then:\nmount -o remount ${f.mountpoint}\nquotacheck -cug -m -f ${f.mountpoint}\nquotaon -ug ${f.mountpoint}`}</pre>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </>
  );
}
