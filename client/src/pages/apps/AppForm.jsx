import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Loading, KeyValue } from '../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, RadioGroup, Button } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';
import { RequestError } from '../security/Shared.jsx';
import { PresetCards } from './PresetCards.jsx';
import { EnvEditor, rowsToEnv, envErrors } from './EnvEditor.jsx';
import { KINDS, KIND_LABELS, KIND_DESCRIPTIONS, START_MODES, MODE_FIELD, homeOf, suggestRoot } from './Shared.jsx';

const KIND_DEFAULT_START = { node: { mode: 'npm-script', script: 'start' }, python: { mode: 'file', entry: 'main.py' } };
const GIT_URL = /^https:\/\/[A-Za-z0-9._-]+(:\d{1,5})?\/[A-Za-z0-9._/-]+(\.git)?$/;
const BASE_PATH = /^\/(?:[A-Za-z0-9._-]+\/?)*$/;

export function emptyForm(overrides = {}) {
  return {
    name: '', username: '', domain: '', basePath: '/', root: '', rootTouched: false,
    kind: 'node', preset: null,
    start: { mode: 'npm-script', entry: '', script: 'start', module: '', workers: 2 },
    build: { install: 'npm', script: '', optional: false, outputDir: '', extraPackages: '' },
    runtimeVersion: 'system',
    source: 'upload', gitUrl: '', gitRef: '',
    mode: 'production', env: [], websockets: true, spaFallback: true,
    limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 },
    ...overrides,
  };
}

function startForm(start, kind) {
  const base = start || KIND_DEFAULT_START[kind] || { mode: 'file' };
  return { mode: base.mode || 'file', entry: base.entry || '', script: base.script || '', module: base.module || '', workers: base.workers || 2 };
}

// Switches the kind and resets the preset-driven fields to the kind's defaults.
export function applyKind(form, kind) {
  if (form.kind === kind && !form.preset) return form;
  return {
    ...form, kind, preset: null,
    start: startForm(null, kind),
    build: { install: kind === 'python' ? 'pip' : 'npm', script: kind === 'static' ? 'build' : '', optional: false, outputDir: kind === 'static' ? 'dist' : '', extraPackages: '' },
    websockets: kind !== 'static', spaFallback: kind === 'static',
    runtimeVersion: 'system',
    source: form.source === 'scaffold' ? 'upload' : form.source,
  };
}

const runtimeKindOf = (kind) => (kind === 'python' ? 'python' : 'node');

// Prefills the "What" step from a preset served by GET /apps/presets.
export function applyPreset(form, preset) {
  if (!preset) return { ...form, preset: null };
  const kind = preset.kind;
  const install = preset.install === undefined ? (kind === 'python' ? 'pip' : 'npm') : preset.install;
  return {
    ...form, kind, preset: preset.id,
    start: startForm(preset.start, kind),
    build: { install: install ?? '', script: preset.build?.script || '', optional: Boolean(preset.build?.optional), outputDir: kind === 'static' ? (preset.outputDir || '.') : '', extraPackages: (preset.defaults?.extraPackages || []).join(' ') },
    websockets: kind === 'static' ? false : preset.websockets !== false,
    spaFallback: kind === 'static' ? preset.spaFallback !== false : false,
    runtimeVersion: preset.defaults?.runtimeVersion || (runtimeKindOf(kind) === runtimeKindOf(form.kind) ? form.runtimeVersion : null) || 'system',
    mode: preset.defaults?.mode || form.mode,
    limits: { ...form.limits, ...(preset.defaults?.limits || {}) },
    source: form.source === 'scaffold' && !preset.scaffold ? 'upload' : form.source,
  };
}

export const needsRuntime = (form) => form.kind !== 'static' || form.build.install === 'npm';
export const parsePackages = (text) => String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export function cleanStart(start) {
  const out = { mode: start.mode };
  const field = MODE_FIELD[start.mode];
  if (field && start[field]) out[field] = String(start[field]).trim();
  if (start.mode === 'gunicorn' && start.workers) out.workers = Number(start.workers);
  return out;
}

