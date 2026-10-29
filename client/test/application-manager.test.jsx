import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast.jsx';
import { ConfirmProvider } from '../src/components/Modal.jsx';
import { FUNCTION_BY_KEY } from '../src/nav.js';

const authState = { user: { id: 1, username: 'root', role: 'root' } };
vi.mock('../src/auth/AuthContext.jsx', () => ({ useAuth: () => ({ user: authState.user, refresh: async () => {} }) }));

// Pages read through useApi; the mock answers by path prefix so each render is
// a deterministic snapshot of one server state.
const responses = new Map();
vi.mock('../src/hooks/useApi.js', () => ({
  useApi: (path, { enabled = true } = {}) => {
    if (!enabled || !path) return { data: null, meta: null, error: null, loading: false, refetch() {}, setData() {} };
    const hit = [...responses.entries()].find(([k]) => (k instanceof RegExp ? k.test(path) : path.startsWith(k)));
    const r = hit ? hit[1] : null;
    return { data: r?.data ?? null, meta: r?.meta ?? null, error: r?.error ?? null, loading: false, refetch() {}, setData() {} };
  },
  useMutation: (fn) => ({ mutate: fn, loading: false, error: null, fieldErrors: null, reset() {} }),
}));

const { PresetCards, PresetCatalog, presetFields } = await import('../src/pages/apps/PresetCards.jsx');
const { emptyForm, applyPreset, applyKind, buildCreatePayload, stepErrors, StepWhat, runtimeOptions } = await import('../src/pages/apps/AppForm.jsx');
const { EnvEditor, envToRows, rowsToEnv, envErrors, parseDotenv } = await import('../src/pages/apps/EnvEditor.jsx');
const { AppStatusPill, suggestRoot, FALLBACK_PRESETS, CapabilitySummary } = await import('../src/pages/apps/Shared.jsx');
const { AppOverview, settingsPayload } = await import('../src/pages/apps/AppDetail.jsx');
const ApplicationManager = (await import('../src/pages/fn/application-manager/application-manager.jsx')).default;
const { AppsTable } = await import('../src/pages/fn/application-manager/application-manager.jsx');
const RuntimeVersions = (await import('../src/pages/fn/application-manager/runtime-versions.jsx')).default;
const { NodeRuntimeTable, AvailableNodeList } = await import('../src/pages/fn/application-manager/runtime-versions.jsx');
const ApplicationTemplates = (await import('../src/pages/fn/application-manager/application-templates.jsx')).default;
const { formFromTemplate, templatePayload } = await import('../src/pages/fn/application-manager/application-templates.jsx');

React.useLayoutEffect = React.useEffect;
const render = (el, { initialEntries } = {}) => renderToStaticMarkup(
  <ToastProvider><ConfirmProvider><MemoryRouter initialEntries={initialEntries}>{el}</MemoryRouter></ConfirmProvider></ToastProvider>,
);

// The catalog GET /apps/presets serves (same shape and ids as the server's PRESETS).
const p = (id, label, kind, framework, extra) => ({ id, label, kind, framework, detect: { files: [], dependencies: [] }, install: null, build: null, start: null, outputDir: null, spaFallback: kind === 'static', websockets: kind !== 'static', scaffold: false, docs: null, description: `${label} preset`, ...extra });
const PRESETS = [
  p('express', 'Express', 'node', 'Express', { install: 'npm', start: { mode: 'file', entry: 'server.js' }, scaffold: true }),
  p('nestjs', 'NestJS', 'node', 'NestJS', { install: 'npm', build: { script: 'build' }, start: { mode: 'file', entry: 'dist/main.js' } }),
  p('nextjs', 'Next.js', 'node', 'Next.js', { install: 'npm', build: { script: 'build' }, start: { mode: 'npm-script', script: 'start' } }),
  p('nuxt', 'Nuxt', 'node', 'Nuxt', { install: 'npm', build: { script: 'build' }, start: { mode: 'file', entry: '.output/server/index.mjs' } }),
  p('node-custom', 'Node.js (custom)', 'node', null, { install: 'npm', build: { script: 'build', optional: true }, start: { mode: 'npm-script', script: 'start' } }),
  p('react-vite', 'React (Vite)', 'static', 'React', { install: 'npm', build: { script: 'build' }, outputDir: 'dist' }),
  p('react-cra', 'React (Create React App)', 'static', 'React', { install: 'npm', build: { script: 'build' }, outputDir: 'build' }),
  p('angular', 'Angular', 'static', 'Angular', { install: 'npm', build: { script: 'build' }, outputDir: 'dist/<project>/browser' }),
  p('vue', 'Vue', 'static', 'Vue', { install: 'npm', build: { script: 'build' }, outputDir: 'dist' }),
  p('svelte', 'Svelte', 'static', 'Svelte', { install: 'npm', build: { script: 'build' }, outputDir: 'build' }),
  p('static-files', 'Static files', 'static', null, { outputDir: '.', spaFallback: false, scaffold: true }),
  p('flask', 'Flask', 'python', 'Flask', { install: 'pip', start: { mode: 'gunicorn', module: 'app:app', workers: 2 }, scaffold: true }),
  p('django', 'Django', 'python', 'Django', { install: 'pip', start: { mode: 'gunicorn', module: '<project>.wsgi:application', workers: 2 } }),
  p('fastapi', 'FastAPI', 'python', 'FastAPI', { install: 'pip', start: { mode: 'uvicorn', module: 'main:app' }, scaffold: true }),
  p('python-custom', 'Python (custom)', 'python', null, { install: 'pip', start: { mode: 'file', entry: 'main.py' } }),
];
const by = (id) => PRESETS.find((x) => x.id === id);

