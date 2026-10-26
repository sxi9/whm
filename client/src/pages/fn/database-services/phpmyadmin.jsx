import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useIsRoot } from '../../databases/Shared.jsx';

export default function PhpMyAdmin({ fn }) {
  const toast = useToast();
  const isRoot = useIsRoot();
  const { data, loading, error, refetch } = useApi('/databases/phpmyadmin');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setUrl(data.urlOverride || ''); }, [data]);

  const save = async () => {
    setBusy(true);
    try { await api.put('/databases/phpmyadmin', { url: url.trim() }); toast.success(url.trim() ? 'phpMyAdmin URL saved' : 'Using the detected location'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Web-based database administration. The panel detects a phpMyAdmin installation and the web server alias that serves it, and links you to it; log in with a database user or root." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <>
          <Card title="Status" actions={data.url && <a className="btn btn-primary" href={data.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={16} /> Open phpMyAdmin</a>}>
            <KeyValue items={[
              ['Installed', <StatusPill key="i" status={data.installed ? 'installed' : 'not-installed'}>{data.installed ? `yes${data.version ? ` — version ${data.version}` : ''}` : 'not found'}</StatusPill>],
              ['Location', data.dir ? <code key="d">{data.dir}</code> : '—'],
              ['Configuration', data.configFile ? <code key="c">{data.configFile}</code> : '—'],
              ['Served at', data.urlPath ? <code key="u">{data.urlPath}</code> : <span key="n" className="muted">no web server alias found</span>],
              ['URL', data.url ? <a key="l" href={data.url} target="_blank" rel="noreferrer noopener">{data.url}</a> : '—'],
              ['PHP', <StatusPill key="p" status={data.php ? 'ok' : 'not-installed'}>{data.php ? 'installed' : 'missing'}</StatusPill>],
            ]} />
            {!data.installed && (
              <div className="banner banner-warning" style={{ marginTop: 12 }}>
                <div>
                  <strong>phpMyAdmin is not installed</strong>
                  <p>Install it with the distribution package{data.packageHint ? <> (<code>{data.packageHint}</code>)</> : ''} via <Link to="/software/install-distro-packages">Install Distro Packages</Link>, or unpack a release into one of the detected locations and add an alias in the web server. Checked: {data.candidates?.join(', ')}.</p>
                </div>
              </div>
            )}
            {data.installed && !data.urlPath && !data.urlOverride && (
              <div className="banner banner-info" style={{ marginTop: 12 }}><div>phpMyAdmin files exist but no Apache/nginx alias serves them. Enable the shipped web config (<code>a2enconf phpmyadmin</code> on Debian) or set the URL below.</div></div>
            )}
          </Card>
          {data.webConfigs?.length > 0 && (
            <Card title="Web server configuration">
              <div className="table-wrap"><table><thead><tr><th>File</th><th>Server</th><th>Alias</th><th>Enabled</th></tr></thead><tbody>
                {data.webConfigs.map((w) => <tr key={w.path}><td><code>{w.path}</code></td><td>{w.server}</td><td>{w.urlPath ? <code>{w.urlPath}</code> : '—'}</td><td><StatusPill status={w.enabled ? 'enabled' : 'disabled'}>{w.enabled ? 'yes' : 'no'}</StatusPill></td></tr>)}
              </tbody></table></div>
            </Card>
          )}
          {isRoot && (
            <Card title="URL override" subtitle="Point the panel at a phpMyAdmin hosted elsewhere (a dedicated vhost or another server). Blank uses the detected alias on this server's hostname.">
              <Field label="phpMyAdmin URL" help="https://pma.example.com/ or a path such as /phpmyadmin"><TextInput value={url} onChange={setUrl} placeholder={data.urlPath ? `https://${data.hostname}${data.urlPath}` : 'https://pma.example.com/'} /></Field>
              <FormActions><Button variant="primary" loading={busy} onClick={save}>Save</Button></FormActions>
            </Card>
          )}
        </>
      )}
    </>
  );
}
