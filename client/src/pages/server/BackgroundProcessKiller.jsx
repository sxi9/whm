import { useEffect, useState } from 'react';
import { ShieldAlert, Play, Eye, Trash2, Plus } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, CapabilityNotice, formatDate, formatDuration } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

const RESULT_LABEL = { killed: 'Killed', failed: 'Failed', gone: 'Already exited', 'would-kill': 'Dry run' };
const RESULT_STATUS = { killed: 'ok', failed: 'failed', gone: 'unknown', 'would-kill': 'pending' };

export function BackgroundProcessKiller() {
  const toast = useToast();
  const confirm = useConfirm();
  const overview = useApi('/system-health/bpk');
  const [matches, setMatches] = useState(null);
  const [matchesError, setMatchesError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [logVersion, setLogVersion] = useState(0);
  const data = overview.data;
  const procps = data?.capability?.procps !== false;

  const refreshAll = () => { overview.refetch(); setLogVersion((v) => v + 1); };

  const preview = async () => {
    setMatchesError(null);
    try { const res = await api.get('/system-health/bpk/matches'); setMatches(res.data); } catch (err) { setMatchesError(err); setMatches(null); }
  };

  const scan = async (dryRun) => {
    if (!dryRun && !(await confirm({ title: 'Run the Background Process Killer now?', message: `Every matching process owned by a non-root user is sent ${data?.config?.signal || 'SIGKILL'} immediately.`, confirmLabel: 'Kill matches', danger: true }))) return;
    setScanning(true);
    try {
      const res = await api.post('/system-health/bpk/scan', { dryRun });
      const { run } = res.data;
      const summary = `${run.scanned} process(es) scanned, ${run.matched} match(es)${dryRun ? '' : `, ${run.killed} killed${run.failed ? `, ${run.failed} failed` : ''}`}`;
      if (dryRun) toast.info(summary); else if (run.matched) toast.success(summary); else toast.info(summary);
      refreshAll();
      if (matches) preview();
    } catch (err) { toast.error(err); } finally { setScanning(false); }
  };

  const killOne = async (m) => {
    if (!(await confirm({ title: `Kill PID ${m.pid}?`, message: `${m.command} owned by ${m.user} matched "${m.pattern}". It receives ${data?.config?.signal || 'SIGKILL'}.`, confirmLabel: 'Kill', danger: true }))) return;
    try {
      const res = await api.post(`/system-health/bpk/matches/${m.pid}/kill`);
      if (res.data.result === 'killed') toast.success(`PID ${m.pid} killed`); else toast.warning(`PID ${m.pid}: ${res.data.error || RESULT_LABEL[res.data.result]}`);
      refreshAll();
      preview();
    } catch (err) { toast.error(err); }
  };

  if (overview.loading && !data) return <Loading />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.refetch} />;

  const cfg = data.config;
  const run = data.lastRun;
  const armed = data.patterns.filter((p) => p.enabled).length;

  return (
    <>
      {procps && cfg.enabled && armed === 0 && (
        <div className="banner banner-info">
          <ShieldAlert size={18} />
          <div><strong>Nothing is killed yet.</strong><p>The disallowed list ships with every entry unticked. Tick the names you want terminated below; the scheduled scan only acts on enabled entries.</p></div>
        </div>
      )}
      {!procps && <CapabilityNotice error={{ code: 'capability_missing', message: 'The "ps" program (procps) is not installed on this server, so processes cannot be scanned or killed.' }} onRetry={() => api.post('/system/capabilities/refresh').then(refreshAll).catch(toast.error)} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, alignItems: 'start' }}>
        <Card title="Status" actions={<StatusPill status={cfg.enabled ? 'enabled' : 'disabled'}>{cfg.enabled ? 'Enabled' : 'Disabled'}</StatusPill>}>
          <KeyValue items={[
            ['Schedule', data.schedule ? <><code>{data.schedule.cron}</code> {data.schedule.enabled ? '' : <span className="muted">(paused)</span>}</> : 'not registered'],
            ['Next scheduled run', data.schedule?.enabled ? formatDate(data.schedule.nextRunAt) : '—'],
            ['Last run', run ? <>{formatDate(run.finished_at || run.started_at)} <span className="muted">({run.trigger}{run.dry_run ? ', dry run' : ''})</span></> : 'never'],
            ['Last result', run ? (run.error ? <StatusPill status="failed">{run.error}</StatusPill> : `${run.scanned} scanned, ${run.matched} matched, ${run.killed} killed${run.failed ? `, ${run.failed} failed` : ''}`) : '—'],
            ['Enabled names', armed ? `${armed} of ${data.patterns.length}` : <span className="muted">none (nothing is killed)</span>],
            ['Kills in the last 24 h', String(data.stats.last24h)],
            ['Kills logged', `${data.stats.total}${data.stats.failed ? ` (${data.stats.failed} failed)` : ''}`],
            ['Notifications', data.capability.notifications ? (cfg.notify ? 'Sent to the server contact after every kill' : 'Off') : <span className="muted">Contact Manager is not loaded; kills are only logged</span>],
          ]} />
          <FormActions>
            <Button variant="danger" icon={Play} loading={scanning} disabled={!procps} onClick={() => scan(false)}>Scan and kill now</Button>
            <Button icon={Eye} disabled={!procps || scanning} onClick={() => scan(true)}>Dry run</Button>
            <Button icon={ShieldAlert} disabled={!procps} onClick={preview}>Preview matches</Button>
          </FormActions>
        </Card>
        <Settings config={cfg} signals={data.signals} scopes={data.scopes} onSaved={refreshAll} />
      </div>

      {(matches || matchesError) && (
        <Card title="Processes that match right now" subtitle={matches ? `${matches.scanned} process(es) scanned against ${matches.patterns.length} enabled name(s); scope: ${matches.scope === 'accounts' ? 'panel accounts only' : 'every non-root user'}` : undefined} actions={<Button size="sm" onClick={preview}>Refresh</Button>} padded={false}>
          {matchesError && <div className="card-body"><CapabilityNotice error={matchesError} onRetry={preview} />{matchesError.status !== 501 && <ErrorBanner error={matchesError} onRetry={preview} />}</div>}
          {matches && (
            <DataTable dense rows={matches.matches} rowKey={(m) => m.pid} emptyText="No disallowed processes are running."
              columns={[
                { key: 'pid', label: 'PID', width: 80 },
                { key: 'user', label: 'User' },
                { key: 'command', label: 'Command', render: (m) => <><code>{m.command}</code> <small className="muted">{m.args}</small></> },
                { key: 'pattern', label: 'Matched', render: (m) => <code>{m.pattern}</code> },
                { key: 'cpuPercent', label: 'CPU %', align: 'right', render: (m) => m.cpuPercent?.toFixed?.(1) ?? m.cpuPercent },
                { key: 'elapsedSeconds', label: 'Running', render: (m) => formatDuration(m.elapsedSeconds) },
              ]}
              rowActions={(m) => [{ label: 'Kill', primary: true, danger: true, onClick: () => killOne(m) }]}
            />
          )}
        </Card>
      )}

      <Patterns patterns={data.patterns} onChanged={overview.refetch} />
      <KillLog version={logVersion} onCleared={refreshAll} />
      <Runs version={logVersion} />
    </>
  );
}

