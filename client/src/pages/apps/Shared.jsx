import { Link } from 'react-router-dom';
import { AlertTriangle, Info } from 'lucide-react';
import { StatusPill } from '../../components/Common.jsx';

export const KINDS = ['node', 'python', 'static'];
export const KIND_LABELS = { node: 'Node.js', python: 'Python', static: 'Static site' };
export const KIND_DESCRIPTIONS = {
  node: 'A long-running Node.js server (Express, NestJS, Next.js, Nuxt…) proxied by Apache.',
  python: 'A WSGI/ASGI server in a virtual environment (Flask, Django, FastAPI…) proxied by Apache.',
  static: 'A frontend built with npm (React, Angular, Vue, Svelte) or plain files served by Apache.',
};
const KIND_TONES = { node: 'info', python: 'ok', static: 'muted' };

export const START_MODES = {
  node: [{ value: 'file', label: 'Run a file (node <entry>)' }, { value: 'npm-script', label: 'npm run <script>' }],
  python: [{ value: 'file', label: 'Run a file (python <entry>)' }, { value: 'gunicorn', label: 'gunicorn <module> (WSGI)' }, { value: 'uvicorn', label: 'uvicorn <module> (ASGI)' }],
  static: [],
};
export const MODE_FIELD = { file: 'entry', 'npm-script': 'script', gunicorn: 'module', uvicorn: 'module' };

// Ids and labels only, shown in the step-2 cards until GET /apps/presets
// answers; the server list is the catalog.
export const FALLBACK_PRESETS = [
  { id: 'express', label: 'Express', kind: 'node' },
  { id: 'nestjs', label: 'NestJS', kind: 'node' },
  { id: 'nextjs', label: 'Next.js', kind: 'node' },
  { id: 'nuxt', label: 'Nuxt', kind: 'node' },
  { id: 'node-custom', label: 'Node.js (custom)', kind: 'node' },
  { id: 'react-vite', label: 'React (Vite)', kind: 'static' },
  { id: 'react-cra', label: 'React (Create React App)', kind: 'static' },
  { id: 'angular', label: 'Angular', kind: 'static' },
  { id: 'vue', label: 'Vue', kind: 'static' },
  { id: 'svelte', label: 'Svelte', kind: 'static' },
  { id: 'static-files', label: 'Static files', kind: 'static' },
  { id: 'flask', label: 'Flask', kind: 'python' },
  { id: 'django', label: 'Django', kind: 'python' },
  { id: 'fastapi', label: 'FastAPI', kind: 'python' },
  { id: 'python-custom', label: 'Python (custom)', kind: 'python' },
];

export function KindBadge({ kind }) {
  return <span className={`pill pill-${KIND_TONES[kind] || 'muted'}`}>{KIND_LABELS[kind] || kind}</span>;
}

const STATUS_TONE = { created: 'unknown', deploying: 'pending', running: 'running', stopped: 'stopped', failed: 'failed', built: 'ok' };

// The row status plus what systemd currently reports for the unit.
export function AppStatusPill({ app, live }) {
  const status = app?.status || 'created';
  let tone = STATUS_TONE[status] || 'unknown';
  let text = status;
  if (live && app?.kind !== 'static' && live.installed !== false) {
    if (status === 'running' && !live.active) { tone = 'warning'; text = `running · ${live.state || 'inactive'}${live.subState ? ` (${live.subState})` : ''}`; }
    else if (status === 'stopped' && live.active) { tone = 'warning'; text = 'stopped · still active'; }
    else if (live.active && live.pid) text = `${status} · pid ${live.pid}`;
  }
  return <span title={status === 'failed' && app?.lastError ? app.lastError : undefined}><StatusPill status={tone}>{text}</StatusPill></span>;
}

export function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function homeOf(account) {
  if (!account) return '';
  return account.home_dir || account.home || (account.username ? `/home/${account.username}` : '');
}

// Node/Python apps live outside the docroot; static builds may sit under it.
export function suggestRoot({ home, kind, name }) {
  if (!home) return '';
  return `${home}/${kind === 'static' ? 'public_html' : 'apps'}/${slugify(name) || 'app'}`;
}

export function runtimeLabel(app) {
  const r = app?.runtime;
  if (!r?.kind) return null;
  return `${KIND_LABELS[r.kind] || r.kind} ${r.version || 'system'}`;
}

export function sourceLabel(source) {
  if (!source || source.type === 'upload') return 'Uploaded files';
  if (source.type === 'git') return `git ${source.url}${source.ref ? ` @ ${source.ref}` : ''}`;
  if (source.type === 'scaffold') return `Scaffold "${source.template}"`;
  return source.type;
}

export function startLabel(start, kind) {
  if (!start?.mode) return null;
  if (start.mode === 'file') return `${kind === 'python' ? 'python' : 'node'} ${start.entry || '?'}`;
  if (start.mode === 'npm-script') return `npm run ${start.script || '?'}`;
  if (start.mode === 'gunicorn') return `gunicorn ${start.module || '?'}${start.workers ? ` (${start.workers} workers)` : ''}`;
  if (start.mode === 'uvicorn') return `uvicorn ${start.module || '?'}`;
  return start.mode;
}

export function formatMemory(bytes) {
  if (bytes == null) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const CAPABILITY_TEXT = {
  apache: 'Apache (publishes applications through the account vhost)',
  systemd: 'systemd (runs Node.js and Python applications as services)',
  node: 'Node.js (install the nodejs package, or a managed version under Runtime Versions)',
  python: 'Python 3 with venv support (python3, python3-venv, python3-pip)',
  git: 'git (deploy from a repository)',
};

// Missing daemons/runtimes as reported by GET /apps/runtimes.
export function CapabilitySummary({ capabilities }) {
  if (!capabilities) return null;
  const missing = Object.keys(CAPABILITY_TEXT).filter((k) => capabilities[k] === false);
  if (!missing.length) return null;
  const blocking = missing.includes('apache') || missing.includes('systemd');
  return (
    <div className={`banner ${blocking ? 'banner-warning' : 'banner-info'}`}>
      {blocking ? <AlertTriangle size={18} /> : <Info size={18} />}
      <div>
        <strong>{blocking ? 'Applications cannot be deployed on this host yet' : 'Some runtimes are missing on this host'}</strong>
        <ul>{missing.map((k) => <li key={k}>{CAPABILITY_TEXT[k]}</li>)}</ul>
        <p className="muted">Install the missing software with <Link to="/software/install-distro-packages">Install Distro Packages</Link>{missing.includes('node') && <> or add a managed Node.js under <Link to="/application-manager/runtime-versions">Runtime Versions</Link></>}. Pages keep working; deployments refuse until it is present.</p>
      </div>
    </div>
  );
}
