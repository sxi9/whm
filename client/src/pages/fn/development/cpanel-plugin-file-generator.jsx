import { useState } from 'react';
import { Download, Eye } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Select, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, Tabs, CopyButton, downloadBase64 } from '../../development/Shared.jsx';

const EMPTY = { id: 'com.example.hello', name: 'Hello Plugin', version: '1.0.0', description: 'Describe what the plugin does for administrators.', authorName: '', authorEmail: '', license: 'MIT', category: 'Plugins', permissions: [], hooks: [], withSettings: true, withJob: false, withPage: true, isolation: '', keywords: '' };

export default function CpanelPluginFileGenerator({ fn }) {
  const toast = useToast();
  const vocab = useApi('/development/plugin-generator/vocabulary');
  const [form, setForm] = useState(EMPTY);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState('plugin.json');
  const [hookEvent, setHookEvent] = useState('account.created');
  const [hookStage, setHookStage] = useState('post');

  const body = () => ({
    id: form.id.trim(), name: form.name.trim(), version: form.version.trim(), description: form.description.trim(), authorName: form.authorName.trim(),
    ...(form.authorEmail.trim() ? { authorEmail: form.authorEmail.trim() } : {}), license: form.license.trim() || 'MIT', category: form.category || undefined,
    permissions: form.permissions, hooks: form.hooks, withSettings: form.withSettings, withJob: form.withJob, withPage: form.withPage,
    ...(form.isolation ? { isolation: form.isolation } : {}), ...(form.keywords.trim() ? { keywords: form.keywords.split(/[\s,]+/).filter(Boolean).slice(0, 10) } : {}),
  });
  const doPreview = async () => {
    setBusy(true); setPreviewError(null);
    try { const { data } = await api.post('/development/plugin-generator/preview', body()); setPreview(data); setFile('plugin.json'); } catch (err) { setPreviewError(err); setPreview(null); } finally { setBusy(false); }
  };
  const generate = async () => {
    setBusy(true); setPreviewError(null);
    try {
      const { data } = await api.post('/development/plugin-generator/generate', body());
      downloadBase64(data.filename, data.base64, data.contentType);
      toast.success(`${data.filename} (${data.size} bytes) downloaded`);
    } catch (err) { setPreviewError(err); } finally { setBusy(false); }
  };
  const togglePerm = (scope) => setForm((f) => ({ ...f, permissions: f.permissions.includes(scope) ? f.permissions.filter((p) => p !== scope) : [...f.permissions, scope] }));
  const addHook = () => { if (!form.hooks.some((h) => h.event === hookEvent && h.stage === hookStage)) setForm({ ...form, hooks: [...form.hooks, { event: hookEvent, stage: hookStage }] }); };
  const eventDef = vocab.data?.events.find((e) => e.name === hookEvent);
  const stages = eventDef?.stages || ['post'];
  const current = preview?.files.find((f) => f.path === file);

  return (
    <>
      <PageHeader fn={fn} actions={vocab.data && <StatusPill status="ok">SDK {vocab.data.sdkVersion || 'bundled'}</StatusPill>} />
      <RequestError error={vocab.error} onRetry={vocab.refetch} />
      {vocab.loading && !vocab.data && <Loading />}
      {vocab.data && (
        <>
          <Card title="Plugin identity" subtitle="Produces plugin.json, index.js and README.md that validate against the plugin SDK manifest contract.">
            <div className="form-grid">
              <Field label="Plugin id" required help="Reverse-DNS, at least three segments"><TextInput value={form.id} onChange={(v) => setForm({ ...form, id: v })} /></Field>
              <Field label="Name" required><TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></Field>
              <Field label="Version" required><TextInput value={form.version} onChange={(v) => setForm({ ...form, version: v })} /></Field>
              <Field label="License" help="SPDX identifier or proprietary"><TextInput value={form.license} onChange={(v) => setForm({ ...form, license: v })} /></Field>
              <Field label="Author" required><TextInput value={form.authorName} onChange={(v) => setForm({ ...form, authorName: v })} /></Field>
              <Field label="Author email"><TextInput value={form.authorEmail} onChange={(v) => setForm({ ...form, authorEmail: v })} /></Field>
              <Field label="Sidebar category" help="Where the plugin page appears"><Select value={form.category} onChange={(v) => setForm({ ...form, category: v })} options={vocab.data.categories} /></Field>
              <Field label="Isolation"><Select value={form.isolation} onChange={(v) => setForm({ ...form, isolation: v })} options={vocab.data.isolationModes} placeholder="host default" /></Field>
            </div>
            <Field label="Description" required><Textarea rows={2} value={form.description} onChange={(v) => setForm({ ...form, description: v })} /></Field>
            <Field label="Keywords" help="Up to 10, space or comma separated"><TextInput value={form.keywords} onChange={(v) => setForm({ ...form, keywords: v })} /></Field>
            <div className="form-grid">
              <Toggle checked={form.withPage} onChange={(v) => setForm({ ...form, withPage: v })} label="Sidebar page" description="Adds a markdown page and sidebar entry (ui:sidebar)" />
              <Toggle checked={form.withSettings} onChange={(v) => setForm({ ...form, withSettings: v })} label="Settings schema" description="Sample text + toggle fields (settings:own)" />
              <Toggle checked={form.withJob} onChange={(v) => setForm({ ...form, withJob: v })} label="Background job + nightly cron" description="Example housekeeping job (jobs, schedule)" />
            </div>
          </Card>
          <Card title="Permissions" subtitle="Each scope is shown to the administrator on the consent screen when the plugin is installed. Scopes implied by the options above are added automatically.">
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {vocab.data.permissions.map((p) => <label key={p.scope} className="radio"><input type="checkbox" checked={form.permissions.includes(p.scope)} onChange={() => togglePerm(p.scope)} /> <span><strong><code>{p.scope}</code></strong><small>{p.description}</small></span></label>)}
            </div>
            <p className="small muted">Parameterised scopes (<code>agent:op:&lt;family.op&gt;</code>, <code>net:outbound:&lt;host&gt;</code>) can be added to plugin.json by hand after generation.</p>
          </Card>
          <Card title="Hooks" subtitle="Events the plugin listens to; a handler stub is generated for each.">
            <div className="form-grid">
              <Field label="Event"><Select value={hookEvent} onChange={(v) => { setHookEvent(v); const s = vocab.data.events.find((e) => e.name === v)?.stages || ['post']; if (!s.includes(hookStage)) setHookStage(s[0]); }} options={vocab.data.events.map((e) => e.name)} /></Field>
              <Field label="Stage" help={eventDef?.payload ? `Payload: ${eventDef.payload}` : undefined}><Select value={hookStage} onChange={setHookStage} options={stages} /></Field>
            </div>
            <div className="action-row"><Button onClick={addHook}>Add hook</Button></div>
            {form.hooks.length > 0 && <div className="row-actions" style={{ flexWrap: 'wrap' }}>{form.hooks.map((h) => <button key={`${h.event}:${h.stage}`} className="btn btn-sm" onClick={() => setForm({ ...form, hooks: form.hooks.filter((x) => x !== h) })} title="Remove"><code>{h.event}</code> <span className="muted">{h.stage}</span> ×</button>)}</div>}
          </Card>
          <div className="action-row" style={{ display: 'flex', gap: 8 }}>
            <Button icon={Eye} loading={busy} onClick={doPreview} disabled={!form.id.trim() || !form.name.trim() || !form.authorName.trim()}>Preview files</Button>
            <Button variant="primary" icon={Download} loading={busy} onClick={generate} disabled={!form.id.trim() || !form.name.trim() || !form.authorName.trim()}>Generate .tar.gz</Button>
          </div>
          <ErrorBanner error={previewError} />
          {preview && (
            <Card title={`Preview: ${preview.dirname}/`} subtitle={preview.validation.ok ? 'The manifest validates against the SDK.' : 'The manifest has validation errors; fix them before generating.'}
              actions={<>{preview.validation.ok ? <StatusPill status="ok">valid manifest</StatusPill> : <StatusPill status="failed">{preview.validation.errors.length} error(s)</StatusPill>}{current && <CopyButton text={current.content} />}</>}>
              {!preview.validation.ok && <ul className="small">{preview.validation.errors.map((e, i) => <li key={i}><code>{e.path || '(root)'}</code> {e.code}: {e.message}</li>)}</ul>}
              <Tabs value={file} onChange={setFile} tabs={preview.files.map((f) => ({ value: f.path, label: f.path }))} />
              {current && <pre className="log" style={{ maxHeight: 520 }}>{current.content}</pre>}
            </Card>
          )}
        </>
      )}
    </>
  );
}
