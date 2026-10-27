import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Stat, StatGrid, limitLabel, money } from '../../widgets/index.jsx';

// Quota left per edition and licenses expiring within 30 days.
export default function ResellerDashboard() {
  const { session } = useAuth();
  const quota = useApi('/reseller/quota');
  const expiring = useApi('/reseller/licenses?expiring_within=30&pageSize=10');
  const statement = useApi('/reseller/invoices');
  const q = quota.data || {};
  return (
    <>
      <PageHeader title="Dashboard" description={`Signed in as ${session?.user?.email || ''} · ${session?.user?.role || ''}`} home="/reseller" />
      <ErrorBanner error={quota.error} onRetry={quota.refetch} />
      <StatGrid>
        {Object.entries(q.quota_left || {}).map(([edition, left]) => <Stat key={edition} label={`${edition} licenses left`} value={limitLabel(left)} hint={`issued ${q.issued?.[edition] ?? 0} of ${limitLabel(q.quota?.[edition])}`} tone={left === 0 ? 'warn' : undefined} />)}
        <Stat label="Wholesale to date" value={statement.data ? money(statement.data.total_cents, statement.data.currency) : '—'} hint={<Link to="/reseller/statement">statement</Link>} />
      </StatGrid>
      <Card title="Expiring within 30 days" actions={<Link to="/reseller/licenses?expiring_within=30">All</Link>}>
        <ErrorBanner error={expiring.error} onRetry={expiring.refetch} />
        <ul className="timeline">
          {(expiring.data || []).map((l) => <li key={l.id}><time>{formatDate(l.expires_at)}</time><span><Link to={`/reseller/licenses/${l.id}`}><code>{l.key_prefix}-…</code></Link> {l.edition} · {l.customer_email} <StatusPill status={l.status} /></span></li>)}
          {!(expiring.data || []).length && <li><span className="muted">Nothing expiring soon.</span></li>}
        </ul>
      </Card>
      <Card title="Wholesale pricing (cents)">
        <div className="table-wrap"><table><thead><tr><th>Edition</th><th>Monthly</th><th>Annual</th></tr></thead><tbody>{Object.entries(q.pricing || {}).map(([e, p]) => <tr key={e}><td>{e}</td><td>{money(p.monthly)}</td><td>{money(p.annual)}</td></tr>)}{!Object.keys(q.pricing || {}).length && <tr><td colSpan={3} className="muted">No pricing set; contact the vendor.</td></tr>}</tbody></table></div>
      </Card>
    </>
  );
}
