import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, HardDrive, Activity } from 'lucide-react';
import { Card, KeyValue, EmptyState, Loading, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';
import { JobProgress } from './parts/JobProgress.jsx';

const DISK_USAGE_PATH = PANEL_FUNCTION_BY_KEY['panel:files/disk-usage']?.path || '/panel/files/disk-usage';
const OBJECT_LABELS = { addons: 'Addon domains', subdomains: 'Subdomains', parked: 'Parked domains', mailboxes: 'Mailboxes', databases: 'Databases', ftp: 'FTP accounts' };

const isCapability = (e) => Boolean(e) && (e.status === 501 || e.code === 'capability_missing' || e.code === 'binary_not_found');

// Plan counters for a stat tile: null limit = unlimited, 0 = not part of the plan,
// otherwise the number as the value and the allowance below it.
export function objectParts(o, t = untranslated) {
  const value = o.used == null ? '—' : String(o.used);
  if (o.limit == null) return { value, sub: t('panel.usage.unlimited_lower', 'unlimited') };
  if (o.limit === 0) return { value, sub: t('panel.usage.none_in_plan', 'none in plan') };
  return { value, sub: fill(t('panel.usage.of_limit', 'of {limit}'), { limit: o.limit }) };
}

export function quotaParts(used, limit, format, t = untranslated) {
  return { value: format(used), sub: limit ? fill(t('panel.usage.of_limit', 'of {limit}'), { limit: format(limit) }) : t('panel.usage.unlimited_lower', 'unlimited') };
}

export function meterFor(used, limit) {
  const percent = limit == null || limit <= 0 ? null : percentOf(used, limit);
  return { percent, tone: meterTone(percent) };
}

export function Meter({ used, limit, name }) {
  const { percent, tone } = meterFor(used, limit);
  return <div className={`meter ${tone}`} data-meter={name} aria-hidden={percent == null}><span style={{ width: `${percent ?? 0}%` }} /></div>;
}

export function Stat({ name, label, value, sub, used, limit, note }) {
  return (
    <div className="stat" data-stat={name}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
      <Meter used={used} limit={limit} name={name} />
      {note && <div className="muted small" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

export default function Usage({ fn }) {
  const toast = useToast();
  const { t } = useT();
  const { data, error, loading, refetch } = usePanelApi('/usage');
  const [job, setJob] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [busy, setBusy] = useState(false);

  const breakdown = useMemo(() => {
    const entries = data?.disk?.breakdown?.entries || [];
    const total = data?.disk?.breakdown?.totalKb || entries.reduce((s, e) => s + (e.kb || 0), 0) || 0;
    return { total, rows: [...entries].sort((a, b) => (b.kb || 0) - (a.kb || 0)) };
  }, [data]);
  const months = useMemo(() => {
    const list = data?.bandwidth?.months || [];
    const max = Math.max(0, ...list.map((m) => m.mb || 0));
    return { max, rows: list };
  }, [data]);

  const refresh = async () => {
    setBusy(true);
    setRefreshError(null);
    try {
      const { data: res } = await panelApi.post('/usage/refresh', {});
      setJob(res.job?.id || null);
      toast.success(res.reused ? t('panel.usage.scan_reused', 'A disk scan is already running; figures update when it finishes') : t('panel.usage.scan_started', 'Disk scan started; figures update when it finishes'));
    } catch (err) {
      if (err.status === 429) toast.warning(err.message);
      else if (isCapability(err)) setRefreshError(err);
      else toast.error(err);
    } finally { setBusy(false); }
  };

  const d = data?.disk;
  const b = data?.bandwidth;
  const l = data?.limits || {};
  const unavailable = isCapability(error);
  const inodes = d && d.inodes != null ? quotaParts(d.inodes, d.inodeLimit, (n) => n.toLocaleString(), t) : null;
  const unlimited = t('panel.usage.unlimited', 'Unlimited');
  const objectLabel = (key) => t(`panel.usage.object_${key}`, OBJECT_LABELS[key] || key);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} loading={busy} disabled={unavailable} onClick={refresh}>{t('panel.usage.refresh_figures', 'Refresh figures')}</Button>}>
      {error && error.status === 403 && error.code === 'feature_disabled' && <FeatureDisabledState fn={fn} />}
      {unavailable && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}
      {error && !unavailable && !(error.status === 403 && error.code === 'feature_disabled') && <ErrorBanner error={error} onRetry={refetch} />}
      {refreshError && <Card><PanelCapabilityState error={refreshError} onRetry={() => setRefreshError(null)} /></Card>}
      {job && (
        <Card title={t('panel.usage.scanning_title', 'Scanning disk usage')} actions={<button className="btn btn-sm" onClick={() => { setJob(null); refetch(); }}>{t('common.close', 'Close')}</button>}>
          <JobProgress jobId={job} onFinished={refetch} message={t('panel.usage.scan_message', 'Disk scan started; the figures update in a minute.')} />
        </Card>
      )}
      {loading && !data && <Loading text={t('common.loading', 'Loading…')} />}
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <Stat name="disk" label={t('panel.usage.disk_space', 'Disk space')} {...quotaParts(d.usedMb, d.quotaMb, formatMb, t)} used={d.usedMb} limit={d.quotaMb} note={d.source === 'repquota' ? t('panel.usage.source_quota', 'From the file system quota') : t('panel.usage.source_scan', 'From the last scan')} />
            <Stat name="bandwidth" label={t('panel.usage.bandwidth_month', 'Bandwidth this month')} {...quotaParts(b.usedMb, b.limitMb, formatMb, t)} used={b.usedMb} limit={b.limitMb} />
            {inodes && <Stat name="inodes" label={t('panel.usage.inodes', 'Files (inodes)')} {...inodes} used={d.inodes} limit={d.inodeLimit} />}
          </div>

          <Card title={t('panel.usage.plan_includes_title', 'What your plan includes')} subtitle={t('panel.usage.plan_includes_subtitle', 'How much of each allowance is in use.')}>
            <div className="stat-grid">
              {(data.objects || []).map((o) => <Stat key={o.key} name={o.key} label={objectLabel(o.key)} {...objectParts(o, t)} used={o.used} limit={o.limit} />)}
            </div>
          </Card>

          <div className="grid-2">
            <Card title={t('panel.usage.space_title', 'Where the space goes')} subtitle={breakdown.rows.length ? `${t('panel.usage.space_subtitle_base', 'Top-level folders of your home directory')}${d.breakdown?.at ? `, ${fill(t('panel.usage.scanned_at', 'scanned {date}'), { date: formatDate(d.breakdown.at) })}` : ''}.` : t('panel.usage.space_subtitle', 'Top-level folders of your home directory.')} padded={false}>
              {breakdown.rows.length === 0 ? (
                <EmptyState icon={HardDrive} title={t('panel.usage.no_scan_title', 'No scan yet')}><p>{t('panel.usage.no_scan_text', 'A folder-by-folder breakdown appears after the first disk scan.')}</p><p className="muted">{t('panel.usage.no_scan_hint', 'Use "Refresh figures" to start one now.')}</p></EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{t('panel.usage.col_folder', 'Folder')}</th><th className="align-right">{t('panel.usage.col_size', 'Size')}</th><th style={{ width: 160 }}>{t('panel.usage.col_share', 'Share')}</th></tr></thead>
                    <tbody>
                      {breakdown.rows.map((e) => (
                        <tr key={e.path}>
                          <td><code>{e.path}</code></td>
                          <td className="align-right">{formatBytes((e.kb || 0) * 1024)}</td>
                          <td><div className="meter" style={{ marginTop: 0 }}><span style={{ width: `${breakdown.total ? Math.min(100, Math.round(((e.kb || 0) / breakdown.total) * 100)) : 0}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td><strong>{t('panel.usage.total', 'Total')}</strong></td><td className="align-right"><strong>{formatBytes(breakdown.total * 1024)}</strong></td><td /></tr></tfoot>
                  </table>
                </div>
              )}
              <div className="card-body" style={{ paddingTop: 12 }}><p className="muted small" style={{ margin: 0 }}>{t('panel.usage.full_tree_before', 'For a full tree see')} <Link to={DISK_USAGE_PATH}>{t('panel.files/disk-usage.label', 'Disk usage')}</Link> {t('panel.usage.full_tree_after', 'under Files.')}</p></div>
            </Card>

            <Card title={t('panel.usage.bandwidth_title', 'Bandwidth by month')} subtitle={t('panel.usage.bandwidth_subtitle', 'Traffic served by your sites, most recent first.')} padded={false}>
              {months.rows.length === 0 ? (
                <EmptyState icon={Activity} title={t('panel.usage.no_traffic_title', 'No traffic recorded yet')}><p>{t('panel.usage.no_traffic_text', 'Monthly figures appear after the first daily collection of your sites\' logs.')}</p></EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{t('panel.usage.col_month', 'Month')}</th><th className="align-right">{t('panel.usage.col_transferred', 'Transferred')}</th><th style={{ width: 160 }}>{t('panel.usage.col_relative', 'Relative')}</th></tr></thead>
                    <tbody>
                      {months.rows.map((m) => (
                        <tr key={m.period}>
                          <td>{m.period}</td>
                          <td className="align-right">{formatMb(m.mb)}</td>
                          <td><div className="meter" style={{ marginTop: 0 }}><span style={{ width: `${months.max ? Math.round(((m.mb || 0) / months.max) * 100) : 0}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <Card title={t('panel.usage.limits_title', 'Plan limits')} subtitle={fill(t('panel.usage.limits_subtitle', 'The {plan} plan on {account}.'), { plan: data.account?.package || '', account: data.account?.username || t('panel.usage.this_account', 'this account') })}>
            <KeyValue items={[
              [t('panel.usage.disk_space', 'Disk space'), l.disk_mb ? formatMb(l.disk_mb) : unlimited],
              [t('panel.usage.bandwidth_per_month', 'Bandwidth per month'), l.bandwidth_mb ? formatMb(l.bandwidth_mb) : unlimited],
              [t('panel.usage.domains', 'Domains'), l.max_domains == null ? unlimited : String(l.max_domains)],
              [t('panel.usage.mail_per_hour', 'Outgoing mail per hour'), l.max_email_per_hour == null ? unlimited : String(l.max_email_per_hour)],
              [t('panel.usage.inodes', 'Files (inodes)'), l.quota_inodes == null ? unlimited : l.quota_inodes.toLocaleString()],
              [t('panel.usage.home_directory', 'Home directory'), <code key="h">{data.account?.home}</code>],
              [t('panel.usage.last_refreshed', 'Figures last refreshed'), d.lastRefresh ? formatDate(d.lastRefresh) : t('panel.usage.not_yet', 'Not yet')],
              data.refresh?.lastRequestedAt && [t('panel.usage.last_refresh_request', 'Last refresh request'), formatDate(data.refresh.lastRequestedAt)],
            ]} />
          </Card>
        </>
      )}
    </PanelPage>
  );
}
