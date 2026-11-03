import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, HardDrive, Activity } from 'lucide-react';
import { Card, KeyValue, EmptyState, Loading, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTION_BY_KEY } from '../../../panel/nav.js';

const DISK_USAGE_PATH = PANEL_FUNCTION_BY_KEY['panel:files/disk-usage']?.path || '/panel/files/disk-usage';
const OBJECT_LABELS = { addons: 'Addon domains', subdomains: 'Subdomains', parked: 'Parked domains', mailboxes: 'Mailboxes', databases: 'Databases', ftp: 'FTP accounts' };

const isCapability = (e) => Boolean(e) && (e.status === 501 || e.code === 'capability_missing' || e.code === 'binary_not_found');

// Plan counters: null = unlimited, 0 = not part of the plan, otherwise used of limit.
export function objectText(o) {
  const used = o.used == null ? '—' : String(o.used);
  if (o.limit == null) return `${used} · unlimited`;
  if (o.limit === 0) return o.used ? `${used} · none in plan` : 'None in plan';
  return `${used} of ${o.limit}`;
}

export function meterFor(used, limit) {
  const percent = limit == null || limit <= 0 ? null : percentOf(used, limit);
  return { percent, tone: meterTone(percent) };
}

export function Meter({ used, limit, name }) {
  const { percent, tone } = meterFor(used, limit);
  return <div className={`meter ${tone}`} data-meter={name} aria-hidden={percent == null}><span style={{ width: `${percent ?? 0}%` }} /></div>;
}

export function Stat({ name, label, value, used, limit, note }) {
  return (
    <div className="stat" data-stat={name}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 17 }}>{value}</div>
      <Meter used={used} limit={limit} name={name} />
      {note && <div className="muted small" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}

export default function Usage({ fn }) {
  const toast = useToast();
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
      toast.success(res.reused ? 'A disk scan is already running; figures update when it finishes' : 'Disk scan started; figures update when it finishes');
    } catch (err) {
      if (err.status === 429) toast.warning(err.message);
      else if (isCapability(err)) setRefreshError(err);
      else toast.error(err);
    } finally { setBusy(false); }
  };

  const d = data?.disk;
  const b = data?.bandwidth;
  const l = data?.limits || {};

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} loading={busy} disabled={Boolean(job)} onClick={refresh}>Refresh figures</Button>}>
      {error && error.status === 403 && error.code === 'feature_disabled' && <FeatureDisabledState fn={fn} />}
      {error && isCapability(error) && <PanelCapabilityState error={error} onRetry={refetch} />}
      {error && !isCapability(error) && !(error.status === 403 && error.code === 'feature_disabled') && <ErrorBanner error={error} onRetry={refetch} />}
      {refreshError && <PanelCapabilityState error={refreshError} onRetry={() => setRefreshError(null)} />}
      {job && (
        <Card title="Scanning disk usage" actions={<button className="btn btn-sm" onClick={() => { setJob(null); refetch(); }}>Close</button>}>
          <ProgressLog jobId={job} onFinished={() => refetch()} />
        </Card>
      )}
      {loading && !data && <Loading />}
      {data && (
        <>
          <div className="stat-grid" style={{ marginBottom: 18 }}>
            <Stat name="disk" label="Disk space" value={d.quotaMb ? `${formatMb(d.usedMb)} of ${formatMb(d.quotaMb)}` : `${formatMb(d.usedMb)} · unlimited`} used={d.usedMb} limit={d.quotaMb} note={d.source === 'repquota' ? 'From the file system quota' : 'From the last scan'} />
            <Stat name="bandwidth" label="Bandwidth this month" value={b.limitMb ? `${formatMb(b.usedMb)} of ${formatMb(b.limitMb)}` : `${formatMb(b.usedMb)} · unlimited`} used={b.usedMb} limit={b.limitMb} />
            {d.inodes != null && <Stat name="inodes" label="Files (inodes)" value={d.inodeLimit ? `${d.inodes.toLocaleString()} of ${d.inodeLimit.toLocaleString()}` : `${d.inodes.toLocaleString()} · unlimited`} used={d.inodes} limit={d.inodeLimit} />}
          </div>

          <Card title="What your plan includes" subtitle="How much of each allowance is in use.">
            <div className="stat-grid">
              {(data.objects || []).map((o) => <Stat key={o.key} name={o.key} label={OBJECT_LABELS[o.key] || o.key} value={objectText(o)} used={o.used} limit={o.limit} />)}
            </div>
          </Card>

          <div className="grid-2">
            <Card title="Where the space goes" subtitle={breakdown.rows.length ? `Top-level folders of your home directory${d.breakdown?.at ? `, scanned ${formatDate(d.breakdown.at)}` : ''}.` : 'Top-level folders of your home directory.'} padded={false}>
              {breakdown.rows.length === 0 ? (
                <EmptyState icon={HardDrive} title="No scan yet"><p>A folder-by-folder breakdown appears after the first disk scan.</p><p className="muted">Use "Refresh figures" to start one now.</p></EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Folder</th><th className="align-right">Size</th><th style={{ width: 160 }}>Share</th></tr></thead>
                    <tbody>
                      {breakdown.rows.map((e) => (
                        <tr key={e.path}>
                          <td><code>{e.path}</code></td>
                          <td className="align-right">{formatBytes((e.kb || 0) * 1024)}</td>
                          <td><div className="meter" style={{ marginTop: 0 }}><span style={{ width: `${breakdown.total ? Math.min(100, Math.round(((e.kb || 0) / breakdown.total) * 100)) : 0}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td><strong>Total</strong></td><td className="align-right"><strong>{formatBytes(breakdown.total * 1024)}</strong></td><td /></tr></tfoot>
                  </table>
                </div>
              )}
              <div className="card-body" style={{ paddingTop: 12 }}><p className="muted small" style={{ margin: 0 }}>For a full tree see <Link to={DISK_USAGE_PATH}>Disk usage</Link> under Files.</p></div>
            </Card>

            <Card title="Bandwidth by month" subtitle="Traffic served by your sites, most recent first." padded={false}>
              {months.rows.length === 0 ? (
                <EmptyState icon={Activity} title="No traffic recorded yet"><p>Monthly figures appear after the first daily collection of your sites' logs.</p></EmptyState>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Month</th><th className="align-right">Transferred</th><th style={{ width: 160 }}>Relative</th></tr></thead>
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

          <Card title="Plan limits" subtitle={`The ${data.account?.package || ''} plan on ${data.account?.username || 'this account'}.`}>
            <KeyValue items={[
              ['Disk space', l.disk_mb ? formatMb(l.disk_mb) : 'Unlimited'],
              ['Bandwidth per month', l.bandwidth_mb ? formatMb(l.bandwidth_mb) : 'Unlimited'],
              ['Domains', l.max_domains == null ? 'Unlimited' : String(l.max_domains)],
              ['Outgoing mail per hour', l.max_email_per_hour == null ? 'Unlimited' : String(l.max_email_per_hour)],
              ['Files (inodes)', l.quota_inodes == null ? 'Unlimited' : l.quota_inodes.toLocaleString()],
              ['Home directory', <code key="h">{data.account?.home}</code>],
              ['Figures last refreshed', d.lastRefresh ? formatDate(d.lastRefresh) : 'Not yet'],
              data.refresh?.lastRequestedAt && ['Last refresh request', formatDate(data.refresh.lastRequestedAt)],
            ]} />
          </Card>
        </>
      )}
    </PanelPage>
  );
}
