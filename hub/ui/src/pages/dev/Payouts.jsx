import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { money } from '../../widgets/index.jsx';

export default function Payouts() {
  const { data, loading, error, refetch } = useApi('/dev/payouts');
  const profile = useApi('/dev/profile');
  const rows = data || [];
  return (
    <>
      <PageHeader title="Payouts & statements" description="Monthly statements: paid minus refunded purchases × your revenue share. Amounts under the minimum, or while you are not verified, are held." home="/dev" />
      {profile.data && !profile.data.has_payout && <div className="banner banner-warning"><div>No payout details on file — add them under <Link to="/dev">Profile</Link> before a period closes.</div></div>}
      <ErrorBanner error={error} onRetry={refetch} />
      <Card padded={false}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Period</th><th>Gross</th><th>Refunds</th><th>Share</th><th>Net</th><th>Status</th><th>Paid</th><th>Reference</th><th /></tr></thead>
            <tbody>
              {loading && !data && <tr><td colSpan={9} className="muted">Loading…</td></tr>}
              {rows.map((p) => <tr key={p.id}><td>{formatDate(p.period_start).slice(0, 10)} → {formatDate(p.period_end).slice(0, 10)}</td><td>{money(p.gross_cents, p.currency)}</td><td>{money(p.refunds_cents, p.currency)}</td><td>{p.share_pct}%</td><td><strong>{money(p.net_cents, p.currency)}</strong></td><td><StatusPill status={p.status} /></td><td>{formatDate(p.paid_at)}</td><td>{p.provider_ref || '—'}</td><td><a className="btn btn-sm" href={`/v1/dev/payouts/${p.id}/statement.csv`}>statement.csv</a></td></tr>)}
              {!loading && !rows.length && <tr><td colSpan={9} className="muted">No statements yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
