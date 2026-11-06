import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import { Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Textarea, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';

// Application Manager (contract §65): one card to create an app, a table of
// the account's apps with their service state, and a sheet per app for edit,
// logs and dependency installs. The account follows its own install jobs
// through the scoped stream (/api/system/jobs is reseller-only).
export const jobStreamPath = (id) => `/panel/apps/jobs/${id}/stream`;
export const APP_TYPES = ['node', 'python'];
export const NAME_RE = /^[a-z0-9-]{2,32}$/;
export const REL_RE = /^(?!-)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._][A-Za-z0-9._\/-]{0,255}$/;
export const MOUNT_RE = /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/;
export const ENV_LINE_RE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

// The status pill tone per stored/live status.
export function statusTone(status) {
  return { running: 'ok', stopped: 'unknown', failed: 'error', pending: 'warn' }[status] || 'unknown';
}

// KEY=value lines of the textarea → object; the first problem is reported.
export function parseEnv(text, t = untranslated) {
  const env = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(ENV_LINE_RE);
    if (!m) return { error: fill(t('panel.apps.env_line_invalid', 'Line "{line}" is not KEY=value (upper-case key)'), { line: line.slice(0, 40) }) };
    if (['PORT', 'HOME', 'USER', 'LOGNAME', 'PATH'].includes(m[1])) return { error: fill(t('panel.apps.env_reserved', '{key} is set by the panel'), { key: m[1] }) };
    if (m[2].length > 1024) return { error: fill(t('panel.apps.env_too_long', '{key} is longer than 1024 characters'), { key: m[1] }) };
    env[m[1]] = m[2];
  }
  if (Object.keys(env).length > 64) return { error: t('panel.apps.env_too_many', 'At most 64 variables') };
  return { env };
}

export const envText = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');

export function formProblems(form, t = untranslated) {
  const p = {};
  if (!NAME_RE.test(form.name || '')) p.name = t('panel.apps.name_rule', '2 to 32 lowercase letters, digits or "-"');
  const dir = String(form.dir || '').trim().replace(/^\/+|\/+$/g, '');
  if (!dir || !REL_RE.test(dir)) p.dir = t('panel.apps.dir_rule', 'A folder of your home directory, such as apps/my-app');
  const entry = String(form.entry || '').trim().replace(/^\/+|\/+$/g, '');
  if (!entry || !REL_RE.test(entry)) p.entry = t('panel.apps.entry_rule', 'The file that starts the app, such as server.js or app.py');
  const mount = `/${String(form.mount || '/').trim().replace(/^\/+|\/+$/g, '')}`;
  if (!MOUNT_RE.test(mount) || mount.split('/').some((s) => s === '.' || s === '..')) p.mount = t('panel.apps.mount_rule', 'A site path such as / or /app');
  const env = parseEnv(form.envText, t);
  if (env.error) p.env = env.error;
  return p;
}

export function runtimeOptions(runtimes, type, t = untranslated) {
  const list = (type === 'node' ? runtimes?.node : runtimes?.python) || [];
  if (!list.length) return [{ value: 'system', label: t('panel.apps.runtime_system_only', 'System default') }];
  return list.map((r) => ({ value: r.id, label: r.label }));
}

const emptyForm = (me) => ({ name: '', type: 'node', dir: '', entry: '', runtime: 'system', domain: me?.account?.domain || '', mount: '/', websocket: true, envText: '' });

