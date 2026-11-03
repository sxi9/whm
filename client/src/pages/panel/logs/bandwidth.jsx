import { useMemo, useState } from 'react';
import { RefreshCw, Gauge } from 'lucide-react';
import { Card, EmptyState, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button } from '../../../components/Form.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, periodLabel, currentPeriod, RequestError } from './parts/shared.jsx';

const RANGES = [{ value: '3', label: 'Last 3 months' }, { value: '6', label: 'Last 6 months' }, { value: '12', label: 'Last 12 months' }, { value: '24', label: 'Last 24 months' }];

export function limitText(limitMb) {
  return limitMb == null || limitMb <= 0 ? 'Unlimited' : formatMb(limitMb);
}

export function monthRows(months) {
  return [...(months || [])].sort((a, b) => (a.period < b.period ? 1 : -1));
}

export function peakOf(months) {
  return (months || []).reduce((m, r) => Math.max(m, Number(r.bytes) || 0), 0);
}

export default function Bandwidth({ fn }) {
  const { me } = usePanelMe();
  const [months, setMonths] = useState('12');
  const { data, error, loading, refetch } = usePanelApi(`/logs/bandwidth?months=${months}`);
  const capability = isCapabilityError(error);
  const rows = useMemo(() => monthRows(data?.months), [data]);
  const peak = useMemo(() => peakOf(data?.months), [data]);
  const thisPeriod = currentPeriod();
  const current = rows.find((r) => r.period === thisPeriod) || rows[0] || null;
  const limitMb = data ? data.limitMb ?? null : me?.account?.plan?.bandwidth_mb ?? null;
  const unlimited = limitMb == null || limitMb <= 0;
  const limitKnown = Boolean(data) || me?.account?.plan?.bandwidth_mb != null;
  const percent = current && !unlimited ? percentOf(current.usedMb, limitMb) : null;
  const total = rows.reduce((s, r) => s + (Number(r.bytes) || 0), 0);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <PanelCapabilityState error={error} onRetry={refetch} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat">
            <div className="label">{current ? periodLabel(current.period) : 'This month'}</div>
            <div className="value">{current ? formatBytes(current.bytes) : '—'}</div>
            <div className="muted small">{unlimited ? 'No monthly limit in this plan' : `${percent ?? 0}% of ${limitText(limitMb)}`}</div>
            {!unlimited && <div className={`meter ${meterTone(percent)}`}><span style={{ width: `${percent ?? 0}%` }} /></div>}
          </div>
          <div className="stat"><div className="label">Monthly limit</div><div className="value">{limitText(limitMb)}</div><div className="muted small">{unlimited ? 'Traffic is not capped' : 'Set by your hosting plan'}</div></div>
          <div className="stat"><div className="label">Busiest month shown</div><div className="value">{peak ? formatBytes(peak) : '—'}</div><div className="muted small">{peak ? periodLabel(rows.find((r) => Number(r.bytes) === peak)?.period) : 'No traffic recorded yet'}</div></div>
          <div className="stat"><div className="label">Total shown</div><div className="value">{formatBytes(total)}</div><div className="muted small">{rows.length} month{rows.length === 1 ? '' : 's'}</div></div>
        </div>
      )}

      <Card title="Traffic per month" subtitle={data?.domain ? `All domains of ${data.domain}, measured from the web server logs.` : 'Measured from the web server logs.'} padded={false}
        actions={<Field inline htmlFor="bw-months"><Select id="bw-months" value={months} onChange={setMonths} options={RANGES} /></Field>}>
        <DataTable
          columns={[
            { key: 'period', label: 'Month', render: (r) => (r.period === thisPeriod ? <strong>{periodLabel(r.period)}</strong> : periodLabel(r.period)) },
            { key: 'bytes', label: 'Transferred', align: 'right', render: (r) => formatBytes(r.bytes) },
            { key: 'percent', label: limitKnown && unlimited ? 'Relative to the busiest month' : 'Of the monthly limit', render: (r) => {
              const pct = unlimited ? (peak ? Math.round((Number(r.bytes) / peak) * 100) : 0) : (r.percent ?? percentOf(r.usedMb, limitMb) ?? 0);
              return <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className={`meter ${unlimited ? '' : meterTone(pct)}`} style={{ flex: 1, marginTop: 0, minWidth: 120 }}><span style={{ width: `${Math.min(100, pct)}%` }} /></div><span className="muted small" style={{ minWidth: 38, textAlign: 'right' }}>{pct}%</span></div>;
            } },
          ]}
          rows={rows} loading={loading} error={capability || isFeatureDisabled(error) ? null : error} rowKey={(r) => r.period} dense
          emptyText={capability ? 'Traffic appears here once the web server is available on this server.' : 'No traffic recorded yet. Figures appear here after the first hour of visits to your domains.'}
        />
      </Card>

      {data && (
        <Card title="How traffic is counted" subtitle="The web server logs the panel reads for this account.">
          {data.sources?.length ? (
            <dl className="kv">
              {data.sources.map((s) => (
                <div key={s.path}><dt><code className="small">{s.path}</code></dt><dd>{formatBytes(s.bytes)} processed{s.lastSeenAt ? ` · last read ${formatDate(s.lastSeenAt)}` : ''}</dd></div>
              ))}
            </dl>
          ) : (
            <EmptyState icon={Gauge} title="No logs read yet"><p>The server scans the access logs every hour; the first scan happens after your site has had visitors.</p></EmptyState>
          )}
        </Card>
      )}
    </PanelPage>
  );
}