function Settings({ config, signals, scopes, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(config);
  const [exempt, setExempt] = useState(config.exemptUsers.join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { setDraft(config); setExempt(config.exemptUsers.join(', ')); }, [config]);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const exemptUsers = exempt.split(',').map((s) => s.trim()).filter(Boolean);
  const dirty = JSON.stringify({ ...draft, exemptUsers }) !== JSON.stringify(config);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/system-health/bpk/config', { enabled: draft.enabled, signal: draft.signal, notify: draft.notify, scope: draft.scope, exemptUsers, retentionDays: draft.retentionDays });
      toast.success('Background Process Killer settings saved');
      onSaved?.();
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <Card title="Settings" subtitle="The scheduled scan runs every 10 minutes while enabled; tune the schedule in Configure cPanel Cron Jobs.">
      <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Enable the scheduled scan" description="When off, nothing is killed automatically; manual scans still work." /></Field>
      <Field label="Signal" help="SIGKILL cannot be caught or ignored; SIGTERM lets a process clean up.">
        <Select value={draft.signal} onChange={(v) => set('signal', v)} options={signals} />
      </Field>
      <Field label="Scope">
        <Select value={draft.scope} onChange={(v) => set('scope', v)} options={scopes.map((s) => ({ value: s, label: s === 'accounts' ? 'Only processes owned by panel accounts' : 'Every non-root user' }))} />
      </Field>
      <Field label="Exempt users" help="Comma-separated Linux usernames whose processes are never killed. root is always exempt.">
        <TextInput value={exempt} onChange={setExempt} placeholder="e.g. monitoring, deploy" />
      </Field>
      <Field inline><Toggle checked={draft.notify} onChange={(v) => set('notify', v)} label="Notify the server contact after each run that kills something" /></Field>
      <Field label="Keep the kill log for (days)">
        <NumberInput value={draft.retentionDays} onChange={(v) => set('retentionDays', v ?? 1)} min={1} max={3650} nullable={false} />
      </Field>
      <ErrorBanner error={error} />
      <FormActions>
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => { setDraft(config); setExempt(config.exemptUsers.join(', ')); }}>Reset</Button>
      </FormActions>
    </Card>
  );
}

