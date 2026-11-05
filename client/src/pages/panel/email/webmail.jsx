import { useState } from 'react';
import { ExternalLink, MailOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, KeyValue, EmptyState, StatusPill } from '../../../components/Common.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, useEmailT } from './parts/Shared.jsx';

// Roundcube accepts a prefilled login as ?_user=; other webmail apps just open.
export function webmailLink(info, address) {
  if (!info?.url) return null;
  if (!address || info.flavor !== 'roundcube') return info.url;
  return `${info.url}${info.url.includes('?') ? '&' : '?'}_user=${encodeURIComponent(address)}`;
}

// Single sign-on (GET /email/webmail reports sso:true): POST a one-time token
// for the mailbox, then open the URL it answers. The window is opened before
// the request so the browser treats it as the click's own popup; it is closed
// again when no URL comes back.
export async function openWebmailSso(address, { open = (url, w) => { if (w) w.location = url; else window.location.assign(url); }, win = () => window.open('about:blank', '_blank', 'noopener') } = {}) {
  const w = win();
  try {
    const res = await panelApi.post('/email/webmail/sso', { mailbox: address });
    open(res.data.url, w);
    return res.data;
  } catch (err) {
    try { w?.close(); } catch { /* already gone */ }
    throw err;
  }
}

export function WebmailOpenButton({ info, address, className = 'btn btn-sm', label, size = 14 }) {
  const { t } = useEmailT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!info?.url) return null;
  const text = label || t('panel.email.webmail.open_short', 'Open');
  if (!info.sso || !address) {
    return <a className={className} href={webmailLink(info, address)} target="_blank" rel="noopener noreferrer"><ExternalLink size={size} /> {text}</a>;
  }
  const click = async () => {
    setBusy(true);
    try { await openWebmailSso(address); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return <button type="button" className={className} disabled={busy} onClick={click} data-sso="1"><ExternalLink size={size} /> {text}</button>;
}

export function WebmailCard({ info, onRetry }) {
  const { t } = useEmailT();
  if (!info) return null;
  if (!info.url) {
    return (
      <Card>
        <EmptyState icon={MailOpen} title={t('panel.email.webmail.not_set_up', 'Webmail is not set up on this server')}>
          <p>{info.installed ? t('panel.email.webmail.installed_not_published', '{app} is installed but not published yet, so mail can only be read with a mail app. Ask your hosting provider to publish webmail.', { app: info.flavor || t('panel.email.webmail.a_webmail_application', 'A webmail application') }) : t('panel.email.webmail.not_installed', 'No webmail application is installed yet, so mail can only be read with a mail app. Ask your hosting provider to enable webmail.')}</p>
          <p className="muted">{t('panel.email.webmail.use_connection_settings', 'Use the connection settings under')} <Link to="/panel/email/accounts">{t('panel.email/accounts.label', 'Email accounts')}</Link> {t('panel.email.webmail.to_set_up_app', 'to set up your mail app.')}</p>
          {onRetry && <p><button className="btn btn-sm" onClick={onRetry}>{t('panel.email.common.recheck', 'Re-check')}</button></p>}
        </EmptyState>
      </Card>
    );
  }
  const subtitle = info.sso && info.prefillUser ? t('panel.email.webmail.subtitle_sso', 'Read and send mail from any browser; you are signed in to your mailbox without entering its password.') : t('panel.email.webmail.subtitle', 'Read and send mail from any browser; sign in with a mailbox address and its password.');
  return (
    <Card title={t('panel.email.webmail.open', 'Open webmail')} subtitle={subtitle} actions={<WebmailOpenButton info={info} address={info.prefillUser} className="btn btn-primary" label={t('panel.email.webmail.open', 'Open webmail')} size={16} />}>
      <KeyValue items={[
        [t('panel.email.common.address', 'Address'), <a key="u" href={info.url} target="_blank" rel="noopener noreferrer">{info.url}</a>],
        [t('panel.email.webmail.application', 'Application'), info.flavor ? <span key="f">{info.flavor}{info.version ? ` ${info.version}` : ''}</span> : (info.configuredUrl ? t('panel.email.webmail.configured_by_provider', 'Configured by your provider') : null)],
        [t('panel.email.common.mail_server', 'Mail server'), <code key="h">{info.hostname}</code>],
        info.prefillUser && [info.sso ? t('panel.email.webmail.opens_as', 'Opens as') : t('panel.email.webmail.signs_in_as', 'Signs in as'), <code key="p">{info.prefillUser}</code>],
        info.sso && [t('panel.email.webmail.sign_in', 'Sign-in'), t('panel.email.webmail.sso_note', 'Single sign-on: the link is valid for one minute and opens your mailbox directly')],
      ]} />
    </Card>
  );
}

export function MailboxLinks({ info, mailboxes }) {
  const { t } = useEmailT();
  if (!info?.url || !mailboxes?.length) return null;
  return (
    <Card title={t('panel.email.webmail.your_mailboxes', 'Your mailboxes')} subtitle={t('panel.email.webmail.your_mailboxes_subtitle', 'Open webmail for a specific mailbox.')} padded={false}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t('panel.email.common.mailbox', 'Mailbox')}</th><th>{t('panel.email.common.status', 'Status')}</th><th className="actions-col" /></tr></thead>
          <tbody>
            {mailboxes.map((m) => (
              <tr key={m.id}>
                <td><code>{m.address}</code></td>
                <td><StatusPill status={m.suspended ? 'suspended' : 'active'} /></td>
                <td className="actions-col"><WebmailOpenButton info={m.suspended ? { ...info, sso: false } : info} address={m.address} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Webmail({ fn }) {
  const { t } = useEmailT();
  const { data, error, loading, refetch } = usePanelApi('/email/webmail');
  const accounts = usePanelApi('/email/accounts?usage=false&pageSize=200');
  return (
    <PanelPage fn={fn}>
      <PanelRequestError error={error} fn={fn} onRetry={refetch} />
      {loading && !data && !error && <Card><p className="muted">{t('panel.email.common.loading', 'Loading…')}</p></Card>}
      <WebmailCard info={data} onRetry={refetch} />
      <MailboxLinks info={data} mailboxes={accounts.data} />
      {data?.url && !accounts.data?.length && !accounts.loading && <p className="muted">{t('panel.email.common.no_mailboxes_create_under', 'No mailboxes yet. Create one under')} <Link to="/panel/email/accounts">{t('panel.email/accounts.label', 'Email accounts')}</Link> {t('panel.email.webmail.to_sign_in', 'to sign in to webmail.')}</p>}
    </PanelPage>
  );
}
