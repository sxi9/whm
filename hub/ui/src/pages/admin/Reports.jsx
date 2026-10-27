import { useState } from 'react';
import { PageHeader, Card, formatDate } from '../../components/Common.jsx';
import { ErrorBanner } from '../../components/Form.jsx';
import { useApi } from '../../hooks/useApi.js';
import { MiniBars, Tabs, limitLabel } from '../../widgets/index.jsx';

const REPORTS = [
  { value: 'activations', label: 'Activations' },
  { value: 'renewals', label: 'Renewals' },
  { value: 'churn', label: 'Churn' },
  { value: 'resellers', label: 'Resellers' },
  { value: 'versions', label: 'Panel versions' },
];

function Table({ rows, columns }) {
  if (!rows?.length) return <p className="muted">Nothing to report.</p>;
  const cols = columns || Object.keys(rows[0]);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : /_at$/.test(c) ? formatDate(r[c]) : String(r[c] ?? '—')}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export default function Reports() {
  const [report, setReport] = useState('activations');
  const { data, loading, error, refetch } = useApi(`/admin/reports/${report}`);
  return (
    <>
      <PageHeader title="Reports" description="Activations per edition over time, renewals due, churn, reseller quota usage and panel-version distribution." home="/admin"
        actions={<>{['licenses', 'activations', 'customers'].map((t) => <a key={t} className="btn btn-sm" href={`/v1/admin/export.csv?table=${t}`}>Export {t}.csv</a>)}</>} />
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs tabs={REPORTS} value={report} onChange={setReport} /></div>
        <div className="card-body">
          <ErrorBanner error={error} onRetry={refetch} />
          {loading && !data && <p className="muted">Loading…</p>}
          {data && report === 'activations' && (
            <>
              <h3>Active activations by edition</h3><Table rows={data.by_edition} />
              <h3 style={{ marginTop: 16 }}>Activations over time (90 d)</h3><MiniBars points={data.over_time} valueKey="created" labelKey="day" />
              <h3 style={{ marginTop: 16 }}>Panel versions</h3><Table rows={data.panel_versions} />
            </>
          )}
          {data && report === 'renewals' && (
            <>
              <h3>Due</h3><Table rows={data.due} />
              <h3 style={{ marginTop: 16 }}>Completed</h3><Table rows={data.completed} />
              <h3 style={{ marginTop: 16 }}>Lapsed</h3><Table rows={data.lapsed} />
            </>
          )}
          {data && report === 'churn' && <Table rows={data.rows} />}
          {data && report === 'resellers' && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Reseller</th><th>Quota</th><th>Issued</th><th>Left</th></tr></thead>
                <tbody>{data.map((r) => <tr key={r.id}><td>{r.name}</td><td>{Object.entries(r.quota || {}).map(([e, n]) => `${e}: ${limitLabel(n)}`).join(' · ')}</td><td>{Object.entries(r.issued || {}).map(([e, n]) => `${e}: ${n}`).join(' · ') || '—'}</td><td>{Object.entries(r.quota_left || {}).map(([e, n]) => `${e}: ${limitLabel(n)}`).join(' · ')}</td></tr>)}{!data.length && <tr><td colSpan={4} className="muted">No resellers.</td></tr>}</tbody>
              </table>
            </div>
          )}
          {data && report === 'versions' && <Table rows={data} />}
        </div>
      </Card>
    </>
  );
}
