import { useMemo } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { RefreshCw, AlertTriangle, FolderOpen } from 'lucide-react';
import { Card, formatBytes, formatMb, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button } from '../../../components/Form.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, percentOf, meterTone } from '../../../panel/hooks/usePanel.js';
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
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat" data-stat="folder">
          <div className="label">{dir ? <><code>~/{dir}</code> uses</> : 'Your home directory uses'}</div>
          <div className="value">{data ? formatBytes(folderBytes) : '—'}</div>
          <div className={`meter ${meterTone(folderPercent)}`}><span style={{ width: `${folderPercent ?? 0}%` }} /></div>
          <div className="muted small" style={{ marginTop: 6 }}>{folderPercent != null ? `${folderPercent}% of the plan's ${formatMb(usage.diskQuotaMb)}` : 'No disk limit on this plan'}</div>
        </div>
        <div className="stat" data-stat="account">
          <div className="label">Whole account</div>
          <div className="value">{formatMb(usage.diskUsedMb ?? 0)}</div>
          <div className={`meter ${meterTone(quotaPercent)}`}><span style={{ width: `${quotaPercent ?? 0}%` }} /></div>
          <div className="muted small" style={{ marginTop: 6 }}>{usage.diskQuotaMb ? `of ${formatMb(usage.diskQuotaMb)} · includes mail and databases` : 'Unlimited · includes mail and databases'}</div>
        </div>
        <div className="stat" data-stat="measured">
          <div className="label">Sub-folders</div>
          <div className="value">{data ? rows.filter((r) => r.depth <= 1).length : '—'}</div>
          <div className="muted small" style={{ marginTop: 6 }}>{data?.measuredAt ? <>Measured <time dateTime={data.measuredAt}>{formatDate(data.measuredAt)}</time>{data.cached ? '; the figures are kept for five minutes' : ''}</> : data ? 'Fresh figures from the server' : 'Measuring…'}</div>
        </div>
      </div>

      <Card padded={false}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <PathBar path={dir} hrefFor={(p) => diskUsageHref(p)} homeDir={me?.account?.homeDir} />
          <div className="segmented" style={{ marginLeft: 'auto' }} role="group" aria-label="Depth">
            <button type="button" className={depth === 1 ? 'active' : ''} onClick={() => setDepth(1)}>One level</button>
            <button type="button" className={depth === 2 ? 'active' : ''} onClick={() => setDepth(2)}>Two levels</button>
          </div>
        </div>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {!capability && error && <div className="card-body"><RequestError error={error} onRetry={refetch} /></div>}
        {data?.partial && <div className="card-body"><div className="banner banner-warning" style={{ marginBottom: 0 }}><AlertTriangle size={18} /><div><strong>Some folders could not be measured</strong><p>The totals leave out what the account is not allowed to read.</p></div></div></div>}
        <DataTable
          dense
          columns={[
            { key: 'name', label: 'Folder', render: (r) => <Link to={diskUsageHref(r.path)} style={r.depth > 1 ? { paddingLeft: `${(r.depth - 1) * 18}px` } : undefined}><FolderOpen size={15} className="muted" aria-hidden="true" style={{ verticalAlign: '-3px' }} /> {r.name}</Link> },
            { key: 'kb', label: 'Size', align: 'right', render: (r) => formatBytes(r.kb * 1024) },
            { key: 'percent', label: 'Share of this folder', width: 260, render: (r) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="meter" style={{ flex: 1, marginTop: 0 }}><span style={{ width: `${r.percent ?? 0}%` }} /></div>
                <span className="muted small" style={{ minWidth: 48, textAlign: 'right' }}>{r.percent == null ? '—' : `${r.percent}%`}</span>
              </div>
            ) },
          ]}
          rows={rows} loading={loading} error={null} rowKey={(r) => r.path}
          rowActions={(r) => [
            { label: 'Look inside', primary: true, onClick: () => setParams({ path: r.path, depth: String(depth) }) },
            { label: 'Open in file manager', onClick: () => navigate(managerHref(r.path)) },
          ]}
          emptyText={capability ? 'Folder sizes appear here once the file manager is available on this server.' : error ? 'This folder could not be measured.' : dir ? `${baseName(dir)} holds no sub-folders; its files make up the size above.` : 'No sub-folders yet. Once you upload files, the folders of your home directory are listed here, largest first.'}
        />
        <div className="card-body muted small">
          Files directly in {dir ? <code>~/{dir}</code> : 'the home directory'} count towards its size but are not listed. Mailboxes live under <Link to={diskUsageHref('mail')}>mail</Link>, your website under <Link to={diskUsageHref('public_html')}>public_html</Link>; delete what you no longer need in the <Link to={managerHref(dir)}>file manager</Link>.
        </div>
      </Card>
    </PanelPage>
  );
}
