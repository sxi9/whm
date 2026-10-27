import { PageHeader, Card, formatDate } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { money } from '../../widgets/index.jsx';
import { StatementView } from '../admin/Resellers.jsx';

export default function ResellerStatement() {
  const { data, loading, error, refetch } = useApi('/reseller/invoices');
  return (
    <>
      <PageHeader title="Statement" description="Wholesale charges per month for every license you issued." home="/reseller" />
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && (
        <>
          <Card title="Summary"><StatementView statement={data} /></Card>
          <Card title="Lines" padded={false}>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Issued</th><th>License</th><th>Edition</th><th>Term</th><th>Wholesale</th></tr></thead>
                <tbody>{(data.lines || []).map((l) => <tr key={l.id}><td>{formatDate(l.issued_at)}</td><td><code>{l.key_prefix}-…</code></td><td>{l.edition}</td><td>{l.term}</td><td>{money(l.wholesale_cents, data.currency)}</td></tr>)}{!(data.lines || []).length && <tr><td colSpan={5} className="muted">No licenses issued yet.</td></tr>}</tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