const RUNTIMES = {
  node: [
    { version: '18.19.0', bin: '/usr/bin/node', npm: '/usr/bin/npm', source: 'system', path: '/usr/bin', managed: false, missing: false, apps: 2, default: true },
    { version: '20.11.0', bin: '/opt/whm/runtimes/node/20.11.0/bin/node', npm: '/opt/whm/runtimes/node/20.11.0/bin/npm', source: 'managed', path: '/opt/whm/runtimes/node/20.11.0', managed: true, missing: false, apps: 0, default: false, installedAt: '2026-10-28 10:00:00' },
  ],
  python: [{ version: '3.12.3', bin: '/usr/bin/python3', source: 'system', venv: true, default: true }],
  git: { installed: true, version: '2.43.0' }, arch: 'x64', defaults: { node: 'system', python: 'system' }, error: null,
  policy: { portRange: [30000, 39999], allowResellers: true, defaultMemoryMb: 512 },
  capabilities: { apache: true, systemd: true, node: true, python: true, git: true, acl: false },
};

const app = (over = {}) => ({
  id: 7, name: 'Shop API', kind: 'node', preset: 'nestjs', username: 'alice', domain: 'alice.example', basePath: '/api', root: '/home/alice/apps/shop-api', url: 'https://alice.example/api', port: 30001, mode: 'production',
  runtime: { kind: 'node', version: '20.11.0', bin: '/opt/whm/runtimes/node/20.11.0/bin/node' }, status: 'running', lastError: null, lastJobId: 12, unit: 'whm-app-7', proxyPath: '/etc/apache2/whm-apps/alice.example.conf',
  websockets: true, spaFallback: false, limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 }, source: { type: 'git', url: 'https://github.com/alice/shop.git', ref: 'main' },
  start: { mode: 'file', entry: 'dist/main.js' }, build: { install: 'npm', script: 'build', optional: false, outputDir: null, extraPackages: [] }, env: { DATABASE_URL: 'postgres://x' },
  createdAt: '2026-10-28 09:00:00', updatedAt: '2026-10-28 09:30:00', ...over,
});

describe('preset catalog', () => {
  it('renders a card for every preset with the fields it sets and a Use button', () => {
    const html = render(<PresetCatalog presets={PRESETS} onUse={() => {}} />);
    for (const preset of PRESETS) expect(html, preset.id).toContain(preset.label);
    expect(html.match(/Use template/g)).toHaveLength(PRESETS.length);
    expect(html).toContain('dist/&lt;project&gt;/browser');
    expect(html).toContain('gunicorn app:app (2 workers)');
    expect(html).toContain('can create a starter project');
    expect(presetFields(by('react-vite')).map(([k]) => k)).toEqual(['Kind', 'Install', 'Build', 'Serves', 'SPA fallback']);
    expect(presetFields(by('express')).map(([k]) => k)).toEqual(['Kind', 'Install', 'Build', 'Start', 'Websockets', 'Scaffold']);
  });

  it('shows the selectable cards of one kind, falling back to ids while the catalog loads', () => {
    const html = render(<PresetCards presets={PRESETS} kind="python" value="flask" onChange={() => {}} />);
    expect(html).toContain('Flask');
    expect(html).toContain('FastAPI');
    expect(html).not.toContain('Express');
    expect(html).toContain('aria-checked="true"');
    const fallback = render(<PresetCards presets={[]} kind="static" value={null} onChange={() => {}} loading />);
    for (const f of FALLBACK_PRESETS.filter((x) => x.kind === 'static')) expect(fallback).toContain(f.label);
    expect(fallback).not.toContain('NestJS');
  });
});

