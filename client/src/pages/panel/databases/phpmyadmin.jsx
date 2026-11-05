import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, RefreshCw, Database } from 'lucide-react';
import { Card, KeyValue, StatusPill, Loading, EmptyState } from '../../../components/Common.jsx';
import { Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';

// Single sign-on (GET /databases/phpmyadmin reports sso:true): POST a one-time
// token for the account's hidden phpMyAdmin user, then open the URL it
// answers. The window is opened before the request so the browser treats it
// as the click's own popup; it is closed again when no URL comes back.
export async function openPhpMyAdminSso({ open = (url, w) => { if (w) w.location = url; else window.location.assign(url); }, win = () => window.open('about:blank', '_blank', 'noopener') } = {}) {
  const w = win();
  try {
    const res = await panelApi.post('/databases/phpmyadmin/sso', {});
    open(res.data.url, w);
    return res.data;
  } catch (err) {
    try { w?.close(); } catch { /* already gone */ }
    throw err;
  }
}

export function PhpMyAdminOpenButton({ info, className = 'btn btn-sm', label, size = 14 }) {
  const toast = useToast();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const text = label ?? t('panel.databases.pma_open', 'Open phpMyAdmin');
  if (!info?.url) return null;
  if (!info.sso) {
    return <a className={className} href={info.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={size} /> {text}</a>;
  }
  const click = async () => {
    setBusy(true);
    try { await openPhpMyAdminSso(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return <button type="button" className={className} disabled={busy} onClick={click} data-sso="1"><ExternalLink size={size} /> {text}</button>;
}

// Without single sign-on phpMyAdmin's cookie authentication reads the user
// name from its own POSTed form only, so nothing in the link can prefill it;
// the page lists the names to type instead. The password is never put in a link.
export default function PhpMyAdmin({ fn }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, loading, error, refetch } = usePanelApi('/databases/phpmyadmin');
  const capability = isCapabilityError(error);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const ready = Boolean(data?.installed && data?.featureEnabled && data?.url);
  const sso = Boolean(ready && data.sso);
  const users = data?.users || [];
  const open = ready && <PhpMyAdminOpenButton info={data} className="btn btn-primary" size={16} />;
  const statusLabel = !data ? '' : data.engine === 'postgres' ? t('panel.databases.pma_status_pg', 'not for PostgreSQL') : !data.installed ? t('panel.databases.pma_status_missing', 'not installed') : !data.featureEnabled ? t('panel.databases.pma_status_off', 'turned off by the provider') : data.url ? t('panel.databases.pma_status_available', 'available') : t('panel.databases.pma_status_no_url', 'no address yet');

  return (
    <PanelPage fn={fn} actions={<>{open}<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button></>}>
      {capability && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}
      {!capability && <RequestError error={error} onRetry={refetch} />}
      {loading && !data && <Card><Loading text={t('panel.databases.pma_checking', 'Checking phpMyAdmin…')} /></Card>}
      {data && (
        <div className="grid-2">
          <Card title={t('panel.databases.pma_how_title', 'How it works')} subtitle={t('panel.databases.pma_how_subtitle', 'A web interface for your databases: browse tables, run SQL, import and export.')}>
            {sso
              ? <p>{t('panel.databases.pma_sso_text', 'phpMyAdmin opens in a new tab already signed in to your account\'s databases; the link is valid for one minute and can be used once. You can still sign in with one of your database users instead (choose “Sign in with a database user” on the phpMyAdmin page).')}</p>
              : <p>{t('panel.databases.pma_login_text', 'phpMyAdmin opens in a new tab and asks for a database user and its password. Type one of the user names listed here and the password you set when you created that user.')}</p>}
            <p className="muted">{t('panel.databases.pma_password_note', 'Your account password does not work there. Database users and their passwords are managed under')} <Link to="/panel/databases/users">{t('panel.databases/users.label', 'Database users')}</Link>.</p>
            <KeyValue items={[
              [t('panel.databases.pma_status', 'Status'), <StatusPill key="s" status={data.engine === 'postgres' ? 'disabled' : !data.installed ? 'not-installed' : !data.featureEnabled ? 'disabled' : data.url ? 'installed' : 'warning'}>{statusLabel}</StatusPill>],
              data.version && [t('panel.databases.pma_version', 'Version'), data.version],
              ready && [t('panel.databases.pma_address', 'Address'), <a key="u" href={data.url} target="_blank" rel="noopener noreferrer">{data.url}</a>],
              ready && [t('panel.databases.pma_signin', 'Sign-in'), sso ? t('panel.databases.pma_signin_sso', 'Single sign-on from this page') : (users.length ? plural(t, 'panel.databases.pma_signin_users', users.length, 'one of {count} database user', 'one of {count} database users') : t('panel.databases.pma_signin_none', 'no database user yet'))],
            ]} />
            {!data.installed && data.engine !== 'postgres' && <InfoNote>{t('panel.databases.pma_not_installed', 'phpMyAdmin is not installed on this server. Ask your hosting provider to enable it; your databases and users keep working without it.')}</InfoNote>}
            {data.installed && !data.featureEnabled && <InfoNote>{t('panel.databases.pma_turned_off', 'Your hosting provider has turned phpMyAdmin off for this server.')}</InfoNote>}
            {data.installed && data.featureEnabled && !data.url && <InfoNote>{t('panel.databases.pma_no_url', 'phpMyAdmin is installed but has no web address yet. Ask your hosting provider to publish it.')}</InfoNote>}
            {data.engine === 'postgres' && <InfoNote>{t('panel.databases.pma_postgres', 'This account uses PostgreSQL, which phpMyAdmin does not manage.')}</InfoNote>}
          </Card>
          <Card title={sso ? t('panel.databases/users.label', 'Database users') : t('panel.databases.pma_sign_in_as', 'Sign in as')} subtitle={sso ? t('panel.databases.pma_users_subtitle_sso', 'Your database users; phpMyAdmin also accepts any of these with its password.') : t('panel.databases.pma_users_subtitle', 'Your database users; phpMyAdmin asks for one of these names and its password.')} padded={false}>
            {users.length === 0 ? (
              <EmptyState icon={Database} title={t('panel.databases.pma_no_users', 'No database users yet')}><p>{t('panel.databases.pma_no_users_before', 'Create a user under')} <Link to="/panel/databases/users">{t('panel.databases/users.label', 'Database users')}</Link>{t('panel.databases.pma_no_users_after', '; it is listed here.')}</p></EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('panel.databases.col_db_user', 'Database user')}</th><th className="align-right">{t('panel.databases.col_open', 'Open')}</th></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u}>
                        <td><code>{u}</code></td>
                        <td className="align-right">
                          {ready ? <PhpMyAdminOpenButton info={data} label="phpMyAdmin" /> : <span className="muted">{t('panel.databases.pma_not_available', 'not available')}</span>}
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
      {data && me?.account?.username && <p className="muted small">{t('panel.databases.pma_named_before', 'Databases of this account are named')} <code>{me.account.username}_…</code>{t('panel.databases.pma_named_after', '; only those appear in phpMyAdmin.')}</p>}
    </PanelPage>
  );
}
