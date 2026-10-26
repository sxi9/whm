import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { Button, FormActions, ErrorBanner, Field, Select } from '../../components/Form.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

// Error display that distinguishes "install the daemon" from real failures.
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="row-actions" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={`btn btn-sm ${value === t.value ? 'btn-primary' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="pill pill-muted" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// GET <path> → { settings, ... }; PUT <path> with only the changed keys. A 501
// means "saved, daemon missing": the page keeps the draft and shows the notice.
export function useSettingsForm(path, { putPath = path, onSaved, confirm } = {}) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi(path);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [capError, setCapError] = useState(null);
  const [applied, setApplied] = useState(null);

  useEffect(() => { if (data?.settings) setDraft(data.settings); }, [data]);
  const base = data?.settings || null;
  const dirty = useMemo(() => Boolean(draft && base && JSON.stringify(draft) !== JSON.stringify(base)), [draft, base]);
  const set = useCallback((k) => (v) => setDraft((d) => ({ ...d, [k]: v })), []);
  const patch = useCallback((obj) => setDraft((d) => ({ ...d, ...obj })), []);

  const save = async (extra = {}) => {
    if (!draft || !base) return null;
    if (confirm && !(await confirm(draft, base))) return null;
    const changed = {};
    for (const k of Object.keys(draft)) if (JSON.stringify(draft[k]) !== JSON.stringify(base[k])) changed[k] = draft[k];
    setSaving(true); setSaveError(null); setCapError(null);
    try {
      const { data: d } = await api.put(putPath, { ...changed, ...extra });
      setApplied(d.applied ?? null);
      toast.success('Settings saved and applied');
      await refetch();
      onSaved?.(d);
      return d;
    } catch (err) {
      if (err.status === 501 || err.code === 'capability_missing') { setCapError(err); toast.warning('Settings saved; the daemon is not installed so nothing was applied'); await refetch(); return null; }
      setSaveError(err); toast.error(err); return null;
    } finally { setSaving(false); }
  };

  return { data, loading, error, refetch, draft, setDraft, set, patch, base, dirty, saving, saveError, capError, applied, save, reset: () => setDraft(base) };
}

export function SaveBar({ form, label = 'Save and apply', disabled = false, children }) {
  return (
    <div className="sticky-actions">
      <ErrorBanner error={form.saveError} />
      <CapabilityNotice error={form.capError} onRetry={form.refetch} />
      <FormActions>
        <Button variant="primary" loading={form.saving} disabled={!form.dirty || disabled} onClick={() => form.save()}>{label}</Button>
        <Button disabled={!form.dirty || form.saving} onClick={form.reset}>Reset</Button>
        {children}
      </FormActions>
    </div>
  );
}

export function DaemonNotice({ installed, message, onRetry }) {
  if (installed) return null;
  return <CapabilityNotice error={{ code: 'capability_missing', message }} onRetry={onRetry} />;
}

export function LastApply({ apply, label = 'Last apply' }) {
  if (!apply) return <StatusPill status="pending">never applied</StatusPill>;
  return <StatusPill status={apply.ok ? 'ok' : 'failed'}>{label}: {apply.ok ? 'ok' : apply.error || 'failed'} · {formatDate(apply.at)}</StatusPill>;
}

export function UnitPill({ unit }) {
  if (!unit || !unit.present) return <StatusPill status="not-installed">no unit</StatusPill>;
  return <StatusPill status={unit.active ? 'active' : 'inactive'}>{unit.unit}: {unit.state}{unit.subState ? ` (${unit.subState})` : ''}{unit.enabled ? ' · enabled' : ''}</StatusPill>;
}

export function Preview({ title = 'Generated configuration', text, path, note }) {
  return (
    <Card title={title} subtitle={path ? `Written to ${path}` : undefined}>
      {note && <p className="muted">{note}</p>}
      <pre className="log">{text || '(empty)'}</pre>
    </Card>
  );
}

export function Hints({ hints }) {
  if (!hints?.length) return null;
  return <div className="banner banner-info"><div><strong>Manual step required on this layout</strong><ul>{hints.map((h) => <li key={h}><code>{h}</code></li>)}</ul></div></div>;
}

export function TriSelect({ label, help, value, onChange, options }) {
  return <Field label={label} help={help}><Select value={value ?? ''} onChange={onChange} options={options} /></Field>;
}

export function ToggleList({ options, value = [], onChange }) {
  return (
    <div className="row-actions" style={{ flexWrap: 'wrap', gap: 10 }}>
      {options.map((o) => (
        <label key={o.value} className="radio" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(value.includes(o.value) ? value.filter((x) => x !== o.value) : [...value, o.value])} />
          <span><strong>{o.label}</strong>{o.description && <small>{o.description}</small>}</span>
        </label>
      ))}
    </div>
  );
}

export function ListEditor({ value = [], onChange, placeholder, help }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => { setText(value.join('\n')); }, [value]);
  return (
    <div>
      <textarea className="input textarea mono" rows={Math.min(8, Math.max(3, value.length + 1))} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean))} />
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}

// Daemon chooser shared by FTP Server Selection and Nameserver Selection.
export function DaemonSelector({ candidates, current, selected, onSelect, busy, pkgAvailable, disabledLabel, packageManager }) {
  const [choice, setChoice] = useState(selected || current || 'disabled');
  const [install, setInstall] = useState(false);
  useEffect(() => { setChoice(selected || current || 'disabled'); }, [selected, current]);
  const chosen = candidates.find((c) => c.name === choice);
  const needsInstall = chosen && !chosen.unitName;
  const pm = (packageManager || 'apt-get').replace('-get', '');
  return (
    <div>
      <div className="radio-group">
        {candidates.map((c) => (
          <label key={c.name} className="radio">
            <input type="radio" name="daemon" checked={choice === c.name} onChange={() => setChoice(c.name)} />
            <span>
              <strong>{c.label} {c.unit?.active && <StatusPill status="active">running</StatusPill>} {!c.unit?.active && c.unitName && <StatusPill status="inactive">installed</StatusPill>} {!c.unitName && <StatusPill status="not-installed">not installed · package {c.packages?.[pm] || c.packages?.apt}</StatusPill>}</strong>
              <small>{c.unitName ? `systemd unit ${c.unitName}${c.unit?.enabled ? ', starts at boot' : ''}` : 'Not present on this server'}</small>
            </span>
          </label>
        ))}
        <label className="radio">
          <input type="radio" name="daemon" checked={choice === 'disabled'} onChange={() => setChoice('disabled')} />
          <span><strong>{disabledLabel}</strong><small>Stop and disable every daemon for this role.</small></span>
        </label>
      </div>
      {needsInstall && (
        <Field inline>
          <label className="toggle"><input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} disabled={!pkgAvailable} /><span className="toggle-track"><span className="toggle-thumb" /></span>
            <span className="toggle-text"><span className="toggle-label">Install {chosen.label} first ({chosen.packages?.[pm] || chosen.packages?.apt})</span><span className="toggle-description">{pkgAvailable ? 'Queues a package-manager job; select again once it finishes.' : 'The Software category is not loaded; install the package manually.'}</span></span>
          </label>
        </Field>
      )}
      <FormActions>
        <Button variant="primary" loading={busy} disabled={choice === (current || 'disabled') && !needsInstall} onClick={() => onSelect(choice, install)}>{needsInstall && install ? `Install and select ${chosen.label}` : choice === 'disabled' ? disabledLabel : `Use ${chosen?.label || choice}`}</Button>
      </FormActions>
    </div>
  );
}

export function JobCard({ jobId, title = 'Installation job', onFinished }) {
  if (!jobId) return null;
  return (
    <Card title={title} subtitle={<span>Also visible in <Link to="/server-status/task-queue-monitor">Task Queue Monitor</Link></span>}>
      <ProgressLog jobId={jobId} onFinished={onFinished} />
    </Card>
  );
}

export function StepList({ steps }) {
  if (!steps?.length) return null;
  return <ul className="small">{steps.map((s, i) => <li key={i}><code>systemctl {s.action} {s.unit}</code> — {s.ok ? <StatusPill status="ok">ok</StatusPill> : <StatusPill status="failed">{s.error}</StatusPill>}</li>)}</ul>;
}
