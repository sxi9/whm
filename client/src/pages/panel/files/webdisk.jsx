import { useState } from 'react';
import { HardDrive, KeyRound, Laptop, Smartphone } from 'lucide-react';
import { Card, KeyValue, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, PasswordInput, Button, FormActions, Toggle } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';

// The account follows its own rclone install job here (/api/system/jobs is reseller-only).
export const jobStreamPath = (id) => `/panel/webdisk/jobs/${id}/stream`;
export const PASSWORD_MIN_LENGTH = 8;

// What the page says about GET /webdisk.
export function webdiskState(info, t = untranslated) {
  if (!info) return null;
  const a = info.available || {};
  if (!a.apache) return { status: 'not-installed', label: t('panel.webdisk.state_unavailable', 'Not available'), detail: t('panel.webdisk.no_apache', 'Web Disk is published through the web server of this host, which is not installed. Ask your hosting provider.') };
  if (!info.fqdn || !info.serverUrl) return { status: 'pending', label: t('panel.webdisk.state_no_hostname', 'No address yet'), detail: t('panel.webdisk.no_hostname', 'This server has no fully qualified hostname yet, so Web Disk has no address. Ask your hosting provider.') };
  if (info.pending) return { status: 'pending', label: t('panel.webdisk.state_installing', 'Starting'), detail: t('panel.webdisk.installing', 'Web Disk is being set up on the server; this takes a minute the first time.') };
  if (!info.enabled) return { status: 'stopped', label: t('panel.webdisk.state_off', 'Off'), detail: info.hasPassword ? null : t('panel.webdisk.set_password_first', 'Set a Web Disk password below, then switch Web Disk on.') };
  if (info.status === 'failed' || info.unit?.active === false) return { status: 'failed', label: t('panel.webdisk.state_failed', 'Not running'), detail: info.error ? fill(t('panel.webdisk.failed_detail', 'The Web Disk service did not start: {error}. Switch it off and on again; if it keeps failing, ask your hosting provider.'), { error: info.error }) : t('panel.webdisk.failed', 'The Web Disk service is not running. Switch it off and on again; if it keeps failing, ask your hosting provider.') };
  return { status: 'active', label: t('panel.webdisk.state_on', 'On'), detail: null };
}

export function SetPasswordForm({ login, enabled, onDone }) {
  const { t } = useT();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await panelApi.put('/webdisk/password', { password });
      toast.success(data.restarted === false ? t('panel.webdisk.password_saved_restart_failed', 'Password saved, but the Web Disk service could not be restarted; switch it off and on') : t('panel.webdisk.password_saved', 'Web Disk password saved'));
      setPassword('');
      onDone?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="config-fields">
      <RequestError error={error} />
      <div className="form-grid">
        <Field label={t('panel.webdisk.login', 'Login')} htmlFor="webdisk-login" help={t('panel.webdisk.login_help', 'Your account name; it cannot be changed.')}>
          <input id="webdisk-login" value={login} readOnly />
        </Field>
        <Field label={t('panel.webdisk.password', 'Web Disk password')} help={t('panel.webdisk.password_help', 'Used only by the file apps on your devices; it is separate from your panel and FTP passwords. Setting one again replaces the old one.')} error={error?.fields?.password?.[0]} htmlFor="webdisk-password">
          <PasswordInput id="webdisk-password" value={password} onChange={setPassword} minStrength={50} required minLength={PASSWORD_MIN_LENGTH} />
        </Field>
      </div>
      {enabled && <InfoNote>{t('panel.webdisk.password_restart_note', 'Web Disk is on: the service restarts with the new password and connected devices must sign in again.')}</InfoNote>}
      <FormActions>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={password.length < PASSWORD_MIN_LENGTH}>{t('panel.webdisk.set_password', 'Set Web Disk password')}</Button>
      </FormActions>
    </form>
  );
}