function Patterns({ patterns, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await api.post('/system-health/bpk/patterns', { name: name.trim(), note: note.trim() || null });
      toast.success(`"${name.trim()}" added to the disallowed list`);
      setName(''); setNote('');
      onChanged();
    } catch (err) { setError(err); } finally { setAdding(false); }
  };
  const toggle = async (p, enabled) => {
    try { await api.patch(`/system-health/bpk/patterns/${p.id}`, { enabled }); onChanged(); } catch (err) { toast.error(err); }
  };
  const remove = async (p) => {
    if (!(await confirm({ title: `Remove "${p.name}"?`, message: 'Processes with this name will no longer be killed.', confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/system-health/bpk/patterns/${p.id}`); toast.success(`"${p.name}" removed`); onChanged(); } catch (err) { toast.error(err); }
  };

  return (
    <Card title="Disallowed processes" subtitle="Only ticked names are killed; the list ships unticked. A process is matched by its name or the basename of its executable (case-insensitive). Built-in entries can be unticked but not removed." padded={false}>
      <DataTable dense rows={patterns} rowKey={(p) => p.id}
        columns={[
          { key: 'enabled', label: 'Kill', width: 90, render: (p) => <Toggle checked={p.enabled} onChange={(v) => toggle(p, v)} /> },
          { key: 'name', label: 'Process name', render: (p) => <code>{p.name}</code> },
          { key: 'note', label: 'Description', render: (p) => p.note || <span className="muted">—</span> },
          { key: 'builtin', label: 'Source', width: 110, render: (p) => <StatusPill status={p.builtin ? 'info' : 'ok'}>{p.builtin ? 'Built-in' : 'Custom'}</StatusPill> },
        ]}
        rowActions={(p) => [!p.builtin && { label: 'Remove', danger: true, primary: true, onClick: () => remove(p) }]}
        toolbar={(
          <form className="inline-form" onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextInput value={name} onChange={setName} placeholder="Process name, e.g. minerd" style={{ width: 200 }} required />
            <TextInput value={note} onChange={setNote} placeholder="Description (optional)" style={{ width: 220 }} />
            <Button type="submit" variant="primary" size="sm" icon={Plus} loading={adding} disabled={!name.trim()}>Add</Button>
          </form>
        )}
      />
      {error && <div className="card-body"><ErrorBanner error={error} /></div>}
    </Card>
  );
}

function KillLog({ version, onCleared }) {
  const toast = useToast();
  const confirm = useConfirm();
  const table = useTableState({ pageSize: 25 });
  const [result, setResult] = useState('');
  const { state } = table;
  const { data, meta, loading, error, refetch } = useApi(`/system-health/bpk/kills${queryString({ page: state.page, pageSize: state.pageSize, q: state.q, sort: state.sort, dir: state.sort ? state.dir : undefined, result: result || undefined })}`);
  useEffect(() => { refetch(true); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = async () => {
    if (!(await confirm({ title: 'Clear the kill log?', message: 'Every logged kill is deleted. The audit log keeps its own record.', confirmLabel: 'Clear', danger: true }))) return;
    try { const res = await api.delete('/system-health/bpk/kills'); toast.success(`${res.data.removed} entries removed`); onCleared(); } catch (err) { toast.error(err); }
  };

  return (
    <Card title="Kill log" padded={false} actions={<Button size="sm" icon={Trash2} onClick={clear} disabled={!meta?.total}>Clear log</Button>}>
      <DataTable dense rows={data || []} loading={loading} error={error} rowKey={(k) => k.id} emptyText="Nothing has been killed yet."
        total={meta?.total ?? 0} page={state.page} pageSize={state.pageSize} onPageChange={table.setPage}
        sort={state.sort} dir={state.dir} onSortChange={table.setSort}
        searchable q={state.q} onSearch={table.setSearch} searchPlaceholder="Search user, command or pattern"
        toolbar={<Select value={result} onChange={(v) => { setResult(v); table.setPage(1); }} options={[{ value: '', label: 'All results' }, ...Object.entries(RESULT_LABEL).map(([value, label]) => ({ value, label }))]} style={{ width: 160 }} />}
        columns={[
          { key: 'killed_at', label: 'When', sortable: true, render: (k) => formatDate(k.killed_at) },
          { key: 'pid', label: 'PID', width: 80, sortable: true },
          { key: 'user', label: 'User', sortable: true },
          { key: 'command', label: 'Command', sortable: true, render: (k) => <><code>{k.command}</code> {k.args && <small className="muted">{k.args}</small>}</> },
          { key: 'pattern', label: 'Matched', sortable: true, render: (k) => <code>{k.pattern}</code> },
          { key: 'signal', label: 'Signal', width: 90 },
          { key: 'result', label: 'Result', sortable: true, render: (k) => <><StatusPill status={RESULT_STATUS[k.result] || 'unknown'}>{RESULT_LABEL[k.result] || k.result}</StatusPill>{k.error && <small className="muted"> {k.error}</small>}</> },
        ]}
      />
    </Card>
  );
}

function Runs({ version }) {
  const { data, loading, error, refetch } = useApi('/system-health/bpk/runs?limit=20');
  useEffect(() => { refetch(true); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title="Recent runs" padded={false}>
      <DataTable dense rows={data || []} loading={loading} error={error} rowKey={(r) => r.id} emptyText="No scans have run yet."
        columns={[
          { key: 'started_at', label: 'Started', render: (r) => formatDate(r.started_at) },
          { key: 'trigger', label: 'Trigger', render: (r) => <>{r.trigger}{r.dry_run ? <span className="muted"> (dry run)</span> : ''}{r.principal ? <span className="muted"> by {r.principal}</span> : ''}</> },
          { key: 'scanned', label: 'Scanned', align: 'right' },
          { key: 'matched', label: 'Matched', align: 'right' },
          { key: 'killed', label: 'Killed', align: 'right' },
          { key: 'failed', label: 'Failed', align: 'right' },
          { key: 'notified', label: 'Notified', render: (r) => (r.notified ? 'yes' : '—') },
          { key: 'error', label: 'Error', render: (r) => (r.error ? <StatusPill status="failed">{r.error}</StatusPill> : <span className="muted">—</span>) },
        ]}
      />
    </Card>
  );
}