export function cleanBuild(build, kind) {
  const out = {};
  if (kind === 'python') {
    out.install = build.install ? 'pip' : null;
    const packages = parsePackages(build.extraPackages);
    if (packages.length) out.extraPackages = packages;
    return out;
  }
  out.install = build.install ? 'npm' : null;
  const script = String(build.script || '').trim();
  out.script = script || null;
  if (script) out.optional = Boolean(build.optional);
  if (kind === 'static') out.outputDir = String(build.outputDir || '.').trim() || '.';
  return out;
}

export const cleanLimits = (limits) => ({
  memoryMaxMb: Number(limits?.memoryMaxMb) || 512,
  tasksMax: Number(limits?.tasksMax) || 256,
  cpuQuotaPercent: Number(limits?.cpuQuotaPercent) || 100,
});

// The POST /apps body for the form state.
export function buildCreatePayload(form) {
  const kind = form.kind;
  const body = { username: form.username, name: form.name.trim(), kind, domain: form.domain, basePath: form.basePath.trim() || '/', root: form.root.trim(), mode: form.mode };
  if (form.preset) body.preset = form.preset;
  if (kind !== 'static') body.start = cleanStart(form.start);
  body.build = cleanBuild(form.build, kind);
  if (needsRuntime(form)) body.runtimeVersion = form.runtimeVersion || 'system';
  const env = rowsToEnv(form.env);
  if (Object.keys(env).length) body.env = env;
  if (kind !== 'static') body.websockets = Boolean(form.websockets);
  else body.spaFallback = Boolean(form.spaFallback);
  body.limits = cleanLimits(form.limits);
  if (form.source === 'git') body.source = { type: 'git', url: form.gitUrl.trim(), ...(form.gitRef.trim() ? { ref: form.gitRef.trim() } : {}) };
  else if (form.source === 'scaffold') body.source = { type: 'scaffold', template: form.preset };
  else body.source = { type: 'upload' };
  return body;
}

export function stepErrors(step, form) {
  const errors = [];
  if (step === 1) {
    if (!form.name.trim()) errors.push('Give the application a name');
    if (!form.username) errors.push('Choose an account');
    if (!form.domain) errors.push('Choose a domain');
    if (!BASE_PATH.test(form.basePath.trim() || '/') || /(^|\/)\.\.(\/|$)/.test(form.basePath)) errors.push('The base path must look like / or /api');
    if (!form.root.trim().startsWith('/')) errors.push('The application root must be an absolute path inside the account home');
  }
  if (step === 2) {
    if (form.kind !== 'static') {
      const field = MODE_FIELD[form.start.mode];
      if (!field || !String(form.start[field] || '').trim()) errors.push(`The start mode "${form.start.mode}" needs ${field === 'entry' ? 'an entry file' : field === 'script' ? 'an npm script' : 'a module'}`);
      if (field === 'module' && String(form.start.module).includes('<')) errors.push('Replace <project> in the module with your project name');
    } else if (!String(form.build.outputDir || '').trim()) errors.push('Set the output directory Apache serves');
    if (form.source === 'git' && !GIT_URL.test(form.gitUrl.trim())) errors.push('The repository URL must be an https:// URL without credentials');
    if (form.source === 'scaffold' && !form.preset) errors.push('Scaffolds need a preset');
  }
  if (step === 3) errors.push(...envErrors(form.env));
  return errors;
}

export function StartFields({ kind, value, onChange }) {
  if (kind === 'static') return null;
  const set = (patch) => onChange({ ...value, ...patch });
  const field = MODE_FIELD[value.mode];
  return (
    <div className="form-grid">
      <Field label="Start mode"><Select value={value.mode} onChange={(mode) => set({ mode })} options={START_MODES[kind] || []} /></Field>
      {field === 'entry' && <Field label="Entry file" required help="Relative to the application root"><TextInput value={value.entry} onChange={(entry) => set({ entry })} placeholder={kind === 'node' ? 'server.js' : 'main.py'} /></Field>}
      {field === 'script' && <Field label="npm script" required help="Run as npm run <script>; it must listen on process.env.PORT"><TextInput value={value.script} onChange={(script) => set({ script })} placeholder="start" /></Field>}
      {field === 'module' && <Field label="Module" required help={value.mode === 'gunicorn' ? 'WSGI callable, e.g. app:app or myproject.wsgi:application' : 'ASGI callable, e.g. main:app'}><TextInput value={value.module} onChange={(module) => set({ module })} placeholder={value.mode === 'gunicorn' ? 'app:app' : 'main:app'} /></Field>}
      {value.mode === 'gunicorn' && <Field label="Workers"><NumberInput value={value.workers} onChange={(workers) => set({ workers })} min={1} max={32} nullable={false} /></Field>}
    </div>
  );
}