export function ClientSetup({ clients, t: tt }) {
  const { t: hookT } = useT();
  const t = tt || hookT;
  if (!clients) return null;
  const url = clients.serverUrl || 'https://server.example.com/webdisk/you/';
  const login = clients.login || 'you';
  const by = Object.fromEntries((clients.clients || []).map((c) => [c.id, c]));
  const sections = [
    { id: 'windows', icon: Laptop, title: t('panel.webdisk.client_windows', 'Windows'), text: fill(t('panel.webdisk.client_windows_text', 'File Explorer › This PC › Map network drive › enter {url}, tick “Connect using different credentials” and sign in with {login} and your Web Disk password. The address {unc} also works in the Run box or an Explorer address bar.'), { url, login, unc: by.windows?.unc || '' }) },
    { id: 'macos', icon: Laptop, title: t('panel.webdisk.client_macos', 'macOS'), text: fill(t('panel.webdisk.client_macos_text', 'Finder › Go › Connect to Server (⌘K) › enter {url} › Connect › sign in as a registered user with {login} and your Web Disk password. The disk appears in the Finder sidebar under Locations.'), { url, login }) },
    { id: 'ios', icon: Smartphone, title: t('panel.webdisk.client_ios', 'iPhone and iPad'), text: fill(t('panel.webdisk.client_ios_text', 'Files app › Browse › ⋯ › Connect to Server › enter {url} › Next › Registered User, name {login} and your Web Disk password. Your home folder then appears under Shared.'), { url, login }) },
    { id: 'android', icon: Smartphone, title: t('panel.webdisk.client_android', 'Android'), text: fill(t('panel.webdisk.client_android_text', 'Use a file manager with WebDAV support (Cx File Explorer, Solid Explorer, Material Files…): add a WebDAV connection with the address {url}, user {login} and your Web Disk password. Some apps ask for host, port 443 and path separately: host is the server name, path is the rest of the address.'), { url, login }) },
    { id: 'linux', icon: Laptop, title: t('panel.webdisk.client_linux', 'Linux'), text: fill(t('panel.webdisk.client_linux_text', 'GNOME Files › Other Locations › Connect to Server › {gvfs}; KDE Dolphin uses webdavs://. For a permanent mount install davfs2 and add {url} to /etc/fstab with your login; any WebDAV client (Cyberduck, rclone, cadaver) works with the same address.'), { url, login, gvfs: by.linux?.gvfs || '' }) },
  ];
  return (
    <Card title={t('panel.webdisk.setup_title', 'Connect your devices')} subtitle={t('panel.webdisk.setup_subtitle', 'Every device needs the Web Disk address, your login and the Web Disk password. The connection is always encrypted (HTTPS, port 443).')}>
      <KeyValue items={[
        [t('panel.webdisk.server_url', 'Web Disk address'), clients.serverUrl ? <code key="u">{clients.serverUrl}</code> : <span key="n" className="muted">{t('panel.webdisk.no_url', 'No address yet')}</span>],
        [t('panel.webdisk.login', 'Login'), <code key="l">{login}</code>],
        [t('panel.webdisk.server_name', 'Server name'), clients.hostname ? <code key="h">{clients.hostname}</code> : null],
        [t('panel.webdisk.port', 'Port'), <code key="p">443</code>],
      ]} />
      <div>
        {sections.map((s) => (
          <div key={s.id} data-client={s.id}>
            <h4><s.icon size={14} /> {s.title}</h4>
            <p>{s.text}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function WebDisk({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, refetch } = usePanelApi('/webdisk');
  const clients = usePanelApi(data?.serverUrl ? '/webdisk/clients' : null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(null);
  const state = webdiskState(data, t);

  const toggle = async (enabled) => {
    if (!enabled && !(await confirm({ title: t('panel.webdisk.off_title', 'Switch Web Disk off?'), message: t('panel.webdisk.off_message', 'Connected devices lose the disk until you switch it on again. Your files and your Web Disk password stay.'), confirmLabel: t('panel.webdisk.off', 'Switch off'), danger: true }))) return;
    setBusy(true);
    try {
      const { data: d } = await panelApi.put('/webdisk', { enabled });
      if (d.pending && d.job) { setJobId(d.job.id); toast.info(t('panel.webdisk.install_started', 'Web Disk is being installed on the server; it switches on when the job finishes.')); } else toast.success(enabled ? t('panel.webdisk.switched_on', 'Web Disk is on') : t('panel.webdisk.switched_off', 'Web Disk is off'));
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;
  if (isCapabilityError(error)) return <PanelPage fn={fn}><PanelCapabilityState error={error} onRetry={refetch} card /></PanelPage>;
  return (
    <PanelPage fn={fn}>
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && !error && <Card><p className="muted">{t('panel.webdisk.loading', 'Loading…')}</p></Card>}
      {data && state && (
        <Card title={t('panel.webdisk.title', 'Web Disk')} subtitle={t('panel.webdisk.subtitle', 'Open your home folder like a drive on your computer or phone: files you copy there land on the server at once.')}>
          <KeyValue items={[
            [t('panel.webdisk.status', 'Status'), <StatusPill key="s" status={state.status}>{state.label}</StatusPill>],
            [t('panel.webdisk.server_url', 'Web Disk address'), data.serverUrl ? <code key="u">{data.serverUrl}</code> : <span key="n" className="muted">{t('panel.webdisk.no_url', 'No address yet')}</span>],
            [t('panel.webdisk.login', 'Login'), <code key="l">{data.login}</code>],
            [t('panel.webdisk.password_set', 'Password'), data.hasPassword ? fill(t('panel.webdisk.password_set_on', 'Set on {date}'), { date: formatDate(data.passwordSetAt) }) : t('panel.webdisk.no_password', 'Not set yet')],
            ...(data.unit ? [[t('panel.webdisk.service', 'Service'), `${data.unit.unit}${data.unit.pid ? ` · PID ${data.unit.pid}` : ''}`]] : []),
          ]} />
          {state.detail && <p className="muted">{state.detail}</p>}
          <Field inline>
            <Toggle checked={data.enabled} onChange={toggle} disabled={busy || data.pending || !data.hasPassword || state.status === 'not-installed' || (!data.enabled && !data.serverUrl)} label={t('panel.webdisk.enable', 'Enable Web Disk')} description={t('panel.webdisk.enable_help', 'Runs a small WebDAV service as your account and publishes it at the address above.')} />
          </Field>
          {jobId && <ProgressLog jobId={jobId} streamPath={jobStreamPath} onFinished={(ev) => { if (ev.type === 'done') toast.success(t('panel.webdisk.switched_on', 'Web Disk is on')); refetch(); }} />}
        </Card>
      )}
      {data && state?.status !== 'not-installed' && (
        <Card title={t('panel.webdisk.password_title', 'Web Disk password')} subtitle={t('panel.webdisk.password_subtitle', 'Devices sign in with your account name and this password.')}>
          <SetPasswordForm login={data.login} enabled={data.enabled} onDone={refetch} />
        </Card>
      )}
      {data && state?.status === 'not-installed' && <Card><EmptyState icon={HardDrive} title={state.label}><p>{state.detail}</p></EmptyState></Card>}
      {data && clients.data && <ClientSetup clients={clients.data} t={t} />}
    </PanelPage>
  );
}
