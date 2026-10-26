import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, Select } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, LastApply, DaemonSelector, JobCard, StepList, isCapabilityError } from '../../service-config/Shared.jsx';

export default function NameserverSelection({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/service-config/nameserver');
  const [role, setRole] = useState(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [capError, setCapError] = useState(null);
  const currentRole = role ?? data?.settings?.role ?? 'master';

  const select = async (server, install) => {
    const message = server === 'disabled' ? `Every DNS daemon is stopped and disabled. ${data.zones ?? 0} zone(s) in the panel stop being served from this host.` : `${server} is enabled and started; the other DNS daemon is stopped and disabled. Zones already written by the DNS Functions category stay on disk.`;
    if (!(await confirm({ title: 'Change nameserver software?', message, confirmLabel: 'Apply', danger: server === 'disabled' }))) return;
    setBusy(true); setResult(null); setCapError(null);
    try {
      const { data: d } = await api.put('/service-config/nameserver', { server, role: currentRole, install });
      if (d.job) { setJobId(d.job.id); toast.info(`Installing ${d.package}; select it again when the job finishes`); } else { setResult(d); toast.success(server === 'disabled' ? 'DNS daemons disabled' : `${server} is now the nameserver`); }
      refetch();
    } catch (err) { if (isCapabilityError(err)) setCapError(err); else toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Choose the DNS server software (BIND or PowerDNS) and this server's role. Switching enables and starts the chosen daemon and disables the other; zone management lives under DNS Functions." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Nameserver" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[
              ['Selected in panel', `${data.settings.server} (${data.settings.role})`],
              ['Running now', data.active ? <StatusPill key="a" status="active">{data.active}</StatusPill> : <StatusPill key="a" status="inactive">none</StatusPill>],
              ['DNS Functions category', data.dnsCategory ? <StatusPill key="d" status="ok">loaded</StatusPill> : <StatusPill key="d" status="muted">not loaded</StatusPill>],
              data.dnsLayout && ['BIND layout', data.dnsLayout.flavor ? `${data.dnsLayout.flavor}: ${data.dnsLayout.includeFile || data.dnsLayout.mainConf}` : 'not detected'],
              ['Zones in panel', data.zones ?? '—'],
              ['Package manager', data.detect?.packageManager || 'none detected'],
            ]} />
            <Field label="Role" help="master answers authoritatively for the panel's zones; slave pulls zones from a master; standalone serves local zones only">
              <Select value={currentRole} onChange={setRole} options={[{ value: 'master', label: 'Master (authoritative)' }, { value: 'slave', label: 'Slave (secondary)' }, { value: 'standalone', label: 'Standalone' }]} />
            </Field>
            <RequestError error={capError} onRetry={() => setCapError(null)} />
            <DaemonSelector candidates={data.detect?.candidates || []} current={data.active} selected={data.settings.server} onSelect={select} busy={busy} pkgAvailable={data.pkgAvailable} disabledLabel="Disable DNS service" packageManager={data.detect?.packageManager} />
            {result && <div style={{ marginTop: 12 }}><StepList steps={result.steps} /></div>}
            <p className="muted" style={{ marginTop: 10 }}>PowerDNS is selected and started here; the panel writes BIND-style zone files, so with PowerDNS use its <code>bind</code> backend pointed at the panel's zone directory, or manage zones in <Link to="/dns-functions/dns-zone-manager">DNS Zone Manager</Link> for BIND.</p>
          </Card>
          <JobCard jobId={jobId} title="Package installation" onFinished={() => { refetch(); toast.info('Installation finished; select the nameserver again to enable it'); }} />
        </>
      )}
    </>
  );
}
