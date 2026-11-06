import { AlertTriangle } from 'lucide-react';
import { useT, translate } from '../i18n/useT.js';

// Public DNS for a hostname lives elsewhere (delegation.delegatedHere === false
// from /panel/dns/zones, /panel/domains or /panel/email/deliverability): what the
// panel writes into the local zone is not published, so the customer is told
// where the records must go, with the exact records to copy when the page knows them.

const fill = (text, params) => String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));

export const managedAt = (delegation) => (delegation?.delegatedNs?.length ? delegation.delegatedNs.join(', ') : translate('panel.email.delegation.another_provider', 'another DNS provider'));

export const notDelegatedHere = (delegation) => Boolean(delegation) && delegation.delegatedHere === false;

export function delegationText(domain, delegation) {
  return fill(translate('panel.email.delegation.text', 'DNS for {domain} is managed at {at}; records you add here are not published — add them there as well'), { domain, at: managedAt(delegation) });
}

// SSL status adds nothing to the zone: the banner only asks for the address record
// to point here before a certificate is requested.
export function sslDelegationText(domain, delegation) {
  return fill(translate('panel.ssl.delegation_text', 'DNS for {domain} is managed at {at}; make sure its A/AAAA record points at this server before requesting a certificate'), { domain, at: managedAt(delegation) });
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

// `text` replaces the default "records you add here are not published" sentence on
// pages that add nothing (a string, or a function of (domain, delegation)).
export function DelegationBanner({ domain, delegation, records, title, text, children }) {
  const { t } = useT();
  if (!notDelegatedHere(delegation)) return null;
  const body = typeof text === 'function' ? text(domain, delegation) : (text || delegationText(domain, delegation));
  return (
    <div className="banner banner-warning" role="status" data-delegation={domain}>
      <AlertTriangle size={18} />
      <div>
        <strong>{title || t('panel.email.delegation.title', 'DNS is managed elsewhere')}</strong>
        <p>{body}</p>
        {records?.length > 0 && <p className="muted">{t('panel.email.delegation.records_to_add', 'Records to add there:')}</p>}
        <RecordList records={records} />
        {children}
      </div>
    </div>
  );
}

// One banner per hostname whose DNS is elsewhere, out of a /panel/domains list.
export function DelegationBanners({ domains, recordsFor, title, text }) {
  const rows = (domains || []).filter((d) => notDelegatedHere(d.delegation));
  if (!rows.length) return null;
  return <>{rows.map((d) => <DelegationBanner key={d.domain} domain={d.domain} delegation={d.delegation} records={recordsFor ? recordsFor(d) : null} title={title} text={text} />)}</>;
}
