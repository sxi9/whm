import { ExternalLink, MailOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, KeyValue, EmptyState, StatusPill } from '../../../components/Common.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError } from './parts/Shared.jsx';

// Roundcube accepts a prefilled login as ?_user=; other webmail apps just open.
export function webmailLink(info, address) {
  if (!info?.url) return null;
  if (!address || info.flavor !== 'roundcube') return info.url;
  return `${info.url}${info.url.includes('?') ? '&' : '?'}_user=${encodeURIComponent(address)}`;
}

export function WebmailCard({ info, onRetry }) {
  if (!info) return null;
  if (!info.url) {
    return (
      <Card>
        <EmptyState icon={MailOpen} title="Webmail is not set up on this server">
          <p>No webmail application is installed yet, so mail can only be read with a mail app. Ask your hosting provider to enable webmail.</p>
          <p className="muted">Use the connection settings under <Link to="/panel/email/accounts">Email accounts</Link> to set up your mail app.</p>
          {onRetry && <p><button className="btn btn-sm" onClick={onRetry}>Re-check</button></p>}
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card title="Open webmail" subtitle="Read and send mail from any browser; sign in with a mailbox address and its password." actions={<a className="btn btn-primary" href={webmailLink(info, info.prefillUser)} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Open webmail</a>}>
      <KeyValue items={[
        ['Address', <a key="u" href={info.url} target="_blank" rel="noopener noreferrer">{info.url}</a>],
        ['Application', info.flavor ? <span key="f">{info.flavor}{info.version ? ` ${info.version}` : ''}</span> : (info.configuredUrl ? 'Configured by your provider' : null)],
        ['Mail server', <code key="h">{info.hostname}</code>],
        info.prefillUser && ['Signs in as', <code key="p">{info.prefillUser}</code>],
      ]} />
    </Card>
  );
}

export function MailboxLinks({ info, mailboxes }) {
  if (!info?.url || !mailboxes?.length) return null;
  return (
    <Card title="Your mailboxes" subtitle="Open webmail for a specific mailbox." padded={false}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Mailbox</th><th>Status</th><th className="actions-col" /></tr></thead>
          <tbody>
            {mailboxes.map((m) => (
              <tr key={m.id}>
                <td><code>{m.address}</code></td>
                <td><StatusPill status={m.suspended ? 'suspended' : 'active'} /></td>
                <td className="actions-col"><a className="btn btn-sm" href={webmailLink(info, m.address)} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function Webmail({ fn }) {
  const { data, error, loading, refetch } = usePanelApi('/email/webmail');
  const accounts = usePanelApi('/email/accounts?usage=false&pageSize=200');
  return (
    <PanelPage fn={fn}>
      <PanelRequestError error={error} fn={fn} onRetry={refetch} />
      {loading && !data && !error && <Card><p className="muted">Loading…</p></Card>}
      <WebmailCard info={data} onRetry={refetch} />
      <MailboxLinks info={data} mailboxes={accounts.data} />
      {data?.url && !accounts.data?.length && !accounts.loading && <p className="muted">No mailboxes yet. Create one under <Link to="/panel/email/accounts">Email accounts</Link> to sign in to webmail.</p>}
    </PanelPage>
  );
}
