import { AlertTriangle } from 'lucide-react';

// Public DNS for a hostname lives elsewhere (delegation.delegatedHere === false
// from /panel/dns/zones, /panel/domains or /panel/email/deliverability): what the
// panel writes into the local zone is not published, so the customer is told
// where the records must go, with the exact records to copy when the page knows them.

export const managedAt = (delegation) => (delegation?.delegatedNs?.length ? delegation.delegatedNs.join(', ') : 'another DNS provider');

export const notDelegatedHere = (delegation) => Boolean(delegation) && delegation.delegatedHere === false;

export function delegationText(domain, delegation) {
  return `DNS for ${domain} is managed at ${managedAt(delegation)}; records you add here are not published — add them there as well`;
}

export function RecordList({ records }) {
  const rows = (records || []).filter((r) => r && r.name && r.value);
  if (!rows.length) return null;
  return (
    <ul>
      {rows.map((r) => <li key={`${r.name}/${r.type}/${r.value}`}><code style={{ wordBreak: 'break-all' }}>{r.name} {r.type} {r.value}</code></li>)}
    </ul>
  );
}

export function DelegationBanner({ domain, delegation, records, title, children }) {
  if (!notDelegatedHere(delegation)) return null;
  return (
    <div className="banner banner-warning" role="status" data-delegation={domain}>
      <AlertTriangle size={18} />
      <div>
        <strong>{title || 'DNS is managed elsewhere'}</strong>
        <p>{delegationText(domain, delegation)}</p>
        {records?.length > 0 && <p className="muted">Records to add there:</p>}
        <RecordList records={records} />
        {children}
      </div>
    </div>
  );
}

// One banner per hostname whose DNS is elsewhere, out of a /panel/domains list.
export function DelegationBanners({ domains, recordsFor, title }) {
  const rows = (domains || []).filter((d) => notDelegatedHere(d.delegation));
  if (!rows.length) return null;
  return <>{rows.map((d) => <DelegationBanner key={d.domain} domain={d.domain} delegation={d.delegation} records={recordsFor ? recordsFor(d) : null} title={title} />)}</>;
}
