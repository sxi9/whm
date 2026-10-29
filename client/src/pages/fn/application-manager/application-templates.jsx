import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Button, ErrorBanner } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError } from '../../software/Shared.jsx';
import { PresetCatalog } from '../../apps/PresetCards.jsx';
import { emptyForm, applyKind, applyPreset, StartFields, BuildFields, LimitsFields, cleanStart, cleanBuild, cleanLimits, needsRuntime, stepErrors } from '../../apps/AppForm.jsx';
import { KINDS, KIND_LABELS, KindBadge, slugify, startLabel } from '../../apps/Shared.jsx';

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

// The preset_json fields of a custom template as the create form represents them.
export function formFromTemplate(t) {
  const p = t?.preset || {};
  const base = applyKind(emptyForm(), t?.kind || 'node');
  const pseudo = { id: null, kind: t?.kind || 'node', start: p.start ?? null, install: p.build?.install, build: p.build ?? null, outputDir: p.build?.outputDir, websockets: p.websockets, spaFallback: p.spaFallback, defaults: { runtimeVersion: p.runtimeVersion, mode: p.mode, limits: p.limits, extraPackages: p.build?.extraPackages } };
  const form = applyPreset(base, pseudo);
  return { ...form, preset: null, name: t?.name || '', slug: t?.slug || '', slugTouched: Boolean(t?.slug), description: t?.description || '' };
}

export function templatePayload(form) {
  const kind = form.kind;
  const preset = { build: cleanBuild(form.build, kind), mode: form.mode, limits: cleanLimits(form.limits) };
  if (kind !== 'static') { preset.start = cleanStart(form.start); preset.websockets = Boolean(form.websockets); } else preset.spaFallback = Boolean(form.spaFallback);
  if (needsRuntime(form) && form.runtimeVersion) preset.runtimeVersion = form.runtimeVersion;
  return { slug: form.slug.trim(), name: form.name.trim(), kind, description: form.description.trim() || null, preset };
}

function TemplateModal({ template, presets, onClose, onSaved }) {
  const [form, setForm] = useState(() => formFromTemplate(template?.id ? template : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const errors = [
    !form.name.trim() && 'A name is required',
    !SLUG.test(form.slug.trim()) && 'The slug is lowercase letters, digits and dashes (max 48)',
    ...stepErrors(2, { ...form, source: 'upload' }),
  ].filter(Boolean);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const body = templatePayload(form);
      const { data } = template?.id ? await api.put(`/apps/templates/${template.id}`, body) : await api.post('/apps/templates', body);
      onSaved(data);
      onClose();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };
  const builtins = (presets || []).filter((p) => !p.custom);
  return (
    <Modal open title={template?.id ? `Edit template ${template.name}` : 'New template'} onClose={onClose} size="lg" footer={(
      <>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving} disabled={errors.length > 0} title={errors[0]}>{template?.id ? 'Save template' : 'Create template'}</Button>
      </>
    )}>
      <div className="form-grid">
        <Field label="Name" required><TextInput value={form.name} onChange={(name) => set({ name, slug: form.slugTouched ? form.slug : slugify(name).slice(0, 48) })} maxLength={64} placeholder="Company API (NestJS)" /></Field>
        <Field label="Slug" required help="Used as the preset id; must not clash with a built-in"><TextInput value={form.slug} onChange={(slug) => set({ slug, slugTouched: true })} placeholder="company-api" className="input mono" /></Field>
        <Field label="Kind"><Select value={form.kind} onChange={(kind) => setForm((f) => (f.kind === kind ? f : applyKind(f, kind)))} options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} /></Field>
        <Field label="Start from a built-in preset" help="Copies its fields into the form"><Select value="" onChange={(id) => { const p = builtins.find((x) => x.id === id); if (p) setForm((f) => ({ ...applyPreset(f, p), preset: null })); }} options={builtins.filter((p) => p.kind === form.kind).map((p) => ({ value: p.id, label: p.label }))} placeholder="Choose a preset to copy" /></Field>
      </div>
      <Field label="Description"><TextInput value={form.description} onChange={(description) => set({ description })} maxLength={500} placeholder="Shown on the template card" /></Field>
      <h3 style={{ margin: '12px 0 8px' }}>Build</h3>
      <BuildFields kind={form.kind} value={form.build} onChange={(build) => set({ build })} />
      {form.kind !== 'static' && (<><h3 style={{ margin: '6px 0 8px' }}>Start</h3><StartFields kind={form.kind} value={form.start} onChange={(start) => set({ start })} /></>)}
      <div className="form-grid">
        {needsRuntime(form) && <Field label={`${form.kind === 'python' ? 'Python' : 'Node.js'} version`} help="system, or a version such as 20.11.0 / 3.12"><TextInput value={form.runtimeVersion} onChange={(runtimeVersion) => set({ runtimeVersion })} placeholder="system" /></Field>}
        <Field label="Mode"><Select value={form.mode} onChange={(mode) => set({ mode })} options={[{ value: 'production', label: 'production' }, { value: 'development', label: 'development' }]} /></Field>
        <div className="field">
          {form.kind !== 'static' && <Toggle checked={form.websockets} onChange={(websockets) => set({ websockets })} label="Websockets" />}
          {form.kind === 'static' && <Toggle checked={form.spaFallback} onChange={(spaFallback) => set({ spaFallback })} label="SPA fallback" />}
        </div>
      </div>
      {form.kind !== 'static' && (<><h3 style={{ margin: '6px 0 8px' }}>Limits</h3><LimitsFields value={form.limits} onChange={(limits) => set({ limits })} /></>)}
      {errors.length > 0 && <p className="field-message">{errors[0]}</p>}
      <ErrorBanner error={error} />
    </Modal>
  );
}

