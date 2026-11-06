import { useMemo, useState } from 'react';
import { RefreshCw, Play, ExternalLink, BarChart3, Users } from 'lucide-react';
import { Card, EmptyState, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, RequestError } from './parts/shared.jsx';

export const reportHref = (domain) => `/api/panel/logs/stats/${encodeURIComponent(domain)}/report`;

// The chosen domain, or the first one with a report, or the first domain.
export function pickDomain(domains, chosen) {
  const list = domains || [];
  if (list.some((d) => d.domain === chosen)) return chosen;
  return (list.find((d) => d.available) || list[0])?.domain || '';
}

export function generateState(row, now = Date.now(), t = untranslated) {
  if (!row) return { disabled: true, label: t('panel.logs.generate_now', 'Generate now') };
  if (row.running) return { disabled: true, label: row.running.status === 'running' ? t('panel.logs.generating', 'Generating…') : t('panel.logs.queued', 'Queued') };
  if (row.cooldownUntil && Date.parse(row.cooldownUntil) > now) return { disabled: true, label: fill(t('panel.logs.again_at', 'Again at {time}'), { time: new Date(row.cooldownUntil).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }) };
  return { disabled: false, label: row.available ? t('panel.logs.generate_again', 'Generate again') : t('panel.logs.generate_now', 'Generate now') };
}

const topColumns = (label, t) => [
  { key: 'label', label, render: (r) => <code className="small">{r.label || '—'}</code> },
  { key: 'hits', label: t('panel.logs.col_hits', 'Hits'), align: 'right', render: (r) => r.hits.toLocaleString() },
  { key: 'visitors', label: t('panel.logs.col_visitors', 'Visitors'), align: 'right', render: (r) => r.visitors.toLocaleString() },
  { key: 'bytes', label: t('panel.logs.col_transferred', 'Transferred'), align: 'right', render: (r) => formatBytes(r.bytes) },
];

function TopCard({ title, subtitle, label, rows, emptyText }) {
  const { t } = useT();
  return (
    <Card title={title} subtitle={subtitle} padded={false}>
      <DataTable columns={topColumns(label, t)} rows={rows || []} rowKey={(r) => r.label} dense emptyText={emptyText} />
    </Card>
  );
}

