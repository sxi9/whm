import { StatusPill } from '../../../../components/Common.jsx';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../../panel/PanelPage.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function RequestError({ error, fn, onRetry }) {
  if (!error) return null;
  if (error.status === 403 && error.code === 'feature_disabled') return <FeatureDisabledState fn={fn} />;
  if (isCapabilityError(error)) return <PanelCapabilityState error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export const WEB_TYPES = ['main', 'addon', 'sub'];

export function TypePill({ type }) {
  const label = { main: 'main', addon: 'addon', sub: 'subdomain' };
  return <StatusPill status="unknown">{label[type] || type}</StatusPill>;
}

// The host's answer for a per-domain change: 'applied' reached the web server,
// anything else ('recorded', 'failed: …') is a change waiting for it.
export function webResult(web) {
  if (web === 'applied') return { applied: true };
  return { applied: false, reason: typeof web === 'string' && web ? web.replace(/^failed:\s*/, '') : 'pending' };
}

export function WebStatus({ web }) {
  const r = webResult(web);
  return r.applied ? <StatusPill status="ok">applied</StatusPill> : <PendingPill result={r} />;
}

export function AdvisoryPill({ advisories }) {
  const list = advisories || [];
  if (!list.length) return null;
  const worst = list.find((a) => a.severity === 'critical') || list.find((a) => a.severity === 'high') || list[0];
  const tone = worst.severity === 'critical' || worst.severity === 'high' ? 'failed' : 'warning';
  return <StatusPill status={tone}>{list.length === 1 ? 'security advisory' : `${list.length} security advisories`}</StatusPill>;
}

// Mirrors the server's BASIC_DIRECTIVES (services/software.js): the panel API
// returns their values under `basic` but not their types or help.
export const DIRECTIVES = [
  { key: 'allow_url_fopen', type: 'bool', help: 'Let PHP open remote URLs with fopen() and file_get_contents().' },
  { key: 'allow_url_include', type: 'bool', help: 'Let include and require load remote files. Keep off.' },
  { key: 'date.timezone', type: 'text', help: 'Default timezone, for example UTC or Europe/Berlin.' },
  { key: 'disable_functions', type: 'text', help: 'Comma-separated functions PHP refuses to run (exec, shell_exec, …).' },
  { key: 'display_errors', type: 'bool', help: 'Print errors to the page. Off for a live site.' },
  { key: 'enable_dl', type: 'bool', help: 'Allow dl() to load extensions at runtime.' },
  { key: 'error_log', type: 'text', help: 'File PHP writes errors to (empty = the server log).' },
  { key: 'error_reporting', type: 'text', help: 'For example E_ALL & ~E_DEPRECATED & ~E_STRICT.' },
  { key: 'file_uploads', type: 'bool', help: 'Allow HTTP file uploads.' },
  { key: 'include_path', type: 'text', help: 'Directories searched by include and require.' },
  { key: 'log_errors', type: 'bool', help: 'Log errors to error_log.' },
  { key: 'mail.add_x_header', type: 'bool', help: 'Add X-PHP-Originating-Script to mail() messages.' },
  { key: 'max_execution_time', type: 'int', help: 'Seconds a script may run.' },
  { key: 'max_input_time', type: 'int', help: 'Seconds to parse request data (-1 = unlimited).' },
  { key: 'max_input_vars', type: 'int', help: 'Maximum GET, POST and COOKIE variables.' },
  { key: 'memory_limit', type: 'size', help: 'Per-script memory cap, for example 256M.' },
  { key: 'output_buffering', type: 'text', help: 'Off, On or a byte size such as 4096.' },
  { key: 'post_max_size', type: 'size', help: 'Maximum POST body, for example 64M (must exceed upload_max_filesize).' },
  { key: 'session.gc_maxlifetime', type: 'int', help: 'Seconds before idle session data may be collected.' },
  { key: 'session.save_path', type: 'text', help: 'Where session files are stored.' },
  { key: 'short_open_tag', type: 'bool', help: 'Allow <? as a PHP open tag.' },
  { key: 'upload_max_filesize', type: 'size', help: 'Largest single uploaded file, for example 32M.' },
  { key: 'max_file_uploads', type: 'int', help: 'Files per request.' },
  { key: 'zlib.output_compression', type: 'bool', help: 'Compress output with zlib.' },
];

export const DIRECTIVE_KEYS = new Set(DIRECTIVES.map((d) => d.key));
export const INI_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
export const INI_VALUE_RE = /^[^\r\n\0]*$/;

// The PUT body: every directive whose draft differs from the saved value;
// an empty draft removes the directive.
export function changedDirectives(saved, draft) {
  const out = {};
  const keys = new Set([...Object.keys(saved || {}), ...Object.keys(draft || {})]);
  for (const k of keys) {
    const before = saved?.[k] ?? '';
    const after = draft?.[k] ?? '';
    if (String(before) !== String(after)) out[k] = after === '' ? null : String(after);
  }
  return out;
}