describe('create form', () => {
  it('prefills step 2 from a preset and renders the prefilled fields', () => {
    const form = applyPreset(emptyForm({ name: 'Shop API' }), by('nestjs'));
    expect(form.kind).toBe('node');
    expect(form.preset).toBe('nestjs');
    expect(form.start).toMatchObject({ mode: 'file', entry: 'dist/main.js' });
    expect(form.build).toMatchObject({ install: 'npm', script: 'build', optional: false });
    expect(form.websockets).toBe(true);
    const html = render(<StepWhat form={form} setForm={() => {}} presets={PRESETS} runtimes={RUNTIMES} />);
    expect(html).toContain('value="dist/main.js"');
    expect(html).toContain('value="build"');
    expect(html).toContain('Node.js 20.11.0 (managed)');
    expect(html).toContain('System Node.js 18.19.0');
    expect(html).not.toContain('Create a starter');

    const vite = applyPreset(form, by('react-vite'));
    expect(vite.kind).toBe('static');
    expect(vite.build.outputDir).toBe('dist');
    expect(vite.spaFallback).toBe(true);
    expect(vite.websockets).toBe(false);
    expect(render(<StepWhat form={vite} setForm={() => {}} presets={PRESETS} runtimes={RUNTIMES} />)).toContain('value="dist"');

    const flask = applyPreset(form, by('flask'));
    expect(flask.start).toMatchObject({ mode: 'gunicorn', module: 'app:app', workers: 2 });
    expect(render(<StepWhat form={flask} setForm={() => {}} presets={PRESETS} runtimes={RUNTIMES} />)).toContain('Create a starter Flask project');
  });

  it('switching the kind resets the preset-driven fields', () => {
    const form = applyKind(applyPreset(emptyForm(), by('nestjs')), 'python');
    expect(form.preset).toBeNull();
    expect(form.start.mode).toBe('file');
    expect(form.build.install).toBe('pip');
    expect(form.websockets).toBe(true);
  });

  it('builds the POST /apps body with only the fields the server schema takes', () => {
    let form = applyPreset(emptyForm({ name: ' Shop API ', username: 'alice', domain: 'alice.example', basePath: '/api', root: '/home/alice/apps/shop-api' }), by('nestjs'));
    form = { ...form, runtimeVersion: '20.11.0', env: [{ key: 'DATABASE_URL', value: 'postgres://x' }, { key: '', value: '' }], source: 'git', gitUrl: 'https://github.com/alice/shop.git', gitRef: 'main' };
    expect(buildCreatePayload(form)).toEqual({
      username: 'alice', name: 'Shop API', kind: 'node', preset: 'nestjs', domain: 'alice.example', basePath: '/api', root: '/home/alice/apps/shop-api', mode: 'production',
      start: { mode: 'file', entry: 'dist/main.js' }, build: { install: 'npm', script: 'build', optional: false }, runtimeVersion: '20.11.0',
      env: { DATABASE_URL: 'postgres://x' }, websockets: true, limits: { memoryMaxMb: 512, tasksMax: 256, cpuQuotaPercent: 100 },
      source: { type: 'git', url: 'https://github.com/alice/shop.git', ref: 'main' },
    });
    const flask = { ...applyPreset(form, by('flask')), source: 'scaffold', build: { install: 'pip', extraPackages: 'psycopg2-binary, redis' } };
    const body = buildCreatePayload(flask);
    expect(body.start).toEqual({ mode: 'gunicorn', module: 'app:app', workers: 2 });
    expect(body.build).toEqual({ install: 'pip', extraPackages: ['psycopg2-binary', 'redis'] });
    expect(body.source).toEqual({ type: 'scaffold', template: 'flask' });
    expect(body.runtimeVersion).toBe('system');
    expect(body.websockets).toBe(true);
    expect(body.spaFallback).toBeUndefined();
    const files = buildCreatePayload({ ...applyPreset(form, by('static-files')), source: 'upload' });
    expect(files.build).toEqual({ install: null, script: null, outputDir: '.' });
    expect(files.runtimeVersion).toBeUndefined();
    expect(files.start).toBeUndefined();
    expect(files.spaFallback).toBe(false);
  });

  it('validates each step before Next', () => {
    const blank = emptyForm();
    expect(stepErrors(1, blank)).toContain('Give the application a name');
    expect(stepErrors(1, { ...blank, name: 'x', username: 'alice', domain: 'alice.example', basePath: '/a/../b', root: '/home/alice/apps/x' })).toContain('The base path must look like / or /api');
    expect(stepErrors(1, { ...blank, name: 'x', username: 'alice', domain: 'alice.example', root: 'apps/x' }).some((e) => e.includes('absolute'))).toBe(true);
    expect(stepErrors(2, { ...applyPreset(blank, by('django')) })[0]).toContain('<project>');
    expect(stepErrors(2, { ...applyPreset(blank, by('express')), source: 'git', gitUrl: 'git@github.com:a/b.git' })[0]).toContain('https://');
    expect(stepErrors(2, { ...applyPreset(blank, by('express')), source: 'git', gitUrl: 'https://user:pw@github.com/a/b.git' })[0]).toContain('https://');
    expect(stepErrors(2, { ...applyPreset(blank, by('express')), source: 'git', gitUrl: 'https://github.com/a/b.git' })).toEqual([]);
    expect(stepErrors(3, { ...blank, env: [{ key: 'bad-key', value: '1' }] })[0]).toContain('bad-key');
    expect(suggestRoot({ home: '/home/alice', kind: 'node', name: 'Shop API!' })).toBe('/home/alice/apps/shop-api');
    expect(suggestRoot({ home: '/home/alice', kind: 'static', name: '' })).toBe('/home/alice/public_html/app');
    expect(runtimeOptions('python', RUNTIMES).map((o) => o.value)).toEqual(['system', '3.12']);
  });
});

