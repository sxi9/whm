import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, formatBytes, formatMb, formatDate, KeyValue, Loading } from '../../../components/Common.jsx';
import { Button, Field, Select, TextInput, NumberInput, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { DataTable, useTableState } from '../../../components/DataTable.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { JobCard, Meter, RequestError, Tabs, Stat, periodLabel } from '../../account-info/Shared.jsx';
import { BandwidthChart } from '../../account-info/BandwidthChart.jsx';

const SCOPES = [{ value: 'all', label: 'All accounts' }, { value: 'warn', label: 'Near limit' }, { value: 'over', label: 'Over limit' }];

export default function ViewBandwidthUsage({ fn }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const [scope, setScope] = useState('all');
  const [period, setPeriod] = useState('');
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const selected = params.get('username');
  const t = useTableState({ sort: 'bytes', dir: 'desc' });
  const { data, meta, loading, error, refetch } = useApi(`/account-info/bandwidth${queryString({ ...t.state, scope, period })}`);
  const history = useApi(selected ? `/account-info/bandwidth/${encodeURIComponent(selected)}?months=12` : null, { enabled: Boolean(selected) });

  const select = (username) => setParams(username ? { username } : {});
  const collect = async () => {
    setBusy(true);
    try { const { data: d } = await api.post('/account-info/bandwidth/collect'); setJobId(d.job.id); toast.info('Parsing access logs…'); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const reset = async (username, all) => {
    const ok = await confirm({ title: all ? `Clear all bandwidth history for ${username}?` : `Reset this month's counter for ${username}?`, message: all ? 'Every recorded month is deleted. Access logs are not touched, but already-parsed bytes are not re-read.' : `The ${periodLabel(meta?.period)} total goes back to zero; the account can be unsuspended afterwards if it was suspended for exceeding its limit.`, confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    try { await api.post(`/account-info/bandwidth/${username}/reset`, all ? { all: true } : {}); toast.success(`Bandwidth counter reset for ${username}`); refetch(); history.refetch(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'username', label: 'Account', sortable: true, render: (r) => <code>{r.username}</code> },
    { key: 'domain', label: 'Domain', sortable: true },
    { key: 'owner', label: 'Owner', sortable: true },
    { key: 'bytes', label: 'Transferred', sortable: true, align: 'right', render: (r) => formatBytes(r.bytes) },
    { key: 'bandwidth_limit_mb', label: 'Limit', sortable: true, align: 'right', render: (r) => formatMb(r.bandwidth_limit_mb) },
    { key: 'percent', label: 'Usage', sortable: true, render: (r) => <Meter percent={r.percent} warnAt={meta?.warnPercent ?? 80} /> },
    { key: 'status', label: 'Status', render: (r) => r.suspended ? <StatusPill status="suspended">Suspended</StatusPill> : r.over ? <StatusPill status="failed">Over limit</StatusPill> : r.warn ? <StatusPill status="warning">Near limit</StatusPill> : <StatusPill status="ok">OK</StatusPill> },
  ];
  const rowActions = (r) => [
    { label: 'History', primary: true, onClick: () => select(r.username) },
    { label: 'Change limit', onClick: () => navigate(`/account-functions/limit-bandwidth-usage?username=${r.username}`) },
    { label: 'Reset this month', danger: true, onClick: () => reset(r.username, false) },
  ];

  const overCount = (data || []).filter((r) => r.over).length;
  return (
    <>
      <PageHeader fn={fn} description="Monthly transfer per account, parsed hourly from each site's Apache access logs (/var/log/whm/domlogs/<user>/*-access.log). Whether accounts that pass their limit are suspended is decided under Account Functions › Limit Bandwidth Usage."
        actions={isRoot && <Button icon={Activity} loading={busy} onClick={collect}>Collect now</Button>} />
      <RequestError error={error} onRetry={refetch} />
      {meta && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <Stat label={`Total in ${periodLabel(meta.period)}`} value={formatBytes(meta.totalBytes)} hint={`${meta.total} account(s) listed`} />
          <Stat label="Over limit (this page)" value={overCount} hint={meta.enforcement?.enabled ? 'Exceeders are suspended after each collection' : 'Exceeders are only flagged (enforcement off)'} />
          <Stat label="Warn threshold" value={`${meta.warnPercent}%`} />
          <Stat label="Last collection" value={meta.lastCollect ? formatDate(meta.lastCollect) : 'never'} hint="Runs on the account-bandwidth schedule (hourly)" />
        </div>
      )}
      <JobCard jobId={jobId} title="Bandwidth collection" onFinished={() => { refetch(); history.refetch(); }} />
      <Card padded={false}>
        <div style={{ padding: '12px 14px 0', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Tabs tabs={SCOPES} value={scope} onChange={(v) => { setScope(v); t.setPage(1); }} />
          <div style={{ marginLeft: 'auto', minWidth: 180 }}>
            <Select value={period || meta?.period || ''} onChange={(v) => { setPeriod(v); t.setPage(1); }} options={(meta?.periods || []).map((p) => ({ value: p, label: periodLabel(p) }))} aria-label="Month" />
          </div>
        </div>
        <DataTable columns={columns} rows={data || []} loading={loading} error={null} rowKey={(r) => r.username}
          total={meta?.total} page={t.state.page} pageSize={t.state.pageSize} onPageChange={t.setPage}
          sort={t.state.sort} dir={t.state.dir} onSortChange={t.setSort}
          searchable q={t.state.q} onSearch={t.setSearch} searchPlaceholder="Search account, domain or owner…"
          rowActions={rowActions} emptyText={scope === 'all' ? 'No accounts yet.' : scope === 'over' ? 'No account is over its bandwidth limit.' : 'No account is near its limit.'} />
      </Card>
      {selected && (
        <Card title={`Bandwidth history: ${selected}`} subtitle="Last 12 months" actions={<><Button size="sm" variant="danger-ghost" onClick={() => reset(selected, true)}>Clear history</Button><Button size="sm" onClick={() => select(null)}>Close</Button></>}>
          <RequestError error={history.error} onRetry={history.refetch} />
          {history.loading && !history.data && <Loading />}
          {history.data && <AccountHistory data={history.data} />}
        </Card>
      )}
      {isRoot && <BandwidthSettings onSaved={refetch} />}
    </>
  );
}

function AccountHistory({ data }) {
  const overMonths = data.months.filter((m) => m.percent != null && m.percent >= 100).map((m) => periodLabel(m.period));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 20 }}>
      <div>
        <BandwidthChart months={data.months} limitMb={data.limitMb} />
        {overMonths.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Over the limit in: {overMonths.join(', ')}</p>}
      </div>
      <div>
        <KeyValue items={[['Domain', data.domain], ['Owner', data.owner], ['Monthly limit', formatMb(data.limitMb)], ['Status', data.suspended ? <StatusPill key="s" status="suspended">Suspended{data.suspend_reason ? `: ${data.suspend_reason}` : ''}</StatusPill> : <StatusPill key="s" status="active">Active</StatusPill>]]} />
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Month</th><th className="align-right">Transferred</th><th className="align-right">Of limit</th></tr></thead>
            <tbody>
              {[...data.months].reverse().map((m) => <tr key={m.period}><td>{periodLabel(m.period)}</td><td className="align-right">{formatBytes(m.bytes)}</td><td className="align-right">{m.percent == null ? '—' : `${m.percent}%`}</td></tr>)}
            </tbody>
          </table>
        </div>
        {data.sources.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary>Log files parsed ({data.sources.length})</summary>
            <ul className="small" style={{ paddingLeft: 18 }}>
              {data.sources.map((s) => <li key={s.path}><code className="small">{s.path}</code> — {formatBytes(s.bytes_processed)} of {formatBytes(s.size)} parsed, {s.lines} line(s), {formatDate(s.last_seen_at)}</li>)}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function BandwidthSettings({ onSaved }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useApi('/account-info/bandwidth/settings');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (data?.settings) setDraft(data.settings); }, [data]);
  const base = data?.settings;
  const dirty = draft && base && JSON.stringify(draft) !== JSON.stringify(base);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k])));
    setSaving(true); setSaveError(null);
    try { await api.put('/account-info/bandwidth/settings', changed); toast.success('Bandwidth settings saved'); await refetch(); onSaved?.(); } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Bandwidth collection" subtitle={data ? `Logs are read from ${data.logsRoot}/<user>/; at most ${formatBytes(data.readCap)} of new log data is read per file and run, the rest on the next run. The last bytes of a rotated log are counted from its .1 / dated copy.` : undefined} className="config-fields">
      <ErrorBanner error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <StatusPill status={data.enforcement?.enabled ? 'ok' : 'warning'}>{data.enforcement?.enabled ? 'Automatic suspension on' : 'Automatic suspension off'}</StatusPill>
          <span className="muted small">
            {data.enforcement?.enabled ? `Accounts over their limit are suspended after each collection with the reason “${data.enforcement.reason || 'bandwidth: monthly transfer limit exceeded'}”; Unsuspend Bandwidth Exceeders lifts them in bulk.` : 'Accounts over their limit are only flagged.'} Configured under Account Functions.
          </span>
          <Button size="sm" onClick={() => navigate('/account-functions/limit-bandwidth-usage')}>Limit Bandwidth Usage</Button>
        </div>
      )}
      {draft && (
        <>
          <div className="form-grid">
            <Field label="Warn at (% of limit)"><NumberInput value={draft.warnPercent} onChange={set('warnPercent')} min={1} max={100} nullable={false} /></Field>
            <Field label="Max bytes read per log file per run" help="Lower this on busy servers to bound each hourly run; unread bytes are picked up next run"><NumberInput value={draft.maxLogBytes} onChange={set('maxLogBytes')} min={65536} max={33554432} nullable={false} /></Field>
            <Field label="Extra log directories" help="Comma-separated absolute paths holding <user>/<domain>-access.log trees (for example an NGINX log root); must be inside the agent's allowed paths">
              <TextInput value={(draft.extraLogDirs || []).join(', ')} onChange={(v) => set('extraLogDirs')(v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="/var/log/nginx/domlogs" />
            </Field>
          </div>
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
            <Button disabled={!dirty || saving} onClick={() => setDraft(base)}>Reset</Button>
          </FormActions>
        </>
      )}
    </Card>
  );
}
