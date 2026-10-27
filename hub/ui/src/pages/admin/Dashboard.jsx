import { Link } from 'react-router-dom';
import { PageHeader, Card, Loading } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { Stat, StatGrid, MiniBars, money } from '../../widgets/index.jsx';

// Vendor dashboard: license health from /admin/reports/dashboard and the
// marketplace queues from /admin/market/stats (§16.9 + §18.7).
// hub/license/services/reports.js shapes: activations_by_edition
// [{ edition, active }], checkins_last_24h [{ hour, n, failed }].
export function activationTotals(byEdition) {
  const rows = Array.isArray(byEdition) ? byEdition : [];
  return { total: rows.reduce((a, r) => a + (Number(r.active) || 0), 0), hint: rows.map((r) => `${r.edition}: ${Number(r.active) || 0}`).join(' · ') || 'none yet' };
}

export default function Dashboard() {
  const lic = useApi('/admin/reports/dashboard');
  const mkt = useApi('/admin/market/stats');
  const d = lic.data || {};
  const m = mkt.data || {};
  const activations = activationTotals(d.activations_by_edition);
  const reviewQueue = Object.values(m.review_queue || {}).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHeader title="Dashboard" description="Licensing and marketplace health at a glance." home="/admin" />
      <ErrorBanner error={lic.error} onRetry={lic.refetch} />
      <ErrorBanner error={mkt.error} onRetry={mkt.refetch} />
      {lic.loading && !lic.data && <Loading />}
      <StatGrid>
        <Stat label="Active activations" value={activations.total} hint={activations.hint} />
        <Stat label="Expiring in 30 days" value={d.expiring_30d} hint={<Link to="/admin/licenses?expiring_within=30">open list</Link>} />
        <Stat label="Failed check-ins (24 h)" value={d.failed_checkins_24h} tone={d.failed_checkins_24h ? 'warn' : undefined} />
        <Stat label="Webhook failures" value={d.webhook_failures} hint={<Link to="/admin/integrations">integrations</Link>} />
        <Stat label="Trials" value={d.trial_funnel ? `${d.trial_funnel.started ?? 0} / ${d.trial_funnel.converted ?? 0}` : '—'} hint="started / converted" />
      </StatGrid>
      <StatGrid>
        <Stat label="Verification queue" value={m.verification_queue} hint={<Link to="/admin/market/verifications">review developers</Link>} />
        <Stat label="Review queue" value={reviewQueue} hint={`high risk: ${m.review_queue?.high || 0} · ${m.review_queue_age_s ? `oldest ${Math.round(m.review_queue_age_s / 3600)} h` : 'empty'}`} />
        <Stat label="Revocations pending" value={m.revocations_pending} tone={m.revocations_pending ? 'warn' : undefined} hint={<Link to="/admin/market/revocations">revocations</Link>} />
        <Stat label="Revenue (30 d)" value={(m.revenue_30d || []).map((r) => money(r.amount_cents, r.currency)).join(' · ') || money(0)} hint={`${(m.revenue_30d || []).reduce((a, r) => a + (r.purchases || 0), 0)} purchases`} />
        <Stat label="Re-sign backlog" value={m.resign?.backlog ?? 0} hint={m.resign?.active_kid ? `plugin key ${m.resign.active_kid}` : 'no active plugin key'} tone={m.resign?.backlog ? 'warn' : undefined} />
      </StatGrid>
      <div className="two-col">
        <Card title="Check-ins per hour (24 h)"><MiniBars points={d.checkins_last_24h} labelKey="hour" /></Card>
        <Card title="Downloads per day (7 d)"><MiniBars points={m.downloads_per_day} /></Card>
      </div>
      <div className="two-col">
        <Card title="Developers by status">
          <dl className="kv">{Object.entries(m.developers || {}).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{!Object.keys(m.developers || {}).length && <p className="muted">No developers registered yet.</p>}</dl>
        </Card>
        <Card title="Plugins by status">
          <dl className="kv">{Object.entries(m.plugins || {}).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}{!Object.keys(m.plugins || {}).length && <p className="muted">No plugins submitted yet.</p>}</dl>
        </Card>
      </div>
    </>
  );
}