export function BuildFields({ kind, value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const installOptions = kind === 'python'
    ? [{ value: 'pip', label: 'pip install -r requirements.txt (in a virtual environment)' }, { value: '', label: 'Nothing to install' }]
    : [{ value: 'npm', label: 'npm install (npm ci when a lockfile exists)' }, { value: '', label: 'Nothing to install' }];
  return (
    <div className="form-grid">
      <Field label="Install dependencies"><Select value={value.install ?? ''} onChange={(install) => set({ install })} options={installOptions} /></Field>
      {kind !== 'python' && <Field label="Build script" help="npm script run after the install; leave empty for none"><TextInput value={value.script} onChange={(script) => set({ script })} placeholder="build" /></Field>}
      {kind !== 'python' && value.script && <div className="field"><Toggle checked={value.optional} onChange={(optional) => set({ optional })} label="Only when package.json has this script" /></div>}
      {kind === 'static' && <Field label="Output directory" required help="Relative to the root; Apache serves it (dist, build, dist/<project>/browser, or . for the root itself)"><TextInput value={value.outputDir} onChange={(outputDir) => set({ outputDir })} placeholder="dist" /></Field>}
      {kind === 'python' && <Field label="Extra pip packages" help="Space-separated, installed after requirements.txt; gunicorn/uvicorn are added when the start mode needs them"><TextInput value={value.extraPackages} onChange={(extraPackages) => set({ extraPackages })} placeholder="psycopg2-binary" /></Field>}
    </div>
  );
}

const minorOf = (v) => String(v || '').split('.').slice(0, 2).join('.');

export function runtimeOptions(kind, runtimes) {
  if (kind === 'node') {
    const system = (runtimes?.node || []).find((n) => n.source === 'system');
    const managed = (runtimes?.node || []).filter((n) => n.source === 'managed' && !n.missing);
    return [{ value: 'system', label: system ? `System Node.js ${system.version}` : 'System Node.js (not detected)' }, ...managed.map((n) => ({ value: n.version, label: `Node.js ${n.version} (managed)` }))];
  }
  if (kind === 'python') {
    const list = runtimes?.python || [];
    const first = list.find((p) => p.venv) || list[0];
    const seen = new Set();
    const versions = list.filter((p) => p.venv).map((p) => minorOf(p.version)).filter((v) => v && !seen.has(v) && seen.add(v));
    return [{ value: 'system', label: first ? `System Python ${first.version}` : 'System Python 3 (not detected)' }, ...versions.map((v) => ({ value: v, label: `Python ${v}` }))];
  }
  return [];
}

export function RuntimeSelect({ kind, runtimes, value, onChange }) {
  const runtimeKind = kind === 'python' ? 'python' : 'node';
  const options = runtimeOptions(runtimeKind, runtimes);
  const def = runtimes?.defaults?.[runtimeKind];
  return (
    <Field label={`${KIND_LABELS[runtimeKind]} version`} help={<>Server default: {def || 'system'} · manage versions under <Link to="/application-manager/runtime-versions">Runtime Versions</Link></>}>
      <Select value={value || 'system'} onChange={onChange} options={options} />
    </Field>
  );
}

export function LimitsFields({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="form-grid">
      <Field label="Memory limit (MB)" help="64–65536; the service is killed above it"><NumberInput value={value.memoryMaxMb} onChange={(memoryMaxMb) => set({ memoryMaxMb })} min={64} max={65536} nullable={false} /></Field>
      <Field label="Max tasks (threads + processes)" help="16–65536"><NumberInput value={value.tasksMax} onChange={(tasksMax) => set({ tasksMax })} min={16} max={65536} nullable={false} /></Field>
      <Field label="CPU quota (%)" help="100 = one core, up to 800"><NumberInput value={value.cpuQuotaPercent} onChange={(cpuQuotaPercent) => set({ cpuQuotaPercent })} min={10} max={800} nullable={false} /></Field>
    </div>
  );
}

export function InspectResult({ result }) {
  if (!result) return null;
  if (!result.exists) return <div className="banner banner-info"><div><strong>{result.root} does not exist yet</strong><p className="muted">It is created as the account user at deploy time; choose a scaffold or a git repository in the next step, or upload the files first.</p></div></div>;
  const pkg = result.packageJson;
  return (
    <div className="banner banner-info">
      <div style={{ flex: 1 }}>
        <strong>{result.empty ? `${result.root} is empty` : `${result.files?.length ?? 0} entr${result.files?.length === 1 ? 'y' : 'ies'} in ${result.root}`}</strong>
        <KeyValue items={[
          pkg && ['package.json', `${pkg.name || '(unnamed)'}${pkg.scripts ? ` · scripts: ${Object.keys(pkg.scripts).join(', ') || 'none'}` : ''}`],
          pkg?.dependencies?.length && ['Dependencies', pkg.dependencies.slice(0, 12).join(', ') + (pkg.dependencies.length > 12 ? '…' : '')],
          result.requirements && ['requirements.txt', result.requirements.join(', ') || '(empty)'],
          result.angularProjects?.length && ['Angular projects', result.angularProjects.join(', ')],
          result.suggestion?.lockfile && ['Lockfile', result.suggestion.lockfile],
          ['Suggested preset', result.preset ? `${result.preset.label} (${KIND_LABELS[result.preset.kind]})` : 'none recognised'],
        ]} />
      </div>
    </div>
  );
}

export function StepWhere({ form, setForm, accounts, domains, inspect, onInspect }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const accountOptions = (accounts?.data || []).map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}${a.suspended ? ' (suspended)' : ''}` }));
  const domainOptions = (domains?.data || []).map((d) => ({ value: d.domain, label: `${d.domain} (${d.type})` }));
  const account = (accounts?.data || []).find((a) => a.username === form.username);
  return (
    <>
      <div className="form-grid">
        <Field label="Application name" required help="Shown in the panel and in the service description"><TextInput value={form.name} onChange={(name) => set({ name })} placeholder="My API" maxLength={64} /></Field>
        <Field label="Account" required help={accounts?.loading ? 'Loading accounts…' : `${accountOptions.length} account(s)`}>
          <Select value={form.username} onChange={(username) => set({ username, domain: '' })} options={accountOptions} placeholder={accountOptions.length ? 'Select an account' : 'No accounts yet'} />
        </Field>
        <Field label="Domain" required help={!form.username ? 'Choose the account first' : domains?.loading ? 'Loading domains…' : 'Main, addon and sub-domains of the account'}>
          <Select value={form.domain} onChange={(domain) => set({ domain })} options={domainOptions} placeholder="Select a domain" disabled={!form.username} />
        </Field>
        <Field label="Base path" required help="/ for the whole site, or a prefix such as /api (the application sees paths relative to it)"><TextInput value={form.basePath} onChange={(basePath) => set({ basePath })} placeholder="/" /></Field>
      </div>
      <Field label="Application root" required help={account ? `Inside ${homeOf(account)}/ — Node.js and Python apps cannot use public_html itself` : 'An absolute path inside the account home'}>
        <div className="input-group">
          <TextInput value={form.root} onChange={(root) => set({ root, rootTouched: true })} placeholder="/home/user/apps/my-api" className="input mono" />
          <Button icon={Search} onClick={onInspect} loading={inspect.loading} disabled={!form.username || !form.root.trim().startsWith('/')}>Inspect</Button>
        </div>
      </Field>
      <RequestError error={inspect.error} />
      <InspectResult result={inspect.data} />
    </>
  );
}

export function StepWhat({ form, setForm, presets, presetsLoading, runtimes, onPreset }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const selected = (presets || []).find((p) => p.id === form.preset) || null;
  const scaffoldable = Boolean(selected?.scaffold);
  const sourceOptions = [
    { value: 'upload', label: 'Files already in the root', description: 'Uploaded over FTP/SFTP or copied there; nothing is fetched.' },
    { value: 'git', label: 'Clone a git repository', description: 'Shallow https:// clone into the root (must be empty); Deploy later pulls the latest commit.' },
    scaffoldable && { value: 'scaffold', label: `Create a starter ${selected.label} project`, description: 'Writes a minimal project into the empty root so the application runs right away.' },
  ].filter(Boolean);
  return (
    <>
      <Field label="Kind">
        <RadioGroup name="kind" value={form.kind} onChange={(kind) => setForm((f) => applyKind(f, kind))} options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k], description: KIND_DESCRIPTIONS[k] }))} />
      </Field>
      <Field label="Preset" help="Prefills the install, build and start settings below; everything stays editable.">
        <PresetCards presets={presets} kind={form.kind} value={form.preset} loading={presetsLoading} onChange={(p) => { setForm((f) => applyPreset(f, p)); onPreset?.(p); }} />
      </Field>
      <h3 style={{ margin: '14px 0 8px' }}>Build</h3>
      <BuildFields kind={form.kind} value={form.build} onChange={(build) => set({ build })} />
      {form.kind !== 'static' && (
        <>
          <h3 style={{ margin: '6px 0 8px' }}>Start</h3>
          <StartFields kind={form.kind} value={form.start} onChange={(start) => set({ start })} />
        </>
      )}
      {needsRuntime(form) && <RuntimeSelect kind={form.kind} runtimes={runtimes} value={form.runtimeVersion} onChange={(runtimeVersion) => set({ runtimeVersion })} />}
      <h3 style={{ margin: '6px 0 8px' }}>Source</h3>
      <RadioGroup name="source" value={form.source} onChange={(source) => set({ source })} options={sourceOptions} />
      {form.source === 'git' && (
        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="Repository URL" required help="https:// only, no credentials; private repositories need a deploy token in the URL path form your host supports"><TextInput value={form.gitUrl} onChange={(gitUrl) => set({ gitUrl })} placeholder="https://github.com/org/project.git" className="input mono" /></Field>
          <Field label="Branch or tag" help="Optional; the default branch otherwise"><TextInput value={form.gitRef} onChange={(gitRef) => set({ gitRef })} placeholder="main" /></Field>
        </div>
      )}
    </>
  );
}

export function StepSettings({ form, setForm }) {
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  return (
    <>
      <div className="form-grid">
        <Field label="Mode" help="Sets NODE_ENV; production also skips devDependencies when nothing is built"><Select value={form.mode} onChange={(mode) => set({ mode })} options={[{ value: 'production', label: 'production' }, { value: 'development', label: 'development' }]} /></Field>
        <div className="field">
          {form.kind !== 'static' && <Toggle checked={form.websockets} onChange={(websockets) => set({ websockets })} label="Websockets" description="Forward Upgrade requests to the application" />}
          {form.kind === 'static' && <Toggle checked={form.spaFallback} onChange={(spaFallback) => set({ spaFallback })} label="SPA fallback" description="Serve index.html for unknown paths (client-side routing)" />}
        </div>
      </div>
      <h3 style={{ margin: '6px 0 8px' }}>Environment variables</h3>
      <EnvEditor rows={form.env} onChange={(env) => set({ env })} />
      {form.kind !== 'static' && (
        <>
          <h3 style={{ margin: '14px 0 8px' }}>Limits</h3>
          <LimitsFields value={form.limits} onChange={(limits) => set({ limits })} />
        </>
      )}
    </>
  );
}

const STEPS = [{ n: 1, label: 'Where' }, { n: 2, label: 'What' }, { n: 3, label: 'Settings' }];

function StepIndicator({ step }) {
  return (
    <div className="row-actions" style={{ marginBottom: 16, gap: 12 }}>
      {STEPS.map((s) => (
        <span key={s.n} className={`pill ${s.n === step ? 'pill-info' : s.n < step ? 'pill-ok' : 'pill-muted'}`}>{s.n}. {s.label}</span>
      ))}
    </div>
  );
}

function CreateAppModalInner({ onClose, onCreated, presets, presetsLoading, runtimes, initialPreset, initialUsername }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(() => emptyForm({ username: initialUsername || '' }));
  const [inspect, setInspect] = useState({ data: null, error: null, loading: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const presetApplied = useRef(false);
  const accounts = useApi('/accounts?pageSize=500&sort=username');
  const [domains, setDomains] = useState({ data: null, error: null, loading: false });
  const account = useMemo(() => (accounts.data || []).find((a) => a.username === form.username), [accounts.data, form.username]);

  useEffect(() => {
    if (presetApplied.current || !initialPreset || !presets?.length) return;
    const p = presets.find((x) => x.id === initialPreset);
    if (p) { setForm((f) => applyPreset(f, p)); presetApplied.current = true; }
  }, [initialPreset, presets]);
  // The domain list belongs to one account: it is cleared when the account
  // changes and the default domain is picked from the fresh answer only.
  useEffect(() => {
    if (!form.username) { setDomains({ data: null, error: null, loading: false }); return undefined; }
    let cancelled = false;
    setDomains({ data: null, error: null, loading: true });
    api.get(`/apps/accounts/${encodeURIComponent(form.username)}/domains`).then(({ data }) => {
      if (cancelled) return;
      setDomains({ data, error: null, loading: false });
      setForm((f) => (f.domain && data.some((d) => d.domain === f.domain) ? f : { ...f, domain: data[0]?.domain || '' }));
    }).catch((error) => { if (!cancelled) setDomains({ data: null, error, loading: false }); });
    return () => { cancelled = true; };
  }, [form.username]);
  useEffect(() => {
    if (form.rootTouched) return;
    const root = suggestRoot({ home: homeOf(account), kind: form.kind, name: form.name });
    setForm((f) => (f.root === root ? f : { ...f, root }));
  }, [account, form.kind, form.name, form.rootTouched]);

  const runInspect = async () => {
    setInspect({ data: null, error: null, loading: true });
    try {
      const { data } = await api.post('/apps/inspect', { username: form.username, root: form.root.trim() });
      setInspect({ data, error: null, loading: false });
      const guess = data.preset ? (presets || []).find((p) => p.id === data.preset.id) || data.preset : null;
      if (guess) {
        setForm((f) => {
          let next = applyPreset(f, guess);
          if (data.suggestion?.outputDir && guess.kind === 'static') next = { ...next, build: { ...next.build, outputDir: data.suggestion.outputDir } };
          if (data.suggestion?.start && guess.kind !== 'static') next = { ...next, start: startForm(data.suggestion.start, guess.kind) };
          if (!data.exists || data.empty) next = { ...next, source: guess.scaffold ? 'scaffold' : next.source === 'scaffold' ? 'upload' : next.source };
          return next;
        });
      }
    } catch (err) { setInspect({ data: null, error: err, loading: false }); }
  };

  const errors = stepErrors(step, form);
  const submit = async () => {
    const all = [1, 2, 3].flatMap((s) => stepErrors(s, form));
    if (all.length) { setError({ message: all[0] }); return; }
    setSubmitting(true); setError(null);
    try {
      const { data } = await api.post('/apps', buildCreatePayload(form));
      onCreated?.(data);
      onClose();
    } catch (err) { setError(err); } finally { setSubmitting(false); }
  };

  return (
    <Modal open title="Create application" onClose={onClose} size="lg"
      footer={(
        <>
          <Button onClick={onClose} disabled={submitting}>Cancel</Button>
          {step > 1 && <Button onClick={() => setStep(step - 1)} disabled={submitting}>Back</Button>}
          {step < 3 && <Button variant="primary" onClick={() => setStep(step + 1)} disabled={errors.length > 0} title={errors[0]}>Next</Button>}
          {step === 3 && <Button variant="primary" onClick={submit} loading={submitting} disabled={errors.length > 0}>Create and deploy</Button>}
        </>
      )}>
      <StepIndicator step={step} />
      {accounts.loading && !accounts.data && <Loading text="Loading accounts…" />}
      <RequestError error={accounts.error} onRetry={accounts.refetch} />
      <RequestError error={domains.error} />
      {step === 1 && <StepWhere form={form} setForm={setForm} accounts={accounts} domains={domains} inspect={inspect} onInspect={runInspect} />}
      {step === 2 && <StepWhat form={form} setForm={setForm} presets={presets} presetsLoading={presetsLoading} runtimes={runtimes} />}
      {step === 3 && <StepSettings form={form} setForm={setForm} />}
      {errors.length > 0 && <p className="field-message" style={{ marginTop: 8 }}>{errors[0]}</p>}
      <RequestError error={error} />
    </Modal>
  );
}

export function CreateAppModal({ open, ...props }) {
  if (!open) return null;
  return <CreateAppModalInner {...props} />;
}
