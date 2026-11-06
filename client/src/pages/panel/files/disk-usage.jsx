import { useMemo } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { RefreshCw, AlertTriangle, FolderOpen } from 'lucide-react';
import { Card, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { RequestError, PathBar } from './parts/common.jsx';
import { normalizeRel, duPath, managerHref, diskUsageHref, isCapabilityError, isFeatureDisabled, baseName } from './parts/paths.js';

// du reports every entry relative to the home; the table shows them relative to
// the folder being looked at, largest first, with its share of the folder. At
// depth 2 each parent's children follow it directly, largest first, so the
// indentation always sits under the folder the row belongs to.
export function shapeRows(entries, dir, totalKb) {
  const prefix = dir ? `${dir}/` : '';
  const rows = (entries || [])
    .filter((e) => e.path && e.path !== '.' && (!prefix || e.path.startsWith(prefix)))
    .map((e) => ({ path: e.path, name: prefix ? e.path.slice(prefix.length) : e.path, kb: e.kb || 0, percent: totalKb > 0 ? Math.min(100, Math.round(((e.kb || 0) / totalKb) * 1000) / 10) : null, depth: e.path.split('/').length - (dir ? dir.split('/').length : 0) }))
    .sort((a, b) => b.kb - a.kb);
  const children = new Map();
  for (const r of rows.filter((r) => r.depth > 1)) {
    const parent = r.path.slice(0, r.path.lastIndexOf('/'));
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(r);
  }
  const placed = new Set();
  const out = [];
  const place = (r) => { if (placed.has(r.path)) return; placed.add(r.path); out.push(r); for (const c of children.get(r.path) || []) place(c); };
  for (const r of rows.filter((r) => r.depth <= 1)) place(r);
  for (const r of rows) place(r);
  return out;
}

export default function DiskUsage({ fn }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const dir = normalizeRel(params.get('path') || '') ?? '';
  const depth = params.get('depth') === '2' ? 2 : 1;
  const { data, error, loading, refetch } = usePanelApi(duPath(dir, depth));
  const rows = useMemo(() => shapeRows(data?.entries, dir, data?.totalKb), [data, dir]);
  const capability = isCapabilityError(error);
  const usage = me?.usage || {};
  const quotaPercent = percentOf(usage.diskUsedMb, usage.diskQuotaMb);
  const folderBytes = (data?.totalKb || 0) * 1024;
  const folderPercent = usage.diskQuotaMb ? percentOf(folderBytes / (1024 * 1024), usage.diskQuotaMb) : null;
  const setDepth = (d) => setParams(dir ? { path: dir, depth: String(d) } : { depth: String(d) });

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('panel.files.refresh', 'Refresh')}</Button>}>
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat" data-stat="folder">
          <div className="label">{dir ? <><code>~/{dir}</code> {t('panel.files.uses', 'uses')}</> : t('panel.files.home_uses', 'Your home directory uses')}</div>
          <div className="value">{data ? formatBytes(folderBytes) : '—'}</div>
          <div className={`meter ${meterTone(folderPercent)}`}><span style={{ width: `${error ? 0 : folderPercent ?? 0}%` }} /></div>
          <div className="muted small" style={{ marginTop: 6 }}>{error ? '—' : folderPercent != null ? fill(t('panel.files.percent_of_plan', '{percent}% of the plan\'s {quota}'), { percent: folderPercent, quota: formatMb(usage.diskQuotaMb) }) : t('panel.files.no_disk_limit', 'No disk limit on this plan')}</div>
        </div>
        <div className="stat" data-stat="account">
          <div className="label">{t('panel.files.whole_account', 'Whole account')}</div>
          <div className="value">{formatMb(usage.diskUsedMb ?? 0)}</div>
          <div className={`meter ${meterTone(quotaPercent)}`}><span style={{ width: `${quotaPercent ?? 0}%` }} /></div>
          <div className="muted small" style={{ marginTop: 6 }}>{usage.diskQuotaMb ? fill(t('panel.files.of_quota_includes', 'of {quota} · includes mail and databases'), { quota: formatMb(usage.diskQuotaMb) }) : t('panel.files.unlimited_includes', 'Unlimited · includes mail and databases')}</div>
        </div>
        <div className="stat" data-stat="measured">
          <div className="label">{t('panel.files.sub_folders', 'Sub-folders')}</div>
          <div className="value">{data ? rows.filter((r) => r.depth <= 1).length : '—'}</div>
          <div className="muted small" style={{ marginTop: 6 }}>{error ? t('panel.files.du_empty_error', 'This folder could not be measured.') : data?.measuredAt ? <>{t('panel.files.measured', 'Measured')} <time dateTime={data.measuredAt}>{formatDate(data.measuredAt)}</time>{data.cached ? t('panel.files.figures_cached', '; the figures are kept for five minutes') : ''}</> : data ? t('panel.files.fresh_figures', 'Fresh figures from the server') : t('panel.files.measuring', 'Measuring…')}</div>
        </div>
      </div>

      <Card padded={false}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <PathBar path={dir} hrefFor={(p) => diskUsageHref(p)} homeDir={me?.account?.homeDir} />
          <div className="segmented" style={{ marginLeft: 'auto' }} role="group" aria-label={t('panel.files.depth', 'Depth')}>
            <button type="button" className={depth === 1 ? 'active' : ''} onClick={() => setDepth(1)}>{t('panel.files.one_level', 'One level')}</button>
            <button type="button" className={depth === 2 ? 'active' : ''} onClick={() => setDepth(2)}>{t('panel.files.two_levels', 'Two levels')}</button>
          </div>
        </div>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {!capability && error && <div className="card-body"><RequestError error={error} onRetry={refetch} /></div>}
        {data?.partial && <div className="card-body"><div className="banner banner-warning" style={{ marginBottom: 0 }}><AlertTriangle size={18} /><div><strong>{t('panel.files.partial_title', 'Some folders could not be measured')}</strong><p>{t('panel.files.partial_help', 'The totals leave out what the account is not allowed to read.')}</p></div></div></div>}
        <DataTable
          dense
          columns={[
            { key: 'name', label: t('panel.files.folder', 'Folder'), render: (r) => <Link to={diskUsageHref(r.path)} style={r.depth > 1 ? { paddingLeft: `${(r.depth - 1) * 18}px` } : undefined}><FolderOpen size={15} className="muted" aria-hidden="true" style={{ verticalAlign: '-3px' }} /> {r.name}</Link> },
            { key: 'kb', label: t('panel.files.col_size', 'Size'), align: 'right', render: (r) => formatBytes(r.kb * 1024) },
            { key: 'percent', label: t('panel.files.share_of_folder', 'Share of this folder'), width: 260, render: (r) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="meter" style={{ flex: 1, marginTop: 0 }}><span style={{ width: `${r.percent ?? 0}%` }} /></div>
                <span className="muted small" style={{ minWidth: 48, textAlign: 'right' }}>{r.percent == null ? '—' : `${r.percent}%`}</span>
              </div>
            ) },
          ]}
          rows={rows} loading={loading} error={null} rowKey={(r) => r.path}
          rowActions={(r) => [
            { label: t('panel.files.look_inside', 'Look inside'), primary: true, onClick: () => setParams({ path: r.path, depth: String(depth) }) },
            { label: t('panel.files.open_in_file_manager', 'Open in file manager'), onClick: () => navigate(managerHref(r.path)) },
          ]}
          emptyText={capability ? t('panel.files.du_empty_capability', 'Folder sizes appear here once the file manager is available on this server.') : error ? t('panel.files.du_empty_error', 'This folder could not be measured.') : dir ? fill(t('panel.files.du_no_subfolders', '{folder} holds no sub-folders; its files make up the size above.'), { folder: baseName(dir) }) : t('panel.files.du_empty_home', 'No sub-folders yet. Once you upload files, the folders of your home directory are listed here, largest first.')}
        />
        <div className="card-body muted small">
          {t('panel.files.files_directly_in', 'Files directly in')} {dir ? <code>~/{dir}</code> : t('panel.files.the_home_directory', 'the home directory')} {t('panel.files.count_not_listed', 'count towards its size but are not listed.')} {t('panel.files.mailboxes_under', 'Mailboxes live under')} <Link to={diskUsageHref('mail')}>mail</Link>, {t('panel.files.website_under', 'your website under')} <Link to={diskUsageHref('public_html')}>public_html</Link>; {t('panel.files.delete_in', 'delete what you no longer need in the')} <Link to={managerHref(dir)}>{t('panel.files.file_manager_link', 'file manager')}</Link>.
        </div>
      </Card>
    </PanelPage>
  );
}
