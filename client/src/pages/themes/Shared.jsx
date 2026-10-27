import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, CapabilityNotice } from '../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Textarea, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { applyTheme, notifyThemeChanged } from '../../theme/applyTheme.js';

const isCapabilityError = (error) => Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');

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

export const BASES = [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

// Every theme plus the defaults; the Theme Manager tabs all start from this.
export function useThemes() {
  const res = useApi('/themes');
  const themes = res.data || [];
  return {
    ...res, themes,
    defaultSlug: themes.find((t) => t.isDefault)?.slug || res.meta?.default || 'jupiter',
    accountDefault: themes.find((t) => t.isAccountDefault)?.slug || res.meta?.accountDefault || 'jupiter',
    allowUserOverride: res.meta?.allowUserOverride !== false,
    catalog: res.meta?.variables || {},
  };
}

export function ThemeSelect({ value, onChange, themes, filter = () => true, placeholder = 'Choose a theme…', ...rest }) {
  const options = (themes || []).filter(filter).map((t) => ({ value: t.slug, label: `${t.name} (${t.slug})${t.builtin ? ' · built-in' : ''}${t.enabled ? '' : ' · disabled'}` }));
  return <Select value={value} onChange={onChange} options={options} placeholder={placeholder} {...rest} />;
}

export function ThemePills({ theme }) {
  if (!theme) return null;
  return (
    <span className="row-actions" style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
      {theme.builtin && <StatusPill status="info">built-in</StatusPill>}
      {theme.isDefault && <StatusPill status="ok">panel default</StatusPill>}
      {theme.isAccountDefault && <StatusPill status="ok">account default</StatusPill>}
      {theme.hasCss && <StatusPill status="info">custom CSS</StatusPill>}
      <StatusPill status={theme.enabled ? 'enabled' : 'disabled'} />
    </span>
  );
}

// A five-colour strip that previews a theme's palette without applying it.
const BASE_DEFAULTS = {
  light: { chrome: '#0f1a24', bg: '#f3f5f7', surface: '#ffffff', primary: '#1b8fc9', text: '#1f2a37' },
  dark: { chrome: '#0f1a24', bg: '#0f151b', surface: '#161e26', primary: '#1b8fc9', text: '#e6edf3' },
};
export function ThemeSwatch({ theme, size = 18 }) {
  const defaults = BASE_DEFAULTS[theme?.base] || BASE_DEFAULTS.light;
  const v = { ...defaults, ...(theme?.variables || {}) };
  return (
    <span className="row-actions" aria-hidden style={{ gap: 2 }}>
      {['chrome', 'bg', 'surface', 'primary', 'text'].map((k) => <span key={k} title={`--${k}: ${v[k]}`} style={{ width: size, height: size, borderRadius: 4, border: '1px solid var(--border-strong)', background: v[k], display: 'inline-block' }} />)}
    </span>
  );
}

const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

// Grouped editor for the design tokens a theme can override. `value` only holds overrides.
export function VariableEditor({ catalog, value, onChange, errors }) {
  const groups = useMemo(() => {
    const out = {};
    for (const [key, def] of Object.entries(catalog || {})) (out[def.group] ||= []).push({ key, ...def });
    return out;
  }, [catalog]);
  const set = (key, v) => onChange({ ...value, [key]: v });
  const clear = (key) => { const next = { ...value }; delete next[key]; onChange(next); };
  return (
    <div className="form-grid">
      {Object.entries(groups).map(([group, defs]) => (
        <div key={group}>
          <h3 style={{ margin: '8px 0' }}>{group}</h3>
          {defs.map((def) => {
            const v = value[def.key] ?? '';
            return (
              <Field key={def.key} label={<span>{def.label} <code className="small">--{def.key}</code></span>} error={errors?.[def.key]}>
                <div className="row-actions" style={{ justifyContent: 'flex-start', gap: 6 }}>
                  {def.kind === 'color' && <input type="color" aria-label={`${def.label} picker`} value={isHex(v) ? v.toLowerCase() : '#888888'} onChange={(e) => set(def.key, e.target.value)} style={{ width: 36, height: 30, padding: 0, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent' }} />}
                  <TextInput value={v} onChange={(x) => set(def.key, x)} placeholder={def.kind === 'color' ? 'inherit from base' : 'inherit (e.g. 6px)'} style={{ maxWidth: 220 }} />
                  {v !== '' && <Button size="sm" variant="ghost" onClick={() => clear(def.key)}>Reset</Button>}
                </div>
              </Field>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Live preview: paints the draft on the page while on, restores the active theme when off/unmounted.
export function usePreview() {
  const [on, setOn] = useState(false);
  const last = useRef(null);
  useEffect(() => () => { if (last.current) notifyThemeChanged(); }, []);
  const show = (theme) => { last.current = theme; applyTheme(theme); };
  const stop = () => { setOn(false); if (last.current) { last.current = null; notifyThemeChanged(); } };
  return { on, start: (theme) => { setOn(true); show(theme); }, update: (theme) => { if (on) show(theme); }, stop };
}

export function PreviewButton({ preview, theme }) {
  return preview.on
    ? <Button icon={EyeOff} onClick={preview.stop}>Stop preview</Button>
    : <Button icon={Eye} onClick={() => preview.start(theme)}>Preview on this page</Button>;
}

// Name / base / enabled / tokens / CSS for a custom theme. `theme` is the server record.
// Built-in themes and viewers who cannot edit (resellers) get a read-only form with preview.
export function ThemeEditor({ theme, catalog, onSaved, onClose, readOnly: forceReadOnly = false }) {
  const toast = useToast();
  const preview = usePreview();
  const [form, setForm] = useState({ name: theme.name, base: theme.base, enabled: theme.enabled, variables: { ...theme.variables } });
  const [css, setCss] = useState(theme.css || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const readOnly = Boolean(theme.builtin) || forceReadOnly;

  // A changed base scheme drops the stock theme's OS-following behaviour in the preview.
  const paint = (base, variables, cssText) => ({ ...theme, base, scheme: base === theme.base ? theme.scheme : undefined, variables, css: cssText });
  const draft = () => paint(form.base, form.variables, css);
  const update = (patch) => { const next = { ...form, ...patch }; setForm(next); preview.update(paint(next.base, next.variables, css)); };
  const updateCss = (v) => { setCss(v); preview.update(paint(form.base, form.variables, v)); };

  const pickFile = async (file) => {
    if (!file) return;
    if (file.size > 256 * 1024) { toast.error('CSS files are limited to 256 KB'); return; }
    updateCss(await file.text());
  };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      let saved = (await api.put(`/themes/${theme.slug}`, { name: form.name, base: form.base, enabled: form.enabled, variables: form.variables })).data;
      if (css !== (theme.css || '')) {
        saved = css.trim() ? (await api.put(`/themes/${theme.slug}/css`, { css })).data : (await api.delete(`/themes/${theme.slug}/css`)).data;
      }
      toast.success(`Theme "${saved.name}" saved`);
      preview.stop();
      notifyThemeChanged();
      onSaved?.(saved);
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <>
      {readOnly && <div className="banner banner-info"><div>{theme.builtin ? 'Built-in themes are read-only. Copy this theme from the list to customise it.' : 'Only root can change themes; you can inspect and preview this one.'}</div></div>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-grid">
        <Field label="Name" required error={error?.fields?.name}><TextInput value={form.name} onChange={(v) => update({ name: v })} /></Field>
        <Field label="Base scheme" help="Dark bases start from the dark token set; tokens below override either."><Select value={form.base} onChange={(v) => update({ base: v })} options={BASES} /></Field>
        <Field label="Availability"><Toggle checked={form.enabled} onChange={(v) => update({ enabled: v })} label={form.enabled ? 'Enabled: users and packages may pick it' : 'Disabled: hidden from users and packages'} /></Field>
      </div>
      <h2 style={{ margin: '12px 0 4px' }}>Design tokens</h2>
      <p className="muted">Leave a token empty to inherit the base scheme. Values are validated as colours (hex, rgb(), hsl() or a named colour) or pixel lengths.</p>
      <VariableEditor catalog={catalog} value={form.variables} onChange={(v) => update({ variables: v })} errors={error?.fields} />
      <h2 style={{ margin: '16px 0 4px' }}>CSS override</h2>
      <p className="muted">Served to every panel user with this theme, so <code>@import</code>, remote <code>url()</code> targets, quoted remote addresses (as in <code>image-set()</code> or <code>src()</code>) and script-like constructs are refused, including when written with CSS escape sequences. Relative paths and <code>data:image/</code> resources are fine. Stored under the panel data directory.</p>
      <Field error={error?.fields?.css}>
        <Textarea value={css} onChange={updateCss} rows={10} mono spellCheck={false} placeholder={'.brand-mark { background: #ff6600; }'} />
      </Field>
      <FormActions>
        <input ref={fileRef} type="file" accept=".css,text/css" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Button icon={Upload} onClick={() => fileRef.current?.click()}>Upload .css file</Button>
        {css && <Button variant="ghost" onClick={() => updateCss('')}>Clear CSS</Button>}
      </FormActions>
      </fieldset>
      <ErrorBanner error={error} />
      <FormActions>
        {!readOnly && <Button variant="primary" loading={saving} onClick={save}>Save theme</Button>}
        <PreviewButton preview={preview} theme={draft()} />
        <Button onClick={() => { preview.stop(); onClose?.(); }}>Close</Button>
      </FormActions>
    </>
  );
}
