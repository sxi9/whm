import { Info, AlertTriangle, HardDrive } from 'lucide-react';
import { PageHeader, Card, Loading, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, NumberInput, Select, Toggle } from '../../../components/Form.jsx';
import { useSettingsForm, SaveBar, RequestError } from '../../service-config/Shared.jsx';

// The Web Disks that really run are the per-account rclone daemons the account
// panel switches on (contract §71); the port settings below are stored only.
export function WebDisksCard({ disks, hostname, apache }) {
  const list = disks || [];
  return (
    <Card title="Web Disks of the accounts" subtitle={`One WebDAV service per account, run as the account and published under https://${hostname || '<hostname>'}/webdisk/<account>/. Accounts switch theirs on under Files › Web Disk.`} padded={false}>
      {!list.length && <EmptyState icon={HardDrive} title="No account has set up Web Disk yet"><p>{apache === false ? 'Apache is not installed, so no Web Disk can be published under the hostname site.' : 'A Web Disk appears here as soon as an account sets a Web Disk password.'}</p></EmptyState>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account</th><th>Login</th><th>State</th><th>Port</th><th>Address</th><th>Changed</th></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.username}>
                  <td><code>{d.username}</code><div className="muted">{d.domain}</div></td>
                  <td><code>{d.login}</code></td>
                  <td><StatusPill status={d.enabled ? (d.status === 'failed' ? 'failed' : 'active') : 'stopped'}>{d.enabled ? (d.status === 'failed' ? 'Not running' : 'On') : (d.hasPassword ? 'Off' : 'No password')}</StatusPill>{d.error && <div className="muted">{d.error}</div>}</td>
                  <td>{d.port ?? '—'}</td>
                  <td>{d.url ? <code>{d.url}</code> : <span className="muted">—</span>}</td>
                  <td>{d.updatedAt ? formatDate(d.updatedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function WebDiskConfiguration({ fn }) {
  const form = useSettingsForm('/service-config/webdisk');
  const { data, draft, set } = form;
  return (
    <>
      <PageHeader fn={fn} title={fn.label} description="Web Disk lets an account mount its home directory over WebDAV. Each account runs its own service (rclone, as the account, on a loopback port) published under the server hostname site; the port settings below are kept for compatibility and do not drive those services." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && <WebDisksCard disks={data.disks} hostname={data.hostname} apache={data.apache} />}
      {data && draft && (
        <>
          <div className="banner banner-info"><Info size={18} /><div><strong>Legacy settings.</strong> No daemon listens on the ports below: every Web Disk is served over HTTPS on port 443 through the hostname site. The values are stored for configurations that still read them.</div></div>
          <Card title="Service" className="config-fields" subtitle={data.lastUpdate ? `Last changed ${formatDate(data.lastUpdate)}` : undefined}>
            <Field inline><Toggle checked={draft.enabled} onChange={set('enabled')} label="Enable Web Disk" description="Recorded only; accounts switch their own Web Disk on and off" /></Field>
            <div className="form-grid">
              <Field label="Plain port" help="Default 2077 (not used by the per-account services)"><NumberInput value={draft.port} onChange={set('port')} min={1} max={65535} nullable={false} /></Field>
              <Field label="SSL port" help="Default 2078 (not used by the per-account services)"><NumberInput value={draft.sslPort} onChange={set('sslPort')} min={1} max={65535} nullable={false} /></Field>
              <Field label="Idle timeout (minutes)"><NumberInput value={draft.idleTimeoutMinutes} onChange={set('idleTimeoutMinutes')} min={1} max={1440} nullable={false} /></Field>
              <Field label="Maximum upload (MB)"><NumberInput value={draft.maxUploadMb} onChange={set('maxUploadMb')} min={1} nullable={false} /></Field>
              <Field label="Who may use Web Disk"><Select value={draft.allowedAccounts} onChange={set('allowedAccounts')} options={[{ value: 'all', label: 'All accounts with the webdisk feature' }, { value: 'shell', label: 'Only accounts with shell access' }, { value: 'none', label: 'Nobody (administrators only)' }]} /></Field>
            </div>
          </Card>
          <Card title="Security" className="config-fields">
            <Field inline><Toggle checked={draft.requireSsl} onChange={set('requireSsl')} label="Require SSL" description="The per-account services are HTTPS-only regardless" /></Field>
            <Field inline><Toggle checked={draft.allowDigestAuth} onChange={set('allowDigestAuth')} label="Allow Digest authentication" description="Recorded only; the per-account services use Basic authentication over TLS" /></Field>
            <Field inline><Toggle checked={draft.allowAnonymousDiscovery} onChange={set('allowAnonymousDiscovery')} label="Answer unauthenticated OPTIONS/PROPFIND" description="Recorded only" /></Field>
            {!draft.requireSsl && <div className="banner banner-warning"><AlertTriangle size={18} /><div>With SSL not required, a legacy listener on port {draft.port} would carry credentials unencrypted.</div></div>}
          </Card>
          <SaveBar form={form} label="Save settings" />
        </>
      )}
    </>
  );
}
