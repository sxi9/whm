import { useMemo, useState } from 'react';
import { RefreshCw, Gauge } from 'lucide-react';
import { Card, EmptyState, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button } from '../../../components/Form.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, periodLabel, currentPeriod, RequestError } from './parts/shared.jsx';

const RANGES = ['3', '6', '12', '24'];

export function limitText(limitMb, t = untranslated) {
  return limitMb == null || limitMb <= 0 ? t('panel.logs.unlimited', 'Unlimited') : formatMb(limitMb);
}

export function monthRows(months) {
  return [...(months || [])].sort((a, b) => (a.period < b.period ? 1 : -1));
}

export function peakOf(months) {
  return (months || []).reduce((m, r) => Math.max(m, Number(r.bytes) || 0), 0);
}

export default function Bandwidth({ fn }) {
  const { t } = useT();
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
  const ranges = RANGES.map((value) => ({ value, label: fill(t('panel.logs.last_months', 'Last {count} months'), { count: value }) }));

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <PanelCapabilityState error={error} onRetry={refetch} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">{t('common.loading', 'Loading…')}</p>}
      {data && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat">
            <div className="label">{current ? periodLabel(current.period) : t('panel.logs.this_month', 'This month')}</div>
            <div className="value">{current ? formatBytes(current.bytes) : '—'}</div>
            <div className="muted small">{unlimited ? t('panel.logs.no_monthly_limit', 'No monthly limit in this plan') : fill(t('panel.logs.percent_of_limit', '{percent}% of {limit}'), { percent: percent ?? 0, limit: limitText(limitMb, t) })}</div>
            {!unlimited && <div className={`meter ${meterTone(percent)}`}><span style={{ width: `${percent ?? 0}%` }} /></div>}
          </div>
          <div className="stat"><div className="label">{t('panel.logs.monthly_limit', 'Monthly limit')}</div><div className="value">{limitText(limitMb, t)}</div><div className="muted small">{unlimited ? t('panel.logs.not_capped', 'Traffic is not capped') : t('panel.logs.set_by_plan', 'Set by your hosting plan')}</div></div>
          <div className="stat"><div className="label">{t('panel.logs.busiest_month', 'Busiest month shown')}</div><div className="value">{peak ? formatBytes(peak) : '—'}</div><div className="muted small">{peak ? periodLabel(rows.find((r) => Number(r.bytes) === peak)?.period) : t('panel.logs.no_traffic', 'No traffic recorded yet')}</div></div>
          <div className="stat"><div className="label">{t('panel.logs.total_shown', 'Total shown')}</div><div className="value">{formatBytes(total)}</div><div className="muted small">{plural(t, 'panel.logs.months_count', rows.length, '{count} month', '{count} months')}</div></div>
        </div>
      )}

      <Card title={t('panel.logs.traffic_title', 'Traffic per month')} subtitle={data?.domain ? fill(t('panel.logs.traffic_subtitle_domain', 'All domains of {domain}, measured from the web server logs.'), { domain: data.domain }) : t('panel.logs.traffic_subtitle', 'Measured from the web server logs.')} padded={false}
        actions={<Field inline htmlFor="bw-months"><Select id="bw-months" value={months} onChange={setMonths} options={ranges} /></Field>}>
        <DataTable
          columns={[
            { key: 'period', label: t('panel.logs.col_month', 'Month'), render: (r) => (r.period === thisPeriod ? <strong>{periodLabel(r.period)}</strong> : periodLabel(r.period)) },
            { key: 'bytes', label: t('panel.logs.col_transferred', 'Transferred'), align: 'right', render: (r) => formatBytes(r.bytes) },
            { key: 'percent', label: limitKnown && unlimited ? t('panel.logs.col_relative', 'Relative to the busiest month') : t('panel.logs.col_of_limit', 'Of the monthly limit'), render: (r) => {
              const pct = unlimited ? (peak ? Math.round((Number(r.bytes) / peak) * 100) : 0) : (r.percent ?? percentOf(r.usedMb, limitMb) ?? 0);
              return <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className={`meter ${unlimited ? '' : meterTone(pct)}`} style={{ flex: 1, marginTop: 0, minWidth: 120 }}><span style={{ width: `${Math.min(100, pct)}%` }} /></div><span className="muted small" style={{ minWidth: 38, textAlign: 'right' }}>{pct}%</span></div>;
            } },
          ]}
          rows={rows} loading={loading} error={capability || isFeatureDisabled(error) ? null : error} rowKey={(r) => r.period} dense
          emptyText={capability ? t('panel.logs.traffic_empty_capability', 'Traffic appears here once the web server is available on this server.') : t('panel.logs.traffic_empty', 'No traffic recorded yet. Figures appear here after the first hour of visits to your domains.')}
        />
      </Card>

      {data && (
        <Card title={t('panel.logs.sources_title', 'How traffic is counted')} subtitle={t('panel.logs.sources_subtitle', 'The web server logs the panel reads for this account.')}>
          {data.sources?.length ? (
            <dl className="kv">
              {data.sources.map((s) => (
                <div key={s.path}><dt><code className="small">{s.path}</code></dt><dd>{fill(t('panel.logs.source_processed', '{bytes} processed'), { bytes: formatBytes(s.bytes) })}{s.lastSeenAt ? ` · ${fill(t('panel.logs.source_last_read', 'last read {date}'), { date: formatDate(s.lastSeenAt) })}` : ''}</dd></div>
              ))}
            </dl>
          ) : (
            <EmptyState icon={Gauge} title={t('panel.logs.sources_empty_title', 'No logs read yet')}><p>{t('panel.logs.sources_empty_text', 'The server scans the access logs every hour; the first scan happens after your site has had visitors.')}</p></EmptyState>
          )}
        </Card>
      )}
    </PanelPage>
  );
}