describe('environment editor', () => {
  it('round-trips rows, rejects bad names and parses dotenv text', () => {
    const rows = envToRows({ A: '1', B_2: 'two' });
    expect(rowsToEnv([...rows, { key: ' ', value: 'ignored' }])).toEqual({ A: '1', B_2: 'two' });
    expect(envErrors([{ key: 'A', value: '1' }, { key: 'A', value: '2' }])[0]).toContain('set twice');
    expect(envErrors([{ key: 'ok', value: 'x' }])[0]).toContain('not a valid name');
    expect(envErrors([{ key: 'MULTI', value: 'a\nb' }])[0]).toContain('single line');
    expect(parseDotenv('# comment\nexport FOO="bar baz"\nEMPTY=\nBROKEN\nX=\'q\'')).toEqual([{ key: 'FOO', value: 'bar baz' }, { key: 'EMPTY', value: '' }, { key: 'X', value: 'q' }]);
    const html = render(<EnvEditor rows={rows} onChange={() => {}} />);
    expect(html).toContain('value="B_2"');
    expect(html).toContain('Add variable');
    expect(html).toContain('redacted in the audit log');
  });
});

describe('applications table', () => {
  const rows = [
    app(),
    app({ id: 8, name: 'Blog', kind: 'static', preset: 'react-vite', basePath: '/', url: 'https://alice.example/', port: null, status: 'built', unit: null, runtime: { kind: 'node', version: 'system', bin: '/usr/bin/node' }, source: { type: 'upload' }, start: {}, build: { install: 'npm', script: 'build', outputDir: 'dist' } }),
    app({ id: 9, name: 'Flaky', kind: 'python', preset: 'flask', basePath: '/flaky', status: 'failed', lastError: 'build_failed: ModuleNotFoundError', runtime: { kind: 'python', version: 'system', bin: '/usr/bin/python3' }, port: 30002 }),
    app({ id: 10, name: 'Paused', status: 'stopped', port: 30003 }),
  ];

  it('renders a status pill per row with the live state and the kind badges', () => {
    const html = render(<AppsTable rows={[{ ...rows[0], live: { active: true, pid: 4242, state: 'active' } }, ...rows.slice(1)]} actions={{}} />);
    expect(html).toContain('pill-ok">running · pid 4242');
    expect(html).toContain('pill-ok">built');
    expect(html).toContain('pill-bad">failed');
    expect(html).toContain('title="build_failed: ModuleNotFoundError"');
    expect(html).toContain('pill-warn">stopped');
    expect(html).toContain('pill-info">Node.js');
    expect(html).toContain('pill-muted">Static site');
    expect(html).toContain('href="https://alice.example/api"');
    expect(html).toContain('Node.js 20.11.0');
    expect(html).toContain('Python system');
    expect(html).toContain('30001');
    expect(render(<AppStatusPill app={app({ status: 'running' })} live={{ active: false, state: 'failed', subState: 'failed', installed: true }} />)).toContain('pill-warn">running · failed (failed)');
    expect(render(<AppStatusPill app={app({ status: 'deploying' })} />)).toContain('pill-info">deploying');
  });

  it('renders the page with its create button, capability banner and the table', () => {
    responses.clear();
    responses.set('/apps/presets', { data: PRESETS });
    responses.set('/apps/runtimes', { data: { ...RUNTIMES, capabilities: { ...RUNTIMES.capabilities, python: false } } });
    responses.set('/apps', { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } });
    const fn = FUNCTION_BY_KEY['application-manager/application-manager'];
    expect(fn).toBeTruthy();
    const html = render(<ApplicationManager fn={fn} />);
    expect(html).toContain('Create application');
    expect(html).toContain('4 applications');
    expect(html).toContain('Shop API');
    expect(html).toContain('Some runtimes are missing');
    expect(html).toContain('python3-venv');
    expect(html).not.toContain('cannot be deployed');
    responses.set('/apps/runtimes', { data: { ...RUNTIMES, capabilities: { ...RUNTIMES.capabilities, apache: false } } });
    const blocked = render(<ApplicationManager fn={fn} />);
    expect(blocked).toContain('Applications cannot be deployed on this host yet');
    expect(blocked).toContain('disabled=""');
  });

  it('shows the overview with the live process and the last error', () => {
    const html = render(<AppOverview app={{ ...app({ status: 'failed', lastError: 'npm run build exited 1' }), live: { installed: true, active: false, state: 'failed', subState: 'failed', pid: null, restarts: 3 } }} />);
    expect(html).toContain('npm run build exited 1');
    expect(html).toContain('3 restarts');
    expect(html).toContain('git https://github.com/alice/shop.git @ main');
    expect(html).toContain('node dist/main.js');
    expect(html).toContain('127.0.0.1:30001');
    expect(html).toContain('/etc/apache2/whm-apps/alice.example.conf');
  });

  it('sends only the changed settings on PUT', () => {
    const a = app();
    const base = { name: a.name, mode: a.mode, runtimeVersion: '20.11.0', start: { mode: 'file', entry: 'dist/main.js', script: '', module: '', workers: 2 }, build: { install: 'npm', script: 'build', optional: false, outputDir: '', extraPackages: '' }, websockets: true, spaFallback: false, limits: { ...a.limits } };
    expect(settingsPayload(a, base)).toEqual({});
    expect(settingsPayload(a, { ...base, name: 'Renamed', limits: { ...a.limits, memoryMaxMb: 1024 } })).toEqual({ name: 'Renamed', limits: { memoryMaxMb: 1024, tasksMax: 256, cpuQuotaPercent: 100 } });
    expect(settingsPayload(a, { ...base, start: { ...base.start, mode: 'npm-script', script: 'start' }, runtimeVersion: 'system' })).toEqual({ start: { mode: 'npm-script', script: 'start' }, runtimeVersion: 'system' });
  });
});

