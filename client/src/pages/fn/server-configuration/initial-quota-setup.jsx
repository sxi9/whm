import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, Toggle } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, JobCard, LastJob, YesNo } from '../../server-configuration/Shared.jsx';

function quotaState(f) {
  if (f.active.user === true) return <StatusPill status="active">active</StatusPill>;
  if (f.active.user === false) return <StatusPill status="inactive">off</StatusPill>;
  if (!f.supported) return <StatusPill status="unknown">unsupported ({f.fstype})</StatusPill>;
  if (f.userQuotaMounted || f.ext4QuotaFeature) return <StatusPill status="pending">ready (quotaon needed)</StatusPill>;
  if (f.kernelArgsRequired) return <StatusPill status="warning">boot loader change needed</StatusPill>;
  return <StatusPill status="warning">not configured</StatusPill>;
}

// An XFS root filesystem is mounted by the initramfs from the kernel command
// line, so the agent reports the rootflags= change it needs (kernelArgs:
// { method, arg, command, configured }) next to the fstab line. The status
// computes it with group quotas on; the manual block follows the switch the
// same way it does for the fstab line, keeping a group option the mount or
// the fstab line already carries.
export function kernelArgsFor(f, groupQuota) {
  const k = f.kernelArgs;
  if (!k) return null;
  const keepGroup = groupQuota || f.groupQuotaMounted || Boolean(f.fstab?.hasGroupQuota);
  const strip = (s) => (keepGroup ? s : String(s).replace(/,gquota(?=[\s,"']|$)/, ''));
  return { method: k.method, configured: k.configured, arg: strip(k.arg || ''), command: strip(k.command || '') };
}

export function applyStep(f, groupQuota) {
  const k = kernelArgsFor(f, groupQuota);
  if (k) {
    if (k.configured) return `# the boot loader already passes ${k.arg}; reboot so XFS mounts ${f.mountpoint} with the quota options`;
    return `${k.command}\n# then reboot: ${f.mountpoint} is mounted by the initramfs from the kernel command line, so /etc/fstab alone cannot enable quotas on it`;
  }
  if (f.rebootRequired) return '# reboot (XFS applies quota options only at mount time)';
  return `mount -o remount ${f.mountpoint}`;
}

// The server proposes the fstab line with both quota options; the manual
// block must match what "Update fstab and enable" writes with the group
// switch, so the group option is dropped here when the switch is off and
// the line did not already carry one.
export function manualSteps(f, groupQuota) {
  const want = groupQuota ? 'ug' : 'u';
  let diff = '';
  if (f.proposedFstabLine && f.fstab) {
    const line = groupQuota || f.fstab.hasGroupQuota ? f.proposedFstabLine : f.proposedFstabLine.replace(/,(grpquota|gquota)(?=[\s,]|$)/, '');
    diff = `- ${f.fstab.line}\n+ ${line}\n\n# then:\n`;
  }
  return `${diff}${applyStep(f, groupQuota)}\nquotacheck -c${want} -m -f ${f.mountpoint}\nquotaon -${want} ${f.mountpoint}`;
}

export function needsManualSteps(f) {
  return Boolean((f.proposedFstabLine && f.fstab) || f.kernelArgsRequired);
}

export function ManualSteps({ filesystems, groupQuota }) {
  const manual = filesystems.filter(needsManualSteps);
  if (!manual.length) return null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary>Show manual steps</summary>
      {manual.map((f) => (
        <div key={f.mountpoint} style={{ marginTop: 10 }}>
          <div className="muted">{f.mountpoint}{f.fstab ? ` (/etc/fstab line ${f.fstab.lineNo})` : ''}; the "Update fstab and enable" action runs these steps for you, with group quotas following the switch above:</div>
          <pre className="log">{manualSteps(f, groupQuota)}</pre>
        </div>
      ))}
    </details>
  );
}

export function MountOptionsNote({ filesystems }) {
  const xfsRoot = filesystems.find((f) => f.kernelArgs);
  const k = xfsRoot ? kernelArgsFor(xfsRoot, true) : null;
  return (
    <p className="muted" style={{ margin: 0 }}>
      Quotas need the <code>usrquota</code> mount option (or the ext4 <code>quota</code> feature). XFS reads it only at mount time, so an XFS filesystem needs a reboot after the fstab change.
      {k && (
        <>
          {' '}An XFS root filesystem is mounted by the initramfs from the kernel command line, so <code>{xfsRoot.mountpoint}</code> also needs <code>{k.arg}</code> there: <code>grubby --update-kernel=ALL --args=…</code> on the RHEL family, <code>GRUB_CMDLINE_LINUX</code> in <code>/etc/default/grub</code> plus <code>update-grub</code> elsewhere.
          {k.configured
            ? <> The boot loader already passes it; reboot to mount with quotas.</>
            : <> "Update fstab and enable" runs <code>{k.command}</code> for you; reboot afterwards.</>}
        </>
      )}
    </p>
  );
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
    const k = updateFstab ? kernelArgsFor(f, groupQuota) : null;
    const message = updateFstab
      ? k
        ? `The line for ${f.mountpoint} in /etc/fstab is rewritten (a backup is kept as /etc/fstab.whm-bak)${k.configured ? '' : ` and the boot loader is updated (${k.command}) so the kernel mounts ${f.mountpoint} with the quota options`}; quotas become active after the next reboot, when quotacheck and quotaon can follow.`
        : f.rebootRequired
          ? `The line for ${f.mountpoint} in /etc/fstab is rewritten (a backup is kept as /etc/fstab.whm-bak). XFS applies the quota options only at mount time, so quotas become active after the next reboot.`
          : `The line for ${f.mountpoint} in /etc/fstab is rewritten (a backup is kept as /etc/fstab.whm-bak), the filesystem is remounted with the quota options, then quotacheck scans every file before quotaon turns quotas on. The scan can take a long time on large disks.`
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
      <PageHeader fn={fn} description="Disk quotas let packages limit how much space each account may use. This checks the filesystem that holds account home directories and enables user quotas where the mount allows it." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
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
          <CapabilityNotice error={capError} onRetry={() => { setCapError(null); refetch(); }} />
          <JobCard jobId={jobId} title="Quota setup" onFinished={() => refetch()} />
          <Card title="Filesystems" padded={false} actions={<Toggle checked={groupQuota} onChange={setGroupQuota} label="Also enable group quotas" />}>
            <DataTable
              rows={data.filesystems} rowKey={(f) => f.mountpoint}
              columns={[
                { key: 'mountpoint', label: 'Mount point', render: (f) => <><code>{f.mountpoint}</code>{f.holdsHomes && <> <StatusPill status="info">homes</StatusPill></>}<br /><small className="muted">{f.device} · {f.fstype}</small></> },
                { key: 'state', label: 'User quota', render: quotaState },
                { key: 'mount', label: 'Mounted with quota option', render: (f) => <YesNo value={f.userQuotaMounted || Boolean(f.ext4QuotaFeature)} yes={f.ext4QuotaFeature && !f.userQuotaMounted ? 'ext4 quota feature' : 'yes'} no="no" /> },
                { key: 'fstab', label: '/etc/fstab', render: (f) => <>{f.fstab ? <YesNo value={f.fstab.hasUserQuota} yes="has usrquota" no="missing usrquota" /> : <span className="muted">no entry</span>}{f.kernelArgs && <><br /><small className="muted" title={f.kernelArgs.command}>kernel args: {f.kernelArgsRequired ? 'rootflags= missing' : `${f.kernelArgs.arg} set`}</small></>}</> },
                { key: 'files', label: 'Quota files', render: (f) => <span className="muted">{f.quotaFiles.user ? 'aquota.user' : '—'}{f.quotaFiles.group ? ', aquota.group' : ''}</span> },
              ]}
              rowActions={(f) => [
                f.supported && f.active.user !== true && { label: 'Enable quotas', primary: true, disabled: busy === f.mountpoint || !data.toolsInstalled, onClick: () => enable(f, false) },
                f.supported && f.fstab && (!f.fstab.hasUserQuota || f.kernelArgsRequired) && { label: 'Update fstab and enable', danger: true, disabled: busy === f.mountpoint || !data.toolsInstalled, onClick: () => enable(f, true) },
                f.active.user === true && { label: 'Turn off', danger: true, disabled: busy === f.mountpoint, onClick: () => disable(f) },
              ]}
            />
            <div className="card-body">
              <MountOptionsNote filesystems={data.filesystems} />
              <ManualSteps filesystems={data.filesystems} groupQuota={groupQuota} />
            </div>
          </Card>
        </>
      )}
    </>
  );
}
