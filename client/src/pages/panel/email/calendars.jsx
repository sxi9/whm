import { useState } from 'react';
import { CalendarDays, KeyRound, Trash2, BookUser } from 'lucide-react';
import { Card, KeyValue, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, PasswordInput, Button, FormActions, Select } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, useEmailT } from './parts/Shared.jsx';

// What the page says about GET /email/calendars → available.
export function davState(info, t = (k, f) => f) {
  if (!info) return null;
  const a = info.available || {};
  if (!a.installed) return { status: 'not-installed', label: t('panel.email.calendars.state_not_installed', 'Not available'), detail: t('panel.email.calendars.not_installed', 'The calendar server is not installed on this server yet. Ask your hosting provider to enable Calendars and Contacts.') };
  if (!a.published || !info.serverUrl) return { status: 'pending', label: t('panel.email.calendars.state_not_published', 'Not published'), detail: t('panel.email.calendars.not_published', 'The calendar server is installed but has no public address yet. Ask your hosting provider to publish it.') };
  if (a.active === false) return { status: 'failed', label: t('panel.email.calendars.state_stopped', 'Stopped'), detail: t('panel.email.calendars.stopped', 'The calendar server is not running right now; your clients cannot sync until your hosting provider starts it.') };
  return { status: 'active', label: t('panel.email.calendars.state_ready', 'Ready'), detail: null };
}

export function SetPasswordForm({ logins, onDone }) {
  const { t } = useEmailT();
  const toast = useToast();
  const [login, setLogin] = useState(logins[0]?.login || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!login) return;
    setBusy(true);
    setError(null);
    try {
      await panelApi.put(`/email/calendars/${encodeURIComponent(login)}/password`, { password });
      toast.success(t('panel.email.calendars.password_saved', 'DAV password saved for {login}', { login }));
      setPassword('');
      onDone?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="config-fields">
      <MutationError error={error} />
      <div className="form-grid">
        <Field label={t('panel.email.calendars.login', 'DAV login')} htmlFor="dav-login">
          <Select id="dav-login" value={login} onChange={setLogin} options={logins.map((l) => ({ value: l.login, label: `${l.login}${l.hasPassword ? '' : ` — ${t('panel.email.calendars.no_password_short', 'no password yet')}`}` }))} />
        </Field>
        <Field label={t('panel.email.calendars.password', 'DAV password')} help={t('panel.email.calendars.password_help', 'Used only by calendar and contact apps; it is separate from the mailbox and panel passwords.')} error={error?.fields?.password?.[0]} htmlFor="dav-password">
          <PasswordInput id="dav-password" value={password} onChange={setPassword} minStrength={50} required minLength={8} />
        </Field>
      </div>
      <FormActions>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!login || password.length < 8}>{t('panel.email.calendars.set_password', 'Set DAV password')}</Button>
      </FormActions>
    </form>
  );
}