describe('runtime versions page', () => {
  it('lists system and managed Node.js with usage, default and remove, plus Python venv support', () => {
    responses.clear();
    responses.set('/apps/runtimes/node/available', { data: { available: [{ version: '22.11.0', lts: 'Jod', date: '2024-10-29', line: 'lts', installed: false }, { version: '20.11.0', lts: 'Iron', date: '2024-01-09', line: 'lts', installed: true }, { version: '23.1.0', lts: false, date: '2024-10-24', line: 'current', installed: false }], error: null } });
    responses.set('/apps/runtimes', { data: RUNTIMES });
    responses.set('/apps/settings', { data: RUNTIMES.policy });
    const html = render(<RuntimeVersions fn={FUNCTION_BY_KEY['application-manager/runtime-versions']} />);
    expect(html).toContain('18.19.0');
    expect(html).toContain('20.11.0');
    expect(html).toContain('/opt/whm/runtimes/node/20.11.0/bin/node');
    expect(html).toContain('2 apps');
    expect(html).toContain('Remove');
    expect(html).toContain('3.12.3');
    expect(html).toContain('pill-ok">available');
    expect(html).toContain('git 2.43.0');
    expect(html).toContain('LTS lines');
    expect(html).toContain('Jod');
    expect(html).toContain('pill-ok">installed');
    expect(html).toContain('Current');
    expect(html).toContain('Save policy');
    const table = render(<NodeRuntimeTable node={RUNTIMES.node} defaultNode="system" isRoot onDefault={() => {}} onRemove={() => {}} />);
    expect(table).toContain('checked=""');
    expect(table).toContain('>default<');
    expect(render(<AvailableNodeList available={[]} onInstall={() => {}} />)).toContain('No releases listed');
  });

  it('points at Install Distro Packages when venv support is missing', () => {
    responses.set('/apps/runtimes', { data: { ...RUNTIMES, python: [{ version: '3.10.12', bin: '/usr/bin/python3', source: 'system', venv: false, default: false }], capabilities: { ...RUNTIMES.capabilities, python: true } } });
    const html = render(<RuntimeVersions fn={FUNCTION_BY_KEY['application-manager/runtime-versions']} />);
    expect(html).toContain('pill-warn">missing');
    expect(html).toContain('href="/software/install-distro-packages"');
    expect(html).toContain('without venv support cannot run applications');
  });
});

