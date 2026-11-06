import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, AlertTriangle, Info, UserRound } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { InstallPackages } from '../../../components/InstallPackages.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useIsRoot } from '../../databases/Shared.jsx';
import { AccountPicker } from '../../accounts/AccountPicker.jsx';

// Single sign-on from the administration shell (POST /databases/phpmyadmin/open):
// without an account the administrator's user (root), with one exactly the
// token the account panel mints for that customer. The window is opened before
// the request so the browser treats it as the click's own popup; it is closed
// again when no URL comes back. The popup is opened without the `noopener`
// feature (which makes window.open return null) and the opener is severed by
// hand, so the handle exists and the shell itself only navigates when the
// popup was blocked.
export function openSignonWindow() {
  const w = window.open('about:blank', '_blank');
  if (w) w.opener = null;
  return w;
}

export async function openPhpMyAdminAs({ account = null, open = (url, w) => { if (w) w.location = url; else window.location.assign(url); }, win = openSignonWindow } = {}) {
  const w = win();
  try {
    const res = await api.post('/databases/phpmyadmin/open', account ? { account } : {});
    open(res.data.url, w);
    return res.data;
  } catch (err) {
    try { w?.close(); } catch { /* already gone */ }
    throw err;
  }
}

export function OpenAsAccountCard({ onOpened }) {
  const toast = useToast();
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const openAs = async () => {
    setBusy(true);
    try {
      const r = await openPhpMyAdminAs({ account });
      toast.success(`Opened phpMyAdmin as ${account} (${r.user}, this account's databases only)`);
      onOpened?.(r);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title="Open as an account" subtitle="See exactly what a customer sees: phpMyAdmin signed in as that account's hidden sign-on user, with its own databases only. The sign-on is audited with your name.">
      <AccountPicker value={account} onChange={setAccount} />
      <FormActions><Button variant="primary" icon={UserRound} loading={busy} disabled={!account} onClick={openAs} data-open-as="1">Open as account</Button></FormActions>
    </Card>
  );
}

export default function PhpMyAdmin({ fn }) {
  const toast = useToast();
  const isRoot = useIsRoot();
  const { data, loading, error, refetch } = useApi('/databases/phpmyadmin');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => { if (data) setUrl(data.urlOverride || ''); }, [data]);

  const save = async () => {
    setBusy(true);
    try { await api.put('/databases/phpmyadmin', { url: url.trim() }); toast.success(url.trim() ? 'phpMyAdmin URL saved' : 'Using the detected location'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const openAll = async () => {
    setOpening(true);
    try {
      const r = await openPhpMyAdminAs();
      if (r.grantOption === false) toast.warning('The database root of the active profile cannot pass GRANT OPTION on; phpMyAdmin opened with every other privilege.');
    } catch (err) { toast.error(err); } finally { setOpening(false); }
  };

  const sso = Boolean(data?.url && data?.sso);
  const openAction = data?.url && (sso && isRoot
    ? <Button variant="primary" icon={ExternalLink} loading={opening} onClick={openAll} data-open-all="1">Open phpMyAdmin (all databases)</Button>
    : <a className="btn btn-primary" href={data.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={16} /> Open phpMyAdmin</a>);

  return (
    <>
      <PageHeader fn={fn} description="Web-based database administration. The panel detects a phpMyAdmin installation and the web server alias that serves it; with single sign-on you open it signed in as the administrator (every database) or as one of your accounts (that account's databases only)." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Status" actions={openAction}>
            <KeyValue prose items={[
              ['Installed', <StatusPill key="i" status={data.installed ? 'installed' : 'not-installed'}>{data.installed ? `yes${data.version ? ` — version ${data.version}` : ''}` : 'not found'}</StatusPill>],
              ['Location', data.dir ? <code key="d">{data.dir}</code> : '—'],
              ['Configuration', data.configFile ? <code key="c">{data.configFile}</code> : '—'],
              ['Served at', data.urlPath ? <code key="u">{data.urlPath}</code> : <span key="n" className="muted">no web server alias found</span>],
              ['URL', data.url ? <a key="l" href={data.url} target="_blank" rel="noreferrer noopener">{data.url}</a> : '—'],
              ['PHP', <StatusPill key="p" status={data.php ? 'ok' : 'not-installed'}>{data.php ? 'installed' : 'missing'}</StatusPill>],
              ['Single sign-on', <StatusPill key="s" status={sso ? 'enabled' : 'disabled'}>{sso ? 'on — links open signed in' : data.url ? 'off — phpMyAdmin asks for a database user' : 'needs a published address'}</StatusPill>],
            ]} />
            {!data.installed && (
              <div className="banner banner-warning" style={{ marginTop: 12 }}>
                <AlertTriangle size={18} />
                <div>
                  <strong>phpMyAdmin is not installed</strong>
                  <p>Install it with the distribution package{data.packageHint ? <> (<code>{data.packageHint}</code>)</> : <> (<Link to="/software/install-distro-packages?tab=search&q=phpmyadmin">Install Software</Link>)</>}, or unpack a release into one of the detected locations and add an alias in the web server. Checked: {data.candidates?.join(', ')}.</p>
                  {data.package && <InstallPackages packages={[data.package]} onFinished={refetch} />}
                </div>
              </div>
            )}
            {data.installed && !data.urlPath && !data.urlOverride && (
              <div className="banner banner-info" style={{ marginTop: 12 }}><Info size={18} /><div>phpMyAdmin files exist but no Apache/nginx alias serves them. Enable the shipped web config (<code>a2enconf phpmyadmin</code> on Debian) or set the URL below.</div></div>
            )}
            {isRoot && data.installed && data.url && !sso && (
              <div className="banner banner-info" style={{ marginTop: 12 }}><Info size={18} /><div>Single sign-on is off: the link lands on phpMyAdmin's login form. Publish phpMyAdmin under the hostname site and switch on <strong>phpMyAdmin single sign-on</strong> under <Link to="/cpanel/customization">Panel › Customization › Account panel</Link> to open it as the administrator or as an account without a password.</div></div>
            )}
          </Card>
          {sso && <OpenAsAccountCard />}
          {data.webConfigs?.length > 0 && (
            <Card title="Web server configuration" padded={false}>
              <div className="table-wrap"><table><thead><tr><th>File</th><th>Server</th><th>Alias</th><th>Enabled</th></tr></thead><tbody>
                {data.webConfigs.map((w) => <tr key={w.path}><td><code>{w.path}</code></td><td>{w.server}</td><td>{w.urlPath ? <code>{w.urlPath}</code> : '—'}</td><td><StatusPill status={w.enabled ? 'enabled' : 'disabled'}>{w.enabled ? 'yes' : 'no'}</StatusPill></td></tr>)}
              </tbody></table></div>
            </Card>
          )}
          {isRoot && (
            <Card title="URL override" subtitle="Point the panel at a phpMyAdmin hosted elsewhere (a dedicated vhost or another server). Blank uses the detected alias on this server's hostname; single sign-on only works without an override.">
              <Field label="phpMyAdmin URL" help="https://pma.example.com/ or a path such as /phpmyadmin"><TextInput value={url} onChange={setUrl} placeholder={data.urlPath ? `https://${data.hostname}${data.urlPath}` : 'https://pma.example.com/'} /></Field>
              <FormActions><Button variant="primary" loading={busy} onClick={save}>Save</Button></FormActions>
            </Card>
          )}
        </>
      )}
    </>
  );
}
