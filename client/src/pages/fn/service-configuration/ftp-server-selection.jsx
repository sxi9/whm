import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, NumberInput, Select, Toggle, TextInput } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useSettingsForm, SaveBar, RequestError, LastApply, DaemonSelector, JobCard, StepList, isCapabilityError } from '../../service-config/Shared.jsx';

export default function FtpServerSelection({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const form = useSettingsForm('/service-config/ftp', { putPath: '/service-config/ftp/settings' });
  const { data, draft, set } = form;
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [capError, setCapError] = useState(null);

  const select = async (server, install) => {
    const label = server === 'disabled' ? 'disable every FTP daemon' : `switch to ${server}`;
    if (!(await confirm({ title: 'Change FTP server?', message: `This will ${label}. Alternatives are stopped and disabled; active FTP sessions are dropped.`, confirmLabel: 'Apply', danger: server === 'disabled' }))) return;
    setBusy(true); setResult(null); setCapError(null);
    try {
      const { data: d } = await api.put('/service-config/ftp/server', { server, install });
      if (d.job) { setJobId(d.job.id); toast.info(`Installing ${d.package}; the daemon is selected when the job finishes`); } else { setResult(d); toast.success(server === 'disabled' ? 'FTP daemons disabled' : `${server} is now the FTP server`); }
      form.refetch();
    } catch (err) { if (isCapabilityError(err)) setCapError(err); else toast.error(err); } finally { setBusy(false); }
  };

  const activeName = data?.active || (data?.detect?.candidates?.find((c) => c.name === data?.selected && c.unitName) ? data.selected : null);
  return (
    <>
      <PageHeader fn={fn} description="Choose which FTP daemon serves accounts (Pure-FTPd, ProFTPD or vsftpd) and tune passive ports, TLS, limits and chroot. The alternatives are stopped and disabled so only one listens on port 21." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="FTP server" actions={<LastApply apply={data.lastApply} />}>
            <KeyValue items={[['Selected in panel', data.selected], ['Running now', activeName ? <StatusPill key="a" status="active">{activeName}</StatusPill> : <StatusPill key="a" status="inactive">none</StatusPill>], ['Package manager', data.detect?.packageManager || 'none detected']]} />
            <RequestError error={capError} onRetry={() => setCapError(null)} />
            <DaemonSelector candidates={data.detect?.candidates || []} current={data.active} selected={data.selected} onSelect={select} busy={busy} pkgAvailable={data.pkgAvailable} disabledLabel="Disable FTP" packageManager={data.detect?.packageManager} />
            {result && <div style={{ marginTop: 12 }}><StepList steps={result.steps} />{result.config?.error && <div className="banner banner-warning"><div>Daemon switched, but applying the saved settings failed: {result.config.error}</div></div>}</div>}
          </Card>
          <JobCard jobId={jobId} title="Package installation" onFinished={() => { form.refetch(); toast.info('Installation finished; select the daemon again to enable it'); }} />
          <Card title="Daemon settings" className="config-fields" subtitle={data.config?.path ? `Applied to ${data.config.path}${data.config.unit?.unit ? ` and ${data.config.unit.unit} is restarted` : ''}` : 'Saved in the panel and written to whichever daemon is active'}>
            <div className="form-grid">
              <Field label="Passive port range: from"><NumberInput value={draft.passivePortMin} onChange={set('passivePortMin')} min={1024} max={65535} nullable={false} /></Field>
              <Field label="Passive port range: to" help="Open this range in the firewall"><NumberInput value={draft.passivePortMax} onChange={set('passivePortMax')} min={1024} max={65535} nullable={false} /></Field>
              <Field label="Passive address (NAT)" help="Public IPv4 to advertise in PASV replies; empty = detect"><TextInput value={draft.passiveAddress} onChange={set('passiveAddress')} placeholder="203.0.113.5" /></Field>
              <Field label="TLS" help="Certificates come from Manage Service SSL Certificates"><Select value={draft.tls} onChange={set('tls')} options={[{ value: 'off', label: 'Off (plain FTP only)' }, { value: 'optional', label: 'Optional (explicit FTPS allowed)' }, { value: 'required', label: 'Required (refuse plain logins)' }]} /></Field>
              <Field label="Max clients"><NumberInput value={draft.maxClients} onChange={set('maxClients')} min={1} nullable={false} /></Field>
              <Field label="Max clients per IP"><NumberInput value={draft.maxPerIp} onChange={set('maxPerIp')} min={1} nullable={false} /></Field>
              <Field label="Idle timeout (minutes)"><NumberInput value={draft.idleTimeoutMinutes} onChange={set('idleTimeoutMinutes')} min={1} max={1440} nullable={false} /></Field>
            </div>
            <Field inline><Toggle checked={draft.chroot} onChange={set('chroot')} label="Jail users to their home directory (chroot)" /></Field>
            <Field inline><Toggle checked={draft.anonymous} onChange={set('anonymous')} label="Allow anonymous logins" description="Not supported by the ProFTPD renderer; ignored there" /></Field>
            {data.config?.settings && <details style={{ marginTop: 10 }}><summary>Effective values read back from {activeName}</summary><pre className="log">{JSON.stringify(data.config.settings, null, 2)}</pre></details>}
          </Card>
          <SaveBar form={form} label="Save and apply to the FTP daemon" />
        </>
      )}
    </>
  );
}