describe('application templates page', () => {
  it('renders the built-in catalog and the custom templates table', () => {
    responses.clear();
    const custom = { id: 3, slug: 'company-api', name: 'Company API', kind: 'node', description: 'NestJS with our defaults', preset: { start: { mode: 'file', entry: 'dist/main.js' }, build: { install: 'npm', script: 'build' }, limits: { memoryMaxMb: 1024 }, runtimeVersion: '20.11.0' }, createdAt: '2026-10-28 09:00:00', updatedAt: '2026-10-28 09:00:00' };
    responses.set('/apps/presets', { data: [...PRESETS, { ...by('nestjs'), id: 'company-api', label: 'Company API', custom: true, templateId: 3 }] });
    responses.set('/apps/templates', { data: [custom] });
    const html = render(<ApplicationTemplates fn={FUNCTION_BY_KEY['application-manager/application-templates']} />);
    expect(html).toContain('Built-in presets');
    for (const preset of PRESETS) expect(html).toContain(preset.label);
    expect(html).toContain('Custom templates');
    expect(html).toContain('company-api');
    expect(html).toContain('node dist/main.js');
    expect(html).toContain('New template');
    const form = formFromTemplate(custom);
    expect(form.start).toMatchObject({ mode: 'file', entry: 'dist/main.js' });
    expect(form.limits.memoryMaxMb).toBe(1024);
    expect(form.runtimeVersion).toBe('20.11.0');
    expect(templatePayload(form)).toEqual({ slug: 'company-api', name: 'Company API', kind: 'node', description: 'NestJS with our defaults', preset: { build: { install: 'npm', script: 'build', optional: false }, mode: 'production', limits: { memoryMaxMb: 1024, tasksMax: 256, cpuQuotaPercent: 100 }, start: { mode: 'file', entry: 'dist/main.js' }, websockets: true, runtimeVersion: '20.11.0' } });
  });

  it('hides the custom templates for resellers', () => {
    authState.user = { id: 2, username: 'res', role: 'reseller' };
    responses.set('/apps/presets', { data: PRESETS });
    const html = render(<ApplicationTemplates fn={FUNCTION_BY_KEY['application-manager/application-templates']} />);
    expect(html).toContain('Built-in presets');
    expect(html).not.toContain('Custom templates');
    expect(html).not.toContain('New template');
    authState.user = { id: 1, username: 'root', role: 'root' };
  });

  it('renders the capability summary only when something is missing', () => {
    const bare = (el) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
    expect(bare(<CapabilitySummary capabilities={RUNTIMES.capabilities} />)).toBe('');
    expect(bare(<CapabilitySummary capabilities={null} />)).toBe('');
    expect(bare(<CapabilitySummary capabilities={{ ...RUNTIMES.capabilities, systemd: false }} />)).toContain('cannot be deployed');
  });
});
