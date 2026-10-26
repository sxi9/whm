import { PageHeader, Card, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, NumberInput, Select, Toggle } from '../../../components/Form.jsx';
import { useSettingsForm, SaveBar, RequestError } from '../../service-config/Shared.jsx';

export default function WebDiskConfiguration({ fn }) {
  const form = useSettingsForm('/service-config/webdisk');
  const { data, draft, set } = form;
  return (
    <>
      <PageHeader fn={fn} description="Settings for the Web Disk (WebDAV) service accounts will use to mount their home directory. The panel does not ship a WebDAV daemon yet: the values are stored here and picked up by the Web Disk service once it exists; nothing on the host changes today." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          {data.live === false && <div className="banner banner-info"><div><strong>Stored for a service that is not built yet.</strong> No WebDAV listener runs on this server and no login is accepted or refused by these settings; they only seed the Web Disk service when it ships.</div></div>}
          <Card title="Service" className="config-fields" subtitle={data.lastUpdate ? `Last changed ${formatDate(data.lastUpdate)}` : undefined}>
            <Field inline><Toggle checked={draft.enabled} onChange={set('enabled')} label="Enable Web Disk" description="Whether the Web Disk service should accept logins once it exists" /></Field>
            <div className="form-grid">
              <Field label="Plain port" help="Default 2077 (only used when SSL is not required)"><NumberInput value={draft.port} onChange={set('port')} min={1} max={65535} nullable={false} /></Field>
              <Field label="SSL port" help="Default 2078"><NumberInput value={draft.sslPort} onChange={set('sslPort')} min={1} max={65535} nullable={false} /></Field>
              <Field label="Idle timeout (minutes)"><NumberInput value={draft.idleTimeoutMinutes} onChange={set('idleTimeoutMinutes')} min={1} max={1440} nullable={false} /></Field>
              <Field label="Maximum upload (MB)"><NumberInput value={draft.maxUploadMb} onChange={set('maxUploadMb')} min={1} nullable={false} /></Field>
              <Field label="Who may use Web Disk"><Select value={draft.allowedAccounts} onChange={set('allowedAccounts')} options={[{ value: 'all', label: 'All accounts with the webdisk feature' }, { value: 'shell', label: 'Only accounts with shell access' }, { value: 'none', label: 'Nobody (administrators only)' }]} /></Field>
            </div>
          </Card>
          <Card title="Security" className="config-fields">
            <Field inline><Toggle checked={draft.requireSsl} onChange={set('requireSsl')} label="Require SSL" description="Plain-text WebDAV sends passwords in the clear; only disable for clients that cannot do TLS" /></Field>
            <Field inline><Toggle checked={draft.allowDigestAuth} onChange={set('allowDigestAuth')} label="Allow Digest authentication" description="Needed by Windows clients over plain HTTP; Basic auth is always available over SSL" /></Field>
            <Field inline><Toggle checked={draft.allowAnonymousDiscovery} onChange={set('allowAnonymousDiscovery')} label="Answer unauthenticated OPTIONS/PROPFIND" description="Lets clients discover the server before logging in" /></Field>
            {!draft.requireSsl && <div className="banner banner-warning"><div>With SSL not required, credentials would travel unencrypted on port {draft.port} once the service runs.</div></div>}
          </Card>
          <SaveBar form={form} label="Save settings" />
        </>
      )}
    </>
  );
}