export function LoginsTable({ logins, onRemoved, onShow }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);
  const remove = async (l) => {
    if (!(await confirm({ title: t('panel.email.calendars.remove_title', 'Remove the DAV password?'), message: t('panel.email.calendars.remove_message', '{login} can no longer sign in to the calendar server. Calendars and contacts stay on the server and come back with a new password.', { login: l.login }), confirmLabel: t('panel.email.calendars.remove', 'Remove'), danger: true }))) return;
    setBusy(l.login);
    try {
      await panelApi.delete(`/email/calendars/${encodeURIComponent(l.login)}/password`);
      toast.success(t('panel.email.calendars.password_removed', 'DAV password removed for {login}', { login: l.login }));
      onRemoved?.();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{t('panel.email.calendars.login', 'DAV login')}</th><th>{t('panel.email.calendars.kind', 'Who')}</th><th>{t('panel.email.common.status', 'Status')}</th><th>{t('panel.email.calendars.set_on', 'Password set')}</th><th className="actions-col" /></tr></thead>
        <tbody>
          {logins.map((l) => (
            <tr key={l.login}>
              <td><code>{l.login}</code></td>
              <td>{l.kind === 'account' ? t('panel.email.calendars.kind_account', 'This account') : t('panel.email.calendars.kind_subuser', 'Sub-user')}</td>
              <td><StatusPill status={l.hasPassword ? 'active' : 'pending'}>{l.hasPassword ? t('panel.email.calendars.has_password', 'Password set') : t('panel.email.calendars.no_password', 'No password')}</StatusPill></td>
              <td>{l.passwordSetAt ? formatDate(l.passwordSetAt) : <span className="muted">—</span>}</td>
              <td className="actions-col">
                <div className="action-row">
                  <button type="button" className="btn btn-sm" onClick={() => onShow?.(l)} disabled={!l.hasPassword}><BookUser size={14} /> {t('panel.email.calendars.collections', 'Collections')}</button>
                  {l.hasPassword && <button type="button" className="btn btn-sm btn-danger" disabled={busy === l.login} onClick={() => remove(l)}><Trash2 size={14} /> {t('panel.email.calendars.remove', 'Remove')}</button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CollectionsCard({ login, onClose }) {
  const { t } = useEmailT();
  const { data, error, loading, refetch } = usePanelApi(login ? `/email/calendars/${encodeURIComponent(login)}/collections` : null);
  if (!login) return null;
  const kindLabel = (k) => (k === 'calendar' ? t('panel.email.calendars.kind_calendar', 'Calendar') : k === 'addressbook' ? t('panel.email.calendars.kind_addressbook', 'Address book') : t('panel.email.calendars.kind_other', 'Other'));
  return (
    <Card title={t('panel.email.calendars.collections_of', 'Collections of {login}', { login })} subtitle={t('panel.email.calendars.collections_subtitle', 'Calendars and address books your apps created on the server. Create new ones from your app or the web page of the calendar server.')}
      actions={<button type="button" className="btn btn-sm" onClick={onClose}>{t('panel.email.common.close', 'Close')}</button>}>
      <PanelRequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">{t('panel.email.common.loading', 'Loading…')}</p>}
      {data && !data.collections?.length && <div><EmptyState icon={CalendarDays} title={t('panel.email.calendars.no_collections', 'No collections yet')}><p>{data.exists ? t('panel.email.calendars.no_collections_text', 'This login has signed in but created nothing yet.') : t('panel.email.calendars.never_signed_in', 'This login has not connected to the calendar server yet; the first app that connects creates its calendars and address books.')}</p></EmptyState></div>}
      {data?.collections?.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('panel.email.calendars.name', 'Name')}</th><th>{t('panel.email.calendars.type', 'Type')}</th><th>{t('panel.email.calendars.items', 'Items')}</th><th>{t('panel.email.calendars.updated', 'Last change')}</th></tr></thead>
            <tbody>
              {data.collections.map((c) => (
                <tr key={c.name}>
                  <td>{c.displayName || <code>{c.name}</code>}{c.displayName && <div className="muted"><code>{c.name}</code></div>}</td>
                  <td>{kindLabel(c.kind)}</td>
                  <td>{c.items}</td>
                  <td>{c.updatedAt ? formatDate(c.updatedAt) : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ClientSetup({ serverUrl, login, hostname }) {
  const { t } = useEmailT();
  const who = login || 'name@example.com';
  const principal = serverUrl ? `${serverUrl}${encodeURIComponent(who)}/` : null;
  return (
    <Card title={t('panel.email.calendars.setup_title', 'Set up your apps')} subtitle={t('panel.email.calendars.setup_subtitle', 'Every app needs the server address, your DAV login and the DAV password set above.')}>
      <KeyValue items={[
        [t('panel.email.calendars.server_url', 'Server address'), serverUrl ? <code key="u">{serverUrl}</code> : <span key="n" className="muted">{t('panel.email.calendars.no_url', 'Not published yet')}</span>],
        [t('panel.email.calendars.principal_url', 'Your calendars and contacts'), principal ? <code key="p">{principal}</code> : null],
        [t('panel.email.calendars.login', 'DAV login'), <code key="l">{who}</code>],
        [t('panel.email.calendars.server_name', 'Server name'), hostname ? <code key="h">{hostname}</code> : null],
      ]} />
      <div>
        <h4>{t('panel.email.calendars.client_thunderbird', 'Thunderbird')}</h4>
        <p>{t('panel.email.calendars.client_thunderbird_text', 'Calendar › New calendar › On the network › CalDAV: enter your DAV login and the server address, then pick the calendars found. Address book › New address book › CardDAV address book: the same address and login.')}</p>
        <h4>{t('panel.email.calendars.client_ios', 'iPhone and iPad')}</h4>
        <p>{t('panel.email.calendars.client_ios_text', 'Settings › Calendar › Accounts › Add account › Other › Add CalDAV account (and Add CardDAV account for contacts): server = the server name, user name = your DAV login, password = your DAV password. If the account is not found, use the full server address under Advanced settings.')}</p>
        <h4>{t('panel.email.calendars.client_android', 'Android (DAVx⁵)')}</h4>
        <p>{t('panel.email.calendars.client_android_text', 'Install DAVx⁵, add an account with “Login with URL and user name”, paste the server address and your DAV login and password, then choose the calendars and address books to sync.')}</p>
        <h4>{t('panel.email.calendars.client_mac', 'macOS and other apps')}</h4>
        <p>{t('panel.email.calendars.client_mac_text', 'Calendar › Add account › Other CalDAV account › Advanced: server address = the server name, server path = your calendars address, port 443 with SSL. Any CalDAV/CardDAV client works the same way; the web page at the server address lets you create calendars and address books in the browser.')}</p>
      </div>
    </Card>
  );
}

export default function Calendars({ fn }) {
  const { t } = useEmailT();
  const { data, error, loading, refetch } = usePanelApi('/email/calendars');
  const [showing, setShowing] = useState(null);
  const state = davState(data, t);
  const logins = data?.logins || [];
  const first = logins.find((l) => l.hasPassword) || logins[0] || null;
  return (
    <PanelPage fn={fn}>
      <PanelRequestError error={error} fn={fn} onRetry={refetch} />
      {loading && !data && !error && <Card><p className="muted">{t('panel.email.common.loading', 'Loading…')}</p></Card>}
      {data && state && (
        <Card title={t('panel.email.calendars.title', 'Calendar server')} subtitle={t('panel.email.calendars.subtitle', 'Your calendars and address books live on this server and sync to every device over CalDAV and CardDAV.')}
          actions={data.serverUrl && state.status === 'active' ? <a className="btn btn-primary" href={data.serverUrl} target="_blank" rel="noopener noreferrer"><CalendarDays size={16} /> {t('panel.email.calendars.open_web', 'Open web page')}</a> : null}>
          <KeyValue items={[
            [t('panel.email.common.status', 'Status'), <StatusPill key="s" status={state.status}>{state.label}</StatusPill>],
            [t('panel.email.calendars.server_url', 'Server address'), data.serverUrl ? <a key="u" href={data.serverUrl} target="_blank" rel="noopener noreferrer">{data.serverUrl}</a> : null],
            [t('panel.email.calendars.logins', 'DAV logins'), logins.length ? logins.map((l) => l.login).join(', ') : null],
          ]} />
          {state.detail && <p className="muted">{state.detail}</p>}
        </Card>
      )}
      {data && state?.status !== 'not-installed' && logins.length > 0 && (
        <Card title={t('panel.email.calendars.password_title', 'Set a DAV password')} subtitle={t('panel.email.calendars.password_subtitle', 'A login can sync as soon as it has a DAV password. Setting one again replaces the old one.')}>
          <SetPasswordForm logins={logins} onDone={refetch} />
        </Card>
      )}
      {data && logins.length > 0 && (
        <Card title={t('panel.email.calendars.logins', 'DAV logins')} subtitle={t('panel.email.calendars.logins_subtitle', 'Your account login and every sub-user with Calendars and Contacts enabled in the User Manager.')} padded={false}>
          <LoginsTable logins={logins} onRemoved={() => { setShowing(null); refetch(); }} onShow={(l) => setShowing(l.login)} />
        </Card>
      )}
      {data && logins.length === 0 && <Card><EmptyState icon={CalendarDays} title={t('panel.email.calendars.no_logins', 'No DAV login available')}><p>{t('panel.email.calendars.no_logins_text', 'This account has no fully qualified main domain, so no DAV login can be formed.')}</p></EmptyState></Card>}
      <CollectionsCard login={showing} onClose={() => setShowing(null)} />
      {data && <ClientSetup serverUrl={data.serverUrl} login={first?.login || null} hostname={data.hostname} />}
    </PanelPage>
  );
}