export default function Apps({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/apps');
  const { data: runtimes } = usePanelApi('/apps/runtimes');
  const [form, setForm] = useState(() => emptyForm(me));
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [logs, setLogs] = useState(null);
  const [job, setJob] = useState(null);
  const capability = isCapabilityError(error);
  const problems = formProblems(form, t);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const sites = meta?.sites || (me?.account?.domains || []).filter((d) => ['main', 'addon', 'sub'].includes(d.type)).map((d) => ({ domain: d.domain, type: d.type }));
  const domainOptions = useMemo(() => {
    const list = sites.map((s) => ({ value: s.domain, label: s.domain }));
    if (me?.account?.domain && !list.some((o) => o.value === me.account.domain)) list.unshift({ value: me.account.domain, label: me.account.domain });
    return list;
  }, [sites, me]);
  const runtimeOpts = runtimeOptions(runtimes, form.type, t);
  useEffect(() => { if (!runtimeOpts.some((o) => o.value === form.runtime)) setForm((f) => ({ ...f, runtime: runtimeOpts[0]?.value || 'system' })); }, [runtimeOpts, form.runtime]);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const create = async (e) => {
    e.preventDefault();
    if (Object.keys(problems).length) { setFormError({ message: t('panel.apps.check_form', 'Check the form'), fields: Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, [v]])) }); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim(), type: form.type, dir: form.dir.trim().replace(/^\/+|\/+$/g, ''), entry: form.entry.trim().replace(/^\/+|\/+$/g, ''), runtime: form.runtime, domain: form.domain || me?.account?.domain, mount: `/${form.mount.trim().replace(/^\/+|\/+$/g, '')}`, websocket: form.websocket, env: parseEnv(form.envText).env || {} };
      const { data: res } = await panelApi.post('/apps', body);
      toast.success(res.started ? fill(t('panel.apps.created_running', '{name} is running at {url}'), { name: res.name, url: res.url }) : fill(t('panel.apps.created_not_started', '{name} was created but did not start: {error}'), { name: res.name, error: res.startError || res.error || '' }));
      setForm(emptyForm(me));
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const control = async (row, action) => {
    try {
      const { data: res } = await panelApi.post(`/apps/${encodeURIComponent(row.id)}/${action}`, {});
      toast.success(fill(t(`panel.apps.${action}_done`, { start: '{name} started', stop: '{name} stopped', restart: '{name} restarted' }[action]), { name: row.name }) + (res.status === 'failed' ? ` ${t('panel.apps.but_failed', '(the service reports a failure; check the logs)')}` : ''));
      refetch();
    } catch (err) { toast.error(err); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.apps.remove_title', 'Remove {name}?'), { name: row.name }), message: fill(t('panel.apps.remove_message', 'The service is stopped and removed and {domain}{mount} no longer forwards to it. The files in {dir} stay.'), { domain: row.domain, mount: row.mount === '/' ? '' : row.mount, dir: row.dir }), confirmLabel: t('panel.apps.remove', 'Remove'), danger: true });
    if (!ok) return;
    try {
      await panelApi.delete(`/apps/${encodeURIComponent(row.id)}?confirm=true`);
      toast.success(fill(t('panel.apps.removed', '{name} removed'), { name: row.name }));
      refetch();
    } catch (err) { toast.error(err); }
  };

  const openLogs = async (row, lines = 200) => {
    setLogs({ row, lines, text: null, error: null });
    try {
      const { data: res } = await panelApi.get(`/apps/${encodeURIComponent(row.id)}/logs?lines=${lines}`);
      setLogs((l) => (l && l.row.id === row.id ? { ...l, text: res.lines.join('\n') } : l));
    } catch (err) { setLogs((l) => (l ? { ...l, error: err } : l)); }
  };

  const installDeps = async (row) => {
    try {
      const { data: res } = await panelApi.post(`/apps/${encodeURIComponent(row.id)}/deps`, {});
      setJob({ id: res.job.id, name: row.name, type: row.type });
    } catch (err) { toast.error(err); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') toast.success(fill(t('panel.apps.deps_done', 'Dependencies of {name} installed; restart the app to use them'), { name: job?.name || '' }));
    else if (event.type === 'failed') toast.error(event.error || t('panel.apps.job_failed', 'The install failed'));
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    const ed = editing;
    const env = parseEnv(ed.envText, t);
    if (env.error) { setEditing((x) => ({ ...x, error: { message: env.error, fields: { env: [env.error] } } })); return; }
    setBusy(true);
    try {
      const body = { dir: ed.dir.trim().replace(/^\/+|\/+$/g, ''), entry: ed.entry.trim().replace(/^\/+|\/+$/g, ''), runtime: ed.runtime, domain: ed.domain, mount: `/${ed.mount.trim().replace(/^\/+|\/+$/g, '')}`, websocket: ed.websocket, env: env.env };
      await panelApi.put(`/apps/${encodeURIComponent(ed.row.id)}`, body);
      toast.success(fill(t('panel.apps.saved', '{name} saved and restarted'), { name: ed.row.name }));
      setEditing(null);
      refetch();
    } catch (err) { setEditing((x) => (x ? { ...x, error: err } : x)); } finally { setBusy(false); }
  };

  const createDisabled = busy || Object.keys(problems).length > 0 || !form.domain || (meta && meta.apache === false);
  const typeOptions = [{ value: 'node', label: t('panel.apps.type_node', 'Node.js') }, { value: 'python', label: t('panel.apps.type_python', 'Python') }];
  const sizeText = (b) => (b == null ? '' : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      {capability && <PanelCapabilityState card error={error} onRetry={refetch} />}

      <form onSubmit={create}>
        <Card title={t('panel.apps.create_title', 'Add an application')} subtitle={t('panel.apps.create_subtitle', 'Upload your program to a folder of your home directory first; the panel starts it as a service on its own port and forwards a path of your domain to it.')}>
          <RequestError error={formError} />
          {meta && meta.apache === false && <InfoNote>{t('panel.apps.no_apache', 'Applications cannot be published on this server yet; ask your hosting provider.')}</InfoNote>}
          <div className="form-grid">
            <Field label={t('panel.apps.name', 'Name')} required htmlFor="app-name" help={t('panel.apps.name_help', 'Lowercase letters, digits and "-"; names the service')} error={formError?.fields?.name || (form.name && problems.name ? [problems.name] : undefined)}>
              <TextInput id="app-name" value={form.name} onChange={set('name')} placeholder="my-app" maxLength={32} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.apps.type', 'Type')} required htmlFor="app-type">
              <Select id="app-type" value={form.type} onChange={set('type')} options={typeOptions} />
            </Field>
            <Field label={t('panel.apps.dir', 'Folder')} required htmlFor="app-dir" help={t('panel.apps.dir_help', 'Relative to your home directory, for example apps/my-app')} error={formError?.fields?.dir || (form.dir && problems.dir ? [problems.dir] : undefined)}>
              <TextInput id="app-dir" value={form.dir} onChange={set('dir')} placeholder="apps/my-app" maxLength={256} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.apps.entry', 'Start file')} required htmlFor="app-entry" help={t('panel.apps.entry_help', 'Inside the folder; it must listen on the PORT environment variable')} error={formError?.fields?.entry || (form.entry && problems.entry ? [problems.entry] : undefined)}>
              <TextInput id="app-entry" value={form.entry} onChange={set('entry')} placeholder={form.type === 'node' ? 'server.js' : 'app.py'} maxLength={256} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.apps.runtime', 'Runtime')} required htmlFor="app-runtime" error={formError?.fields?.runtime}>
              <Select id="app-runtime" value={form.runtime} onChange={set('runtime')} options={runtimeOpts} />
            </Field>
            <Field label={t('panel.apps.domain', 'Domain')} required htmlFor="app-domain" error={formError?.fields?.domain}>
              <Select id="app-domain" value={form.domain} onChange={set('domain')} options={domainOptions} />
            </Field>
            <Field label={t('panel.apps.mount', 'Path')} required htmlFor="app-mount" help={t('panel.apps.mount_help', '"/" for the whole site, or a path such as /app')} error={formError?.fields?.mount || (problems.mount ? [problems.mount] : undefined)}>
              <TextInput id="app-mount" value={form.mount} onChange={set('mount')} placeholder="/" maxLength={200} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={t('panel.apps.websocket', 'WebSockets')} htmlFor="app-websocket">
              <Toggle checked={form.websocket} onChange={set('websocket')} label={t('panel.apps.websocket_label', 'Forward WebSocket connections too')} />
            </Field>
            <Field label={t('panel.apps.env', 'Environment variables')} htmlFor="app-env" help={t('panel.apps.env_help', 'One KEY=value per line; PORT is set for you')} error={formError?.fields?.env || (problems.env ? [problems.env] : undefined)}>
              <Textarea id="app-env" value={form.envText} onChange={set('envText')} rows={4} mono placeholder={'NODE_OPTIONS=--max-old-space-size=256\nAPP_SECRET=…'} />
            </Field>
          </div>
          <FormActions>
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={createDisabled}>{t('panel.apps.create', 'Add application')}</Button>
            {meta?.portRange && <span className="muted small">{fill(t('panel.apps.port_note', 'Ports are assigned from {min}–{max}; your app reads its port from PORT.'), { min: meta.portRange.min, max: meta.portRange.max })}</span>}
          </FormActions>
        </Card>
      </form>

      <Card title={t('panel.apps.list_title', 'Your applications')} subtitle={data?.length ? fill(t('panel.apps.list_count', '{count} application(s)'), { count: data.length }) : undefined} padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: t('panel.apps.col_name', 'Application'), render: (r) => <><strong>{r.name}</strong><div className="muted small"><code>{r.dir}/{r.entry}</code></div></> },
            { key: 'runtime', label: t('panel.apps.col_runtime', 'Runtime'), render: (r) => <code>{r.type === 'node' ? 'node' : 'python'} {r.runtime}</code> },
            { key: 'url', label: t('panel.apps.col_url', 'Address'), render: (r) => <><a href={r.url} target="_blank" rel="noreferrer">{r.domain}{r.mount === '/' ? '' : r.mount}</a><div className="muted small">{fill(t('panel.apps.port_label', 'port {port}'), { port: r.port })}</div></> },
            { key: 'status', label: t('panel.apps.col_status', 'Status'), render: (r) => <><StatusPill status={statusTone(r.status)}>{t(`panel.apps.status_${r.status}`, r.status)}</StatusPill>{r.service?.pid ? <div className="muted small">{fill(t('panel.apps.pid_mem', 'PID {pid}{mem}'), { pid: r.service.pid, mem: r.service.memoryBytes != null ? `, ${sizeText(r.service.memoryBytes)}` : '' })}</div> : null}{r.status === 'failed' && r.error ? <div className="muted small">{r.error}</div> : null}</> },
          ]}
          rows={data || []} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [
            r.status === 'running'
              ? { label: t('panel.apps.stop', 'Stop'), onClick: () => control(r, 'stop') }
              : { label: t('panel.apps.start', 'Start'), primary: true, onClick: () => control(r, 'start') },
            { label: t('panel.apps.restart', 'Restart'), onClick: () => control(r, 'restart') },
            { label: t('panel.apps.logs', 'Logs'), onClick: () => openLogs(r) },
            { label: t('panel.apps.install_deps', 'Install dependencies'), onClick: () => installDeps(r) },
            { label: t('panel.apps.edit', 'Edit'), onClick: () => setEditing({ row: r, dir: r.dir, entry: r.entry, runtime: r.runtime, domain: r.domain, mount: r.mount, websocket: r.websocket, envText: envText(r.env), error: null }) },
            { label: t('panel.apps.remove', 'Remove'), danger: true, onClick: () => remove(r) },
          ]}
          emptyText={capability ? t('panel.apps.empty_capability', 'Your applications appear here once the server is ready.') : t('panel.apps.empty', 'No application yet. Add one above: a Node.js or Python program that listens on the PORT variable.')}
        />
      </Card>

      <Modal open={Boolean(logs)} title={logs ? fill(t('panel.apps.logs_title', 'Logs of {name}'), { name: logs.row.name }) : ''} onClose={() => setLogs(null)} size="lg"
        footer={<><button className="btn" onClick={() => logs && openLogs(logs.row, logs.lines)}>{t('common.refresh', 'Refresh')}</button><button className="btn btn-primary" onClick={() => setLogs(null)}>{t('common.close', 'Close')}</button></>}>
        {logs?.error && <RequestError error={logs.error} />}
        {logs && !logs.error && (logs.text == null ? <p className="muted">{t('common.loading', 'Loading…')}</p> : <pre className="log">{logs.text || t('panel.apps.logs_empty', 'Nothing logged yet.')}</pre>)}
      </Modal>

      <Modal open={Boolean(job)} title={job ? fill(t('panel.apps.installing_deps', 'Installing the dependencies of {name}'), { name: job.name }) : ''} onClose={() => setJob(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setJob(null)}>{t('common.close', 'Close')}</button>}>
        {job && <p className="muted">{job.type === 'node' ? t('panel.apps.deps_node', 'Runs npm install --omit=dev in the application folder as your account.') : t('panel.apps.deps_python', 'Creates .venv in the application folder and runs pip install -r requirements.txt as your account.')}</p>}
        {job && <ProgressLog jobId={job.id} onFinished={onJobFinished} streamPath={jobStreamPath} />}
      </Modal>

      <Modal open={Boolean(editing)} title={editing ? fill(t('panel.apps.edit_title', 'Edit {name}'), { name: editing.row.name }) : ''} onClose={() => setEditing(null)} size="lg"
        footer={<><button className="btn" onClick={() => setEditing(null)}>{t('common.cancel', 'Cancel')}</button><button className="btn btn-primary" disabled={busy} onClick={saveEdit}>{t('panel.apps.save', 'Save and restart')}</button></>}>
        {editing && (
          <form onSubmit={saveEdit}>
            <RequestError error={editing.error} />
            <KeyValue items={[{ label: t('panel.apps.port', 'Port'), value: <code>{editing.row.port}</code> }, { label: t('panel.apps.unit', 'Service'), value: <code>{editing.row.unit}</code> }]} />
            <div className="form-grid">
              <Field label={t('panel.apps.dir', 'Folder')} required htmlFor="edit-dir" error={editing.error?.fields?.dir}><TextInput id="edit-dir" value={editing.dir} onChange={(v) => setEditing((x) => ({ ...x, dir: v }))} maxLength={256} spellCheck={false} /></Field>
              <Field label={t('panel.apps.entry', 'Start file')} required htmlFor="edit-entry" error={editing.error?.fields?.entry}><TextInput id="edit-entry" value={editing.entry} onChange={(v) => setEditing((x) => ({ ...x, entry: v }))} maxLength={256} spellCheck={false} /></Field>
              <Field label={t('panel.apps.runtime', 'Runtime')} required htmlFor="edit-runtime" error={editing.error?.fields?.runtime}><Select id="edit-runtime" value={editing.runtime} onChange={(v) => setEditing((x) => ({ ...x, runtime: v }))} options={runtimeOptions(runtimes, editing.row.type, t).some((o) => o.value === editing.runtime) ? runtimeOptions(runtimes, editing.row.type, t) : [{ value: editing.runtime, label: editing.runtime }, ...runtimeOptions(runtimes, editing.row.type, t)]} /></Field>
              <Field label={t('panel.apps.domain', 'Domain')} required htmlFor="edit-domain" error={editing.error?.fields?.domain}><Select id="edit-domain" value={editing.domain} onChange={(v) => setEditing((x) => ({ ...x, domain: v }))} options={domainOptions.some((o) => o.value === editing.domain) ? domainOptions : [{ value: editing.domain, label: editing.domain }, ...domainOptions]} /></Field>
              <Field label={t('panel.apps.mount', 'Path')} required htmlFor="edit-mount" error={editing.error?.fields?.mount}><TextInput id="edit-mount" value={editing.mount} onChange={(v) => setEditing((x) => ({ ...x, mount: v }))} maxLength={200} spellCheck={false} /></Field>
              <Field label={t('panel.apps.websocket', 'WebSockets')} htmlFor="edit-websocket"><Toggle checked={editing.websocket} onChange={(v) => setEditing((x) => ({ ...x, websocket: v }))} label={t('panel.apps.websocket_label', 'Forward WebSocket connections too')} /></Field>
              <Field label={t('panel.apps.env', 'Environment variables')} htmlFor="edit-env" error={editing.error?.fields?.env}><Textarea id="edit-env" value={editing.envText} onChange={(v) => setEditing((x) => ({ ...x, envText: v }))} rows={5} mono /></Field>
            </div>
          </form>
        )}
      </Modal>
    </PanelPage>
  );
}
