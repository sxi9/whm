import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, Database } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading, EmptyState } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';

// phpMyAdmin pre-fills the login form from `pma_username`; the password is never
// put in a link.
export function loginUrl(base, user) {
  if (!base) return null;
  if (!user) return base;
  return `${base}${base.includes('?') ? '&' : '?'}pma_username=${encodeURIComponent(user)}`;
}

export default function PhpMyAdmin({ fn }) {
  const { me } = usePanelMe();
  const { data, loading, error, refetch } = usePanelApi('/databases/phpmyadmin');
  const capability = isCapabilityError(error);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const ready = Boolean(data?.installed && data?.featureEnabled && data?.url);
  const users = data?.users || [];
  const open = ready && (
    <a className="btn btn-primary" href={loginUrl(data.url, users[0])} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Open phpMyAdmin</a>
  );

  return (
    <PanelPage fn={fn} actions={<>{open}<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button></>}>
      {capability && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}
      {!capability && <RequestError error={error} onRetry={refetch} />}
      {loading && !data && <Card><Loading text="Checking phpMyAdmin…" /></Card>}
      {data && (
        <div className="grid-2">
          <Card title="How it works" subtitle="A web interface for your databases: browse tables, run SQL, import and export.">
            <p>phpMyAdmin opens in a new tab and asks for a database user and its password. The link from this page fills in the user name; type the password you set when you created the user.</p>
            <p className="muted">Your account password does not work there. Database users and their passwords are managed under <Link to="/panel/databases/users">Database users</Link>.</p>
            <KeyValue items={[
              ['Status', <StatusPill key="s" status={data.engine === 'postgres' ? 'disabled' : !data.installed ? 'not-installed' : !data.featureEnabled ? 'disabled' : data.url ? 'installed' : 'warning'}>{data.engine === 'postgres' ? 'not for PostgreSQL' : !data.installed ? 'not installed' : !data.featureEnabled ? 'turned off by the provider' : data.url ? 'available' : 'no address yet'}</StatusPill>],
              data.version && ['Version', data.version],
              ready && ['Address', <a key="u" href={data.url} target="_blank" rel="noopener noreferrer">{data.url}</a>],
              ['Sign in as', users.length ? `one of ${users.length} database user${users.length === 1 ? '' : 's'}` : 'no database user yet'],
            ]} />
            {!data.installed && data.engine !== 'postgres' && <InfoNote>phpMyAdmin is not installed on this server. Ask your hosting provider to enable it; your databases and users keep working without it.</InfoNote>}
            {data.installed && !data.featureEnabled && <InfoNote>Your hosting provider has turned phpMyAdmin off for this server.</InfoNote>}
            {data.installed && data.featureEnabled && !data.url && <InfoNote>phpMyAdmin is installed but has no web address yet. Ask your hosting provider to publish it.</InfoNote>}
            {data.engine === 'postgres' && <InfoNote>This account uses PostgreSQL, which phpMyAdmin does not manage.</InfoNote>}
          </Card>
          <Card title="Sign in as" subtitle="Each link opens phpMyAdmin with the user name filled in." padded={false}>
            {users.length === 0 ? (
              <EmptyState icon={Database} title="No database users yet"><p>Create a user under <Link to="/panel/databases/users">Database users</Link>; it is listed here with a sign-in link.</p></EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Database user</th><th className="align-right">Open</th></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u}>
                        <td><code>{u}</code></td>
                        <td className="align-right">
                          {ready ? <a className="btn btn-sm" href={loginUrl(data.url, u)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> phpMyAdmin</a> : <span className="muted">not available</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      {data && me?.account?.username && <p className="muted small">Databases of this account are named <code>{me.account.username}_…</code>; only those appear in phpMyAdmin.</p>}
    </PanelPage>
  );
}