export function TemplatesTable({ templates, onUse, onEdit, onRemove }) {
  const list = templates || [];
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead><tr><th>Template</th><th>Kind</th><th>Install / build</th><th>Start</th><th>Updated</th><th /></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={6} className="table-state">No custom templates yet. Save a preset with your own defaults to reuse it when creating applications.</td></tr>}
          {list.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.name}</strong> <code className="small">{t.slug}</code>{t.description && <div className="muted small">{t.description}</div>}</td>
              <td><KindBadge kind={t.kind} /></td>
              <td className="small">{t.preset?.build?.install === undefined ? 'default' : t.preset.build.install || 'none'}{t.preset?.build?.script ? ` · npm run ${t.preset.build.script}` : ''}{t.kind === 'static' ? ` · serves ${t.preset?.build?.outputDir || '.'}` : ''}</td>
              <td className="small">{t.kind === 'static' ? '—' : startLabel(t.preset?.start, t.kind) || 'default'}</td>
              <td className="small">{formatDate(t.updatedAt)}</td>
              <td className="actions-col">
                <div className="row-actions">
                  <Button size="sm" variant="primary" onClick={() => onUse(t.slug)}>Use template</Button>
                  <Button size="sm" onClick={() => onEdit(t)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => onRemove(t)}>Delete</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ApplicationTemplates({ fn }) {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const presets = useApi('/apps/presets');
  const templates = useApi('/apps/templates', { enabled: isRoot });
  const [editing, setEditing] = useState(null);
  const use = (id) => navigate(`/application-manager/application-manager?preset=${encodeURIComponent(id)}`);
  const remove = async (t) => {
    if (!(await confirm({ title: `Delete template ${t.name}?`, message: 'Applications created from it keep their settings; only the template goes away.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/apps/templates/${t.id}`); toast.success(`Template ${t.name} deleted`); templates.refetch(); presets.refetch(); } catch (err) { toast.error(err); }
  };
  const builtins = (presets.data || []).filter((p) => !p.custom);

  return (
    <>
      <PageHeader fn={fn} actions={isRoot && <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>New template</Button>} />
      <RequestError error={presets.error} onRetry={presets.refetch} />
      <Card title="Built-in presets" subtitle="Each preset tells the panel how to install, build, start and publish an application; pick one when creating an application or start a custom template from it.">
        {presets.loading && !presets.data && <Loading text="Loading presets…" />}
        {presets.data && <PresetCatalog presets={builtins} onUse={use} />}
      </Card>
      {isRoot && (
        <Card title="Custom templates" subtitle="Root-defined presets: a kind plus the build, start, runtime, mode and limit defaults a new application starts from." padded={false}>
          <RequestError error={templates.error} onRetry={templates.refetch} />
          <TemplatesTable templates={templates.data} onUse={use} onEdit={setEditing} onRemove={remove} />
        </Card>
      )}
      {editing && <TemplateModal template={editing} presets={presets.data} onClose={() => setEditing(null)} onSaved={(t) => { toast.success(`Template ${t.name} saved`); templates.refetch(); presets.refetch(); }} />}
    </>
  );
}
