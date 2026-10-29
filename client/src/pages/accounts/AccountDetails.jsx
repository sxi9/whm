import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { KeyValue, StatusPill, formatMb, formatDate } from '../../components/Common.jsx';
import { conversationPath } from '../support/ChatWorkspace.jsx';

// Who the account turns to for support, with the way in to its conversation.
export function AccountManager({ account, link = true }) {
  if (!account?.manager) return <span className="muted">No manager assigned</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>{account.manager}</strong>
      {account.manager_role && <span className="muted">({account.manager_role}{account.manager_email ? ` · ${account.manager_email}` : ''})</span>}
      {link && <Link to={conversationPath(account.username)} className="btn btn-sm" title="Open the account's support conversation"><MessageSquare size={14} /> Conversation</Link>}
    </span>
  );
}

// The summary block shared by the account pages: status, ownership, manager and usage.
export function AccountSummary({ account }) {
  if (!account) return null;
  return (
    <KeyValue items={[
      ['Status', <StatusPill key="s" status={account.suspended ? 'suspended' : 'active'}>{account.suspended ? 'Suspended' : 'Active'}</StatusPill>],
      ['Owner', account.owner],
      ['Account manager', <AccountManager key="m" account={account} />],
      ['Home', <code key="h">{account.home_dir}</code>],
      ['Disk used', `${formatMb(account.disk_used_mb)} of ${formatMb(account.disk_quota_mb)}`],
      ['Bandwidth used', `${formatMb(account.bandwidth_used_mb)} of ${formatMb(account.bandwidth_limit_mb)}`],
      ['Created', formatDate(account.created_at)],
    ]} />
  );
}