export default function Visitors({ fn }) {
  const toast = useToast();
  const { t } = useT();
  const [chosen, setChosen] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [busy, setBusy] = useState('');
  const { data, error, loading, refetch } = usePanelApi('/logs/stats');
  const anyRunning = Boolean(data?.domains?.some((d) => d.running));
  const live = usePanelApi(anyRunning ? '/logs/stats' : null, { enabled: anyRunning, refreshMs: 5000 });
  const current = live.data || data;
  const domains = current?.domains || [];
  const domain = pickDomain(domains, chosen);
  const row = useMemo(() => domains.find((d) => d.domain === domain) || null, [domains, domain]);
  const summary = row?.summary || null;
  const totals = summary?.totals || null;
  const capability = isCapabilityError(error);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const generate = async (d) => {
    setBusy(d);
    try {
      await panelApi.post(`/logs/stats/${encodeURIComponent(d)}/generate`, {});
      toast.success(fill(t('panel.logs.generating_for', 'Generating the visitors report for {domain}'), { domain: d }));
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(''); }
  };
  const state = generateState(row, Date.now(), t);
  const never = t('panel.logs.never', 'Never');

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <PanelCapabilityState card={capability} error={error} onRetry={refetch} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <p className="muted">{t('common.loading', 'Loading…')}</p>}

      {data && (
        <Card title={t('panel.logs.domain', 'Domain')} subtitle={current?.goaccess?.version ? fill(t('panel.logs.domain_subtitle_version', 'Reports are rendered by GoAccess {version} from your access logs every night; generate one now to see today\'s visitors.'), { version: current.goaccess.version }) : t('panel.logs.domain_subtitle', 'Reports are rendered from your access logs every night; generate one now to see today\'s visitors.')}
          actions={<Button icon={Play} variant="primary" disabled={state.disabled || busy === domain || !domain} loading={busy === domain} onClick={() => generate(domain)}>{state.label}</Button>}>
          <div className="form-grid">
            <Field label={t('panel.logs.domain', 'Domain')} htmlFor="visitors-domain"><Select id="visitors-domain" value={domain} onChange={(v) => { setChosen(v); setShowReport(false); }} options={domains.map((d) => ({ value: d.domain, label: d.available ? d.domain : fill(t('panel.logs.domain_no_report', '{domain} (no report yet)'), { domain: d.domain }) }))} disabled={!domains.length} /></Field>
            <Field label={t('panel.logs.last_generated', 'Last generated')} htmlFor="visitors-generated"><div id="visitors-generated" className="muted" style={{ paddingTop: 8 }}>{row?.generatedAt ? formatDate(row.generatedAt) : never}{row?.running ? ` · ${row.running.status === 'running' ? t('panel.logs.generating_now', 'generating now') : t('panel.logs.queued_lower', 'queued')}` : ''}</div></Field>
          </div>
          {row?.error && <p className="muted small">{fill(t('panel.logs.summary_unreadable', 'The stored summary for {domain} could not be read ({error}); generate it again.'), { domain: row.domain, error: row.error })}</p>}
        </Card>
      )}

      {totals && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat"><div className="label">{t('panel.logs.unique_visitors', 'Unique visitors')}</div><div className="value">{totals.visitors.toLocaleString()}</div><div className="muted small">{summary.period?.start ? `${summary.period.start} – ${summary.period.end || summary.period.start}` : t('panel.logs.whole_log', 'Whole log')}</div></div>
          <div className="stat"><div className="label">{t('panel.logs.requests', 'Requests')}</div><div className="value">{totals.requests.toLocaleString()}</div><div className="muted small">{fill(t('panel.logs.requests_detail', '{valid} valid · {failed} unparsed'), { valid: totals.validRequests.toLocaleString(), failed: totals.failedRequests.toLocaleString() })}</div></div>
          <div className="stat"><div className="label">{t('panel.logs.col_transferred', 'Transferred')}</div><div className="value">{formatBytes(totals.bandwidth)}</div><div className="muted small">{fill(t('panel.logs.distinct_files', '{count} distinct files'), { count: totals.files.toLocaleString() })}</div></div>
          <div className="stat"><div className="label">{t('panel.logs.not_found', 'Not found')}</div><div className="value">{totals.notFound.toLocaleString()}</div><div className="muted small">{t('panel.logs.distinct_missing', 'distinct missing addresses')}</div></div>
        </div>
      )}

      {data && row && !summary && !row.running && (
        <Card>
          <EmptyState icon={BarChart3} title={fill(t('panel.logs.no_report_for', 'No report yet for {domain}'), { domain: row.domain })}>
            <p>{t('panel.logs.no_report_before', 'The nightly run skips domains without visitors. Press')} <strong>{t('panel.logs.generate_now', 'Generate now')}</strong> {t('panel.logs.no_report_after', 'once your site has had traffic, or wait for the next nightly run.')}</p>
          </EmptyState>
        </Card>
      )}

      {summary && (
        <>
          <div className="grid-2">
            <TopCard title={t('panel.logs.top_pages', 'Top pages')} subtitle={t('panel.logs.top_pages_subtitle', 'Most requested addresses.')} label={t('panel.logs.col_page', 'Page')} rows={summary.pages} emptyText={t('panel.logs.top_pages_empty', 'No page requests in the log yet.')} />
            <TopCard title={t('panel.logs.referrers', 'Referring sites')} subtitle={t('panel.logs.referrers_subtitle', 'Where visitors came from.')} label={t('panel.logs.col_site', 'Site')} rows={summary.referrers} emptyText={t('panel.logs.referrers_empty', 'No referrers recorded yet.')} />
          </div>
          <div className="grid-2">
            <TopCard title={t('panel.logs.not_found', 'Not found')} subtitle={t('panel.logs.not_found_subtitle', 'Addresses that answered 404.')} label={t('panel.logs.col_address', 'Address')} rows={summary.notFound} emptyText={t('panel.logs.not_found_empty', 'Nothing missing: every request found its file.')} />
            {summary.countries?.length > 0
              ? <TopCard title={t('panel.logs.countries', 'Countries')} subtitle={t('panel.logs.countries_subtitle', 'Visitors by country (GeoIP).')} label={t('panel.logs.col_country', 'Country')} rows={summary.countries} emptyText={t('panel.logs.countries_empty', 'No country data.')} />
              : <TopCard title={t('panel.logs.responses', 'Responses')} subtitle={t('panel.logs.responses_subtitle', 'Status codes returned.')} label={t('panel.logs.col_status', 'Status')} rows={summary.statusCodes} emptyText={t('panel.logs.responses_empty', 'No responses recorded yet.')} />}
          </div>
          <Card title={t('panel.logs.per_day', 'Visitors per day')} subtitle={t('panel.logs.per_day_subtitle', 'The most recent days in the log.')} padded={false}>
            <DataTable
              columns={[
                { key: 'date', label: t('panel.logs.col_day', 'Day'), render: (r) => r.date },
                { key: 'visitors', label: t('panel.logs.col_visitors', 'Visitors'), align: 'right', render: (r) => r.visitors.toLocaleString() },
                { key: 'hits', label: t('panel.logs.col_hits', 'Hits'), align: 'right', render: (r) => r.hits.toLocaleString() },
                { key: 'bytes', label: t('panel.logs.col_transferred', 'Transferred'), align: 'right', render: (r) => formatBytes(r.bytes) },
              ]}
              rows={summary.days || []} rowKey={(r) => r.date} dense emptyText={t('panel.logs.per_day_empty', 'No daily figures yet.')}
            />
          </Card>
        </>
      )}

      {data && (
        <Card title={t('panel.logs.full_report', 'Full report')} subtitle={t('panel.logs.full_report_subtitle', 'The complete GoAccess report (browsers, operating systems, hours of the day and more).')} padded={false}
          actions={row?.available && (
            <>
              <Button icon={BarChart3} onClick={() => setShowReport((v) => !v)}>{showReport ? t('panel.logs.hide_report', 'Hide report') : t('panel.logs.open_report', 'Open full report')}</Button>
              <a className="btn" href={reportHref(row.domain)} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> {t('panel.logs.new_tab', 'New tab')}</a>
            </>
          )}>
          {!row?.available && <div style={{ padding: 16 }}><EmptyState icon={Users} title={t('panel.logs.no_report_open', 'No report to open')}><p>{t('panel.logs.no_report_open_text', 'The full report appears here once statistics have been generated for the chosen domain.')}</p></EmptyState></div>}
          {row?.available && !showReport && <p className="muted" style={{ padding: 16 }}>{t('panel.logs.report_frame_note', 'The report runs in an isolated frame and only sees its own numbers, never your panel session.')}</p>}
          {row?.available && showReport && (
            <iframe title={fill(t('panel.logs.report_frame_title', 'Visitors report for {domain}'), { domain: row.domain })} src={reportHref(row.domain)} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height: '75vh', border: 0, background: 'var(--surface)' }} />
          )}
        </Card>
      )}

      {data && (
        <Card title={t('panel.logs.all_domains_title', 'All domains')} subtitle={plural(t, 'panel.logs.domains_count', domains.length, '{count} domain on this account', '{count} domains on this account')} padded={false}>
          <DataTable
            columns={[
              { key: 'domain', label: t('panel.logs.domain', 'Domain'), render: (d) => <code>{d.domain}</code> },
              { key: 'generatedAt', label: t('panel.logs.last_generated', 'Last generated'), render: (d) => (d.generatedAt ? formatDate(d.generatedAt) : <span className="muted">{never}</span>) },
              { key: 'visitors', label: t('panel.logs.col_visitors', 'Visitors'), align: 'right', render: (d) => (d.summary ? d.summary.totals.visitors.toLocaleString() : '—') },
              { key: 'requests', label: t('panel.logs.requests', 'Requests'), align: 'right', render: (d) => (d.summary ? d.summary.totals.requests.toLocaleString() : '—') },
              { key: 'bandwidth', label: t('panel.logs.col_transferred', 'Transferred'), align: 'right', render: (d) => (d.summary ? formatBytes(d.summary.totals.bandwidth) : '—') },
              { key: 'state', label: t('panel.logs.col_state', 'State'), render: (d) => (d.running ? <span className="pill pill-info">{d.running.status === 'running' ? t('panel.logs.state_generating', 'Generating') : t('panel.logs.queued', 'Queued')}</span> : d.available ? <span className="pill pill-ok">{t('panel.logs.state_ready', 'Ready')}</span> : <span className="pill pill-muted">{t('panel.logs.state_no_report', 'No report')}</span>) },
            ]}
            rows={domains} loading={loading} error={capability || isFeatureDisabled(error) ? null : error} rowKey={(d) => d.domain} dense
            rowActions={(d) => [
              { label: t('panel.logs.show_report', 'Show'), primary: true, onClick: () => { setChosen(d.domain); setShowReport(false); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
              { label: generateState(d, Date.now(), t).label, disabled: generateState(d, Date.now(), t).disabled || busy === d.domain, onClick: () => generate(d.domain) },
            ]}
            emptyText={capability ? t('panel.logs.domains_empty_capability', 'Domains appear here once GoAccess is available on this server.') : t('panel.logs.domains_empty', 'No domains on this account yet.')}
          />
        </Card>
      )}
    </PanelPage>
  );
}
