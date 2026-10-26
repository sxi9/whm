import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, Toggle, NumberInput, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, Stat } from '../../development/Shared.jsx';

const SAMPLE_SCRIPT = `#!/bin/sh
# WHM hook: receives the event envelope as JSON on stdin; argv is "<event> <stage>".
# Exit 0 to allow. For a blocking "pre" hook any other exit status rejects the
# operation and the last line of stderr is shown to the operator.
EVENT="$1"; STAGE="$2"
PAYLOAD="$(cat)"
logger -t whm-hook "$EVENT ($STAGE): $PAYLOAD"
exit 0
`;

const EMPTY_HOOK = { name: '', description: '', event: 'account.created', stage: 'post', script: '', blocking: true, timeoutSec: 30, enabled: true };

export default function ManageHooks({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('hooks');
  const hooks = useApi('/development/hooks');
  const events = useApi('/development/hooks/events');
  const scripts = useApi('/development/hooks/scripts');
  const settings = useApi('/development/hooks/settings');
  const [runFilter, setRunFilter] = useState({ status: '', event: '' });
  const runs = useApi(`/development/hooks/runs${queryString({ pageSize: 50, ...runFilter })}`, { enabled: tab === 'runs' });
  const [editor, setEditor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [scriptEditor, setScriptEditor] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [emit, setEmit] = useState({ event: 'account.created', stage: 'post', payload: '{\n  "username": "demo",\n  "domain": "demo.example.com"\n}' });
  const [emitResult, setEmitResult] = useState(null);
  const [runOpen, setRunOpen] = useState(null);

  const eventMap = useMemo(() => Object.fromEntries((events.data || []).map((e) => [e.name, e])), [events.data]);
  const stagesFor = (name) => eventMap[name]?.stages || ['pre', 'post'];
  const scriptOptions = (scripts.data?.scripts || []).map((s) => ({ value: s.name, label: `${s.name}${s.runnable ? '' : ' (not runnable)'}`, disabled: !s.runnable }));

  const openEditor = (h) => setEditor(h ? { id: h.id, name: h.name, description: h.description || '', event: h.event, stage: h.stage, script: h.script, blocking: h.blocking, timeoutSec: h.timeoutSec, enabled: h.enabled } : { ...EMPTY_HOOK, timeoutSec: settings.data?.defaultTimeoutSec ?? 30, script: scriptOptions.find((o) => !o.disabled)?.value || '' });
  const saveHook = async () => {
    setSaving(true); setSaveError(null);
    try {
      const body = { name: editor.name.trim() || undefined, description: editor.description.trim() || null, event: editor.event, stage: editor.stage, script: editor.script, blocking: editor.blocking, timeoutSec: editor.timeoutSec, enabled: editor.enabled };
      if (editor.id) await api.put(`/development/hooks/${editor.id}`, body); else await api.post('/development/hooks', body);
      toast.success(editor.id ? 'Hook updated' : 'Hook added'); setEditor(null); hooks.refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };
  const toggle = async (h) => { try { await api.patch(`/development/hooks/${h.id}`, { enabled: !h.enabled }); hooks.refetch(); } catch (err) { toast.error(err); } };
  const remove = async (h) => {
    if (!(await confirm({ title: `Delete hook "${h.name}"?`, message: 'The script stays on disk; only the binding to the event is removed.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/development/hooks/${h.id}`); toast.success('Hook deleted'); hooks.refetch(); } catch (err) { toast.error(err); }
  };
  const test = async (h) => {
    setTestResult({ hook: h, loading: true });
    try { const { data } = await api.post(`/development/hooks/${h.id}/test`, {}); setTestResult({ hook: h, data }); hooks.refetch(); } catch (err) { setTestResult({ hook: h, error: err }); }
  };
  const saveScript = async () => {
    setSaving(true); setSaveError(null);
    try { await api.put(`/development/hooks/scripts/${scriptEditor.name.trim()}`, { content: scriptEditor.content }); toast.success(`Script ${scriptEditor.name} saved (root, mode 0700)`); setScriptEditor(null); scripts.refetch(); } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };
  const editScript = async (s) => {
    try { const { data } = await api.get(`/development/hooks/scripts/${s.name}`); setScriptEditor({ name: s.name, content: data.content, existing: true, hooks: data.hooks }); } catch (err) { toast.error(err); }
  };
  const removeScript = async (s) => {
    if (!(await confirm({ title: `Delete script ${s.name}?`, message: s.hooks ? `${s.hooks} hook(s) reference this script and will start recording errors.` : 'The file is removed from /usr/local/whm/hooks.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/development/hooks/scripts/${s.name}`); toast.success('Script deleted'); scripts.refetch(); } catch (err) { toast.error(err); }
  };
  const initDir = async () => { try { await api.post('/development/hooks/scripts/init'); toast.success('Created /usr/local/whm/hooks'); scripts.refetch(); } catch (err) { toast.error(err); } };
  const doEmit = async () => {
    let payload;
    try { payload = emit.payload.trim() ? JSON.parse(emit.payload) : {}; } catch { return toast.error('Payload must be valid JSON'); }
    if (!(await confirm({ title: `Emit ${emit.event} (${emit.stage})?`, message: 'Every enabled hook bound to this event runs for real with the payload below.', confirmLabel: 'Emit' }))) return;
    try { const { data } = await api.post('/development/hooks/emit', { event: emit.event, stage: emit.stage, payload }); setEmitResult(data); hooks.refetch(); toast.success(`Dispatched to ${data.listeners} listener(s)`); } catch (err) { toast.error(err); }
  };
  const saveSettings = async (patch) => { try { await api.put('/development/hooks/settings', patch); settings.refetch(); toast.success('Hook settings saved'); } catch (err) { toast.error(err); } };

  const counts = { hooks: hooks.data?.length, scripts: scripts.data?.scripts?.length, runs: runs.meta?.total };

  return (
    <>
      <PageHeader fn={fn} actions={<><Button variant="primary" icon={Plus} onClick={() => openEditor(null)}>Add hook</Button>{settings.data && <StatusPill status={settings.data.enabled ? 'enabled' : 'disabled'}>{settings.data.enabled ? 'hooks enabled' : 'hooks paused'}</StatusPill>}</>} />
      <RequestError error={hooks.error} onRetry={hooks.refetch} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'hooks', label: 'Hooks', count: counts.hooks }, { value: 'scripts', label: 'Scripts', count: counts.scripts }, { value: 'runs', label: 'Run log', count: counts.runs }, { value: 'events', label: 'Event catalog', count: events.data?.length }, { value: 'settings', label: 'Settings' }]} />

      {tab === 'hooks' && (
        <>
          <Card padded={false} title="Registered hooks" subtitle="Each hook binds an event + stage to an executable under /usr/local/whm/hooks. The JSON envelope arrives on stdin; a blocking pre hook that exits non-zero rejects the operation.">
            {hooks.loading && !hooks.data && <Loading />}
            {hooks.data && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Hook</th><th>Event</th><th>Stage</th><th>Script</th><th>Behaviour</th><th>Last run</th><th>Runs</th><th /></tr></thead>
                  <tbody>
                    {hooks.data.length === 0 && <tr><td colSpan={8} className="table-state">No hooks yet. Add one to notify billing on account creation, gate suspensions, or alert on failed logins.</td></tr>}
                    {hooks.data.map((h) => (
                      <tr key={h.id}>
                        <td><strong>{h.name}</strong>{h.description && <div className="small muted">{h.description}</div>}</td>
                        <td><code>{h.event}</code>{!h.known && <div className="small muted">custom event</div>}</td>
                        <td><StatusPill status={h.stage === 'pre' ? 'warning' : 'info'}>{h.stage}</StatusPill></td>
                        <td><code>{h.script}</code></td>
                        <td className="small">{h.stage === 'pre' ? (h.blocking ? 'blocking' : 'advisory') : 'notify'} · {h.timeoutSec}s timeout</td>
                        <td>{h.lastRunAt ? <><StatusPill status={h.lastStatus === 'ok' ? 'ok' : h.lastStatus === 'failed' ? 'warning' : 'failed'}>{h.lastStatus}</StatusPill> <span className="small muted">{formatDate(h.lastRunAt)}</span></> : <span className="muted">never</span>}</td>
                        <td>{h.runCount}{h.failCount ? <span className="small muted"> ({h.failCount} failed)</span> : null}</td>
                        <td className="actions-col">
                          <div className="row-actions">
                            <Button size="sm" onClick={() => test(h)}>Test</Button>
                            <Button size="sm" onClick={() => openEditor(h)}>Edit</Button>
                            <Button size="sm" variant={h.enabled ? 'default' : 'primary'} onClick={() => toggle(h)}>{h.enabled ? 'Disable' : 'Enable'}</Button>
                            <Button size="sm" variant="danger-ghost" onClick={() => remove(h)}>Delete</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Emit an event" subtitle="Dispatch any catalog event through the panel event bus to exercise the hooks bound to it.">
            <div className="form-grid">
              <Field label="Event"><Select value={emit.event} onChange={(v) => setEmit({ ...emit, event: v, stage: stagesFor(v).includes(emit.stage) ? emit.stage : stagesFor(v)[0] })} options={(events.data || []).map((e) => e.name)} /></Field>
              <Field label="Stage"><Select value={emit.stage} onChange={(v) => setEmit({ ...emit, stage: v })} options={stagesFor(emit.event)} /></Field>
            </div>
            <Field label="Payload (JSON)" help={eventMap[emit.event]?.payload ? `Shape: ${eventMap[emit.event].payload}` : undefined}><Textarea mono rows={5} value={emit.payload} onChange={(v) => setEmit({ ...emit, payload: v })} /></Field>
            <div className="action-row"><Button variant="primary" onClick={doEmit}>Emit</Button></div>
            {emitResult && <pre className="log">{JSON.stringify(emitResult, null, 2)}</pre>}
          </Card>
        </>
      )}

      {tab === 'scripts' && (
        <Card padded={false} title="Hook scripts" subtitle={`Executables in ${scripts.data?.dir || '/usr/local/whm/hooks'}. A script runs only when it is a regular file owned by root, executable, and not writable by group or others.`}
          actions={<><Button size="sm" onClick={() => scripts.refetch()}>Refresh</Button><Button size="sm" variant="primary" onClick={() => setScriptEditor({ name: '', content: SAMPLE_SCRIPT, existing: false })}>New script</Button></>}>
          <div style={{ padding: scripts.error ? 14 : 0 }}><RequestError error={scripts.error} onRetry={scripts.refetch} /></div>
          {scripts.data && !scripts.data.exists && (
            <div style={{ padding: 14 }}>
              <div className="banner banner-info"><div><strong>The hooks directory does not exist yet.</strong><p>Create <code>{scripts.data.dir}</code> (root, 0755) and add your first script.</p></div><Button size="sm" variant="primary" onClick={initDir}>Create directory</Button></div>
            </div>
          )}
          {scripts.data?.exists && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Script</th><th>Mode</th><th>Owner</th><th>Size</th><th>Modified</th><th>Used by</th><th>State</th><th /></tr></thead>
                <tbody>
                  {scripts.data.scripts.length === 0 && <tr><td colSpan={8} className="table-state">No scripts yet.</td></tr>}
                  {scripts.data.scripts.map((s) => (
                    <tr key={s.name}>
                      <td><code>{s.name}</code></td><td><code>{s.mode}</code></td><td>{s.uid === 0 ? 'root' : `uid ${s.uid}`}</td><td>{s.size} B</td><td>{formatDate(s.mtime)}</td><td>{s.hooks} hook(s)</td>
                      <td>{s.runnable ? <StatusPill status="ok">runnable</StatusPill> : <StatusPill status="failed" >refused</StatusPill>}{!s.runnable && <div className="small muted">{s.problems.join('; ')}</div>}</td>
                      <td className="actions-col"><div className="row-actions"><Button size="sm" onClick={() => editScript(s)}>Edit</Button><Button size="sm" variant="danger-ghost" onClick={() => removeScript(s)}>Delete</Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'runs' && (
        <Card padded={false} title="Run log" subtitle="Every hook execution with its exit status and output. Pre-stage failures that vetoed an operation show as failed."
          actions={<><select className="input select" value={runFilter.status} onChange={(e) => setRunFilter({ ...runFilter, status: e.target.value })}><option value="">All statuses</option>{['ok', 'failed', 'error'].map((s) => <option key={s}>{s}</option>)}</select>
            <select className="input select" value={runFilter.event} onChange={(e) => setRunFilter({ ...runFilter, event: e.target.value })}><option value="">All events</option>{(events.data || []).map((e) => <option key={e.name}>{e.name}</option>)}</select>
            <Button size="sm" onClick={() => runs.refetch()}>Refresh</Button></>}>
          <RequestError error={runs.error} onRetry={runs.refetch} />
          {runs.loading && !runs.data && <Loading />}
          {runs.data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Hook</th><th>Event</th><th>Trigger</th><th>Status</th><th>Exit</th><th>Duration</th><th /></tr></thead>
                <tbody>
                  {runs.data.length === 0 && <tr><td colSpan={8} className="table-state">No runs recorded.</td></tr>}
                  {runs.data.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDate(r.createdAt)}</td><td>{r.hookName}</td><td><code>{r.event}</code> <span className="small muted">{r.stage}</span></td><td>{r.trigger}</td>
                      <td><StatusPill status={r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'warning' : 'failed'}>{r.status}</StatusPill></td><td>{r.exitCode ?? '—'}</td><td>{r.durationMs != null ? `${r.durationMs} ms` : '—'}</td>
                      <td className="actions-col"><Button size="sm" onClick={() => setRunOpen(r)}>Output</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'events' && (
        <Card padded={false} title="Event catalog" subtitle="Events the panel emits, taken from the plugin SDK so plugins and hooks share one vocabulary. Cancellable events accept a blocking pre hook.">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Event</th><th>Stages</th><th>Cancellable</th><th>Payload</th><th>Hooks</th></tr></thead>
              <tbody>
                {(events.data || []).map((e) => (
                  <tr key={e.name}><td><code>{e.name}</code></td><td>{e.stages.join(', ')}</td><td>{e.cancellable ? <StatusPill status="ok">yes</StatusPill> : <span className="muted">no</span>}</td><td className="small"><code>{e.payload}</code></td><td>{(hooks.data || []).filter((h) => h.event === e.name).length}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'settings' && settings.data && (
        <Card title="Hook settings">
          <Toggle checked={settings.data.enabled} onChange={(v) => saveSettings({ enabled: v })} label="Run hooks" description="Pause every hook without deleting it. Pre hooks stop gating operations while paused." />
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Default timeout (seconds)" help="Applied to new hooks"><NumberInput value={settings.data.defaultTimeoutSec} nullable={false} onChange={(v) => settings.setData({ ...settings.data, defaultTimeoutSec: v })} onBlur={() => saveSettings({ defaultTimeoutSec: settings.data.defaultTimeoutSec })} min={1} max={600} /></Field>
            <Field label="Keep run log entries"><NumberInput value={settings.data.keepRuns} nullable={false} onChange={(v) => settings.setData({ ...settings.data, keepRuns: v })} onBlur={() => saveSettings({ keepRuns: settings.data.keepRuns })} min={10} max={100000} /></Field>
          </div>
          <KeyValue items={[['Scripts directory', <code key="d">{settings.data.dir}</code>], ['Execution', 'root, cwd = hooks directory, argv = <event> <stage>, envelope JSON on stdin, WHM_HOOK_EVENT / WHM_HOOK_STAGE / WHM_HOOK_NAME in the environment']]} />
        </Card>
      )}

      <Modal open={Boolean(editor)} title={editor?.id ? `Edit hook: ${editor.name}` : 'Add hook'} onClose={() => setEditor(null)} size="lg"
        footer={<><Button onClick={() => setEditor(null)}>Cancel</Button><Button variant="primary" loading={saving} disabled={!editor?.script} onClick={saveHook}>{editor?.id ? 'Save' : 'Add hook'}</Button></>}>
        {editor && (
          <>
            <div className="form-grid">
              <Field label="Event" required><Select value={editor.event} onChange={(v) => setEditor({ ...editor, event: v, stage: stagesFor(v).includes(editor.stage) ? editor.stage : stagesFor(v)[0] })} options={(events.data || []).map((e) => e.name)} /></Field>
              <Field label="Stage" help={eventMap[editor.event]?.cancellable ? 'pre runs before the operation and may reject it' : 'This event only notifies after the fact'}><Select value={editor.stage} onChange={(v) => setEditor({ ...editor, stage: v })} options={stagesFor(editor.event)} /></Field>
              <Field label="Script" required help="An executable from the Scripts tab"><Select value={editor.script} onChange={(v) => setEditor({ ...editor, script: v })} options={scriptOptions} placeholder={scriptOptions.length ? 'Choose a script' : 'No runnable scripts yet'} /></Field>
              <Field label="Timeout (seconds)"><NumberInput value={editor.timeoutSec} nullable={false} onChange={(v) => setEditor({ ...editor, timeoutSec: v })} min={1} max={600} /></Field>
              <Field label="Name"><TextInput value={editor.name} onChange={(v) => setEditor({ ...editor, name: v })} placeholder={editor.script || 'Defaults to the script name'} /></Field>
              <Field label="Description"><TextInput value={editor.description} onChange={(v) => setEditor({ ...editor, description: v })} /></Field>
            </div>
            {editor.stage === 'pre' && <Toggle checked={editor.blocking} onChange={(v) => setEditor({ ...editor, blocking: v })} label="Blocking" description="A non-zero exit rejects the operation with the script's last stderr line. Scripts that cannot run (missing, wrong owner) never block." />}
            <Toggle checked={editor.enabled} onChange={(v) => setEditor({ ...editor, enabled: v })} label="Enabled" />
            {eventMap[editor.event] && <p className="small muted">Payload: <code>{eventMap[editor.event].payload}</code></p>}
            <ErrorBanner error={saveError} />
          </>
        )}
      </Modal>

      <Modal open={Boolean(scriptEditor)} title={scriptEditor?.existing ? `Edit ${scriptEditor.name}` : 'New hook script'} onClose={() => setScriptEditor(null)} size="lg"
        footer={<><Button onClick={() => setScriptEditor(null)}>Cancel</Button><Button variant="primary" loading={saving} disabled={!scriptEditor?.name.trim() || !scriptEditor?.content.startsWith('#!')} onClick={saveScript}>Save as root (0700)</Button></>}>
        {scriptEditor && (
          <>
            <Field label="File name" required help="Lowercase letters, digits, '.', '_' or '-'"><TextInput value={scriptEditor.name} onChange={(v) => setScriptEditor({ ...scriptEditor, name: v })} disabled={scriptEditor.existing} placeholder="notify-billing" /></Field>
            <Field label="Script" required help="Must start with a #! line. Runs as root; keep it small and validate the payload."><Textarea mono rows={16} value={scriptEditor.content} onChange={(v) => setScriptEditor({ ...scriptEditor, content: v })} /></Field>
            {scriptEditor.hooks ? <p className="small muted">Used by {scriptEditor.hooks} hook(s). A backup copy (<code>.whm-bak</code>) is kept.</p> : null}
            <ErrorBanner error={saveError} />
          </>
        )}
      </Modal>

      <Modal open={Boolean(testResult)} title={testResult ? `Test: ${testResult.hook.name}` : ''} onClose={() => setTestResult(null)} size="lg">
        {testResult?.loading && <Loading text="Running the script…" />}
        {testResult?.error && <RequestError error={testResult.error} />}
        {testResult?.data && (
          <>
            <div className="stat-grid"><Stat label="Status" value={<StatusPill status={testResult.data.status === 'ok' ? 'ok' : 'failed'}>{testResult.data.status}</StatusPill>} /><Stat label="Exit code" value={testResult.data.exitCode ?? '—'} /><Stat label="Duration" value={`${testResult.data.durationMs ?? 0} ms`} /></div>
            <h3 style={{ margin: '12px 0 6px' }}>stdout</h3><pre className="log">{testResult.data.stdout || '(empty)'}</pre>
            <h3 style={{ margin: '12px 0 6px' }}>stderr</h3><pre className="log">{testResult.data.stderr || '(empty)'}</pre>
          </>
        )}
      </Modal>

      <Modal open={Boolean(runOpen)} title={runOpen ? `Run #${runOpen.id} · ${runOpen.hookName}` : ''} onClose={() => setRunOpen(null)} size="lg">
        {runOpen && (
          <>
            <KeyValue items={[['Event', `${runOpen.event} (${runOpen.stage})`], ['Trigger', runOpen.trigger], ['Status', runOpen.status], ['Exit code', runOpen.exitCode ?? '—'], ['Duration', runOpen.durationMs != null ? `${runOpen.durationMs} ms` : '—'], ['When', formatDate(runOpen.createdAt)]]} />
            <h3 style={{ margin: '12px 0 6px' }}>stdout</h3><pre className="log">{runOpen.stdout || '(empty)'}</pre>
            <h3 style={{ margin: '12px 0 6px' }}>stderr</h3><pre className="log">{runOpen.stderr || '(empty)'}</pre>
          </>
        )}
      </Modal>
    </>
  );
}
