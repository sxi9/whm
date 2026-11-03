import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Info, Upload } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, CapabilityNotice } from '../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Textarea, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { applyTheme, notifyThemeChanged } from '../../theme/applyTheme.js';
import tokensCss from '../../theme/tokens.css?raw';

const isCapabilityError = (error) => Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');

export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="segmented" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className={value === t.value ? 'active' : ''} onClick={() => onChange(t.value)}>
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

// A five-colour strip that previews a theme's palette without applying it. The base values come
// from tokens.css itself (the light block and the explicit dark block), so the strip shows the
// base scheme a theme starts from rather than whatever scheme this page is rendered in.
const SWATCH_KEYS = ['chrome', 'bg', 'surface', 'primary', 'text'];
const tokenBlock = (css, selector) => {
  const start = css.indexOf(selector);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
};
const tokenValues = (block) => Object.fromEntries(SWATCH_KEYS.map((k) => [k, block.match(new RegExp(`--${k}:\\s*([^;]+);`))?.[1]?.trim()]));
const BASE_DEFAULTS = {
  light: tokenValues(tokenBlock(tokensCss, ':root {')),
  dark: tokenValues(tokenBlock(tokensCss, ':root[data-theme="dark"]')),
};
export function ThemeSwatch({ theme, size = 18 }) {
  const defaults = BASE_DEFAULTS[theme?.base] || BASE_DEFAULTS.light;
  const v = { ...defaults, ...(theme?.variables || {}) };
  return (
    <span aria-hidden style={{ display: 'inline-flex', verticalAlign: 'middle', overflow: 'hidden', borderRadius: 'calc(var(--radius) / 2)', border: '1px solid var(--border-strong)', background: 'var(--surface)' }}>
      {SWATCH_KEYS.map((k) => <span key={k} title={`--${k}: ${v[k]}`} style={{ width: size, height: size, background: v[k], display: 'inline-block' }} />)}
    </span>
  );
}

const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
// What the picker shows for an empty or non-hex token; the native control only accepts #rrggbb.
const defaultPick = [BASE_DEFAULTS.light.primary, BASE_DEFAULTS.light.text].find(isHex) || '';

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
          <h3 style={{ margin: '8px 0 10px' }}>{group}</h3>
          {defs.map((def) => {
            const v = value[def.key] ?? '';
            return (
              <Field key={def.key} label={<span>{def.label} <code className="small">--{def.key}</code></span>} error={errors?.[def.key]}>
                <div className="row-actions" style={{ justifyContent: 'flex-start', gap: 6 }}>
                  {def.kind === 'color' && <input type="color" className="input" aria-label={`${def.label} picker`} value={isHex(v) ? v.toLowerCase() : defaultPick} onChange={(e) => set(def.key, e.target.value)} style={{ width: 48, flex: 'none', padding: 4 }} />}
                  <TextInput value={v} onChange={(x) => set(def.key, x)} placeholder={def.kind === 'color' ? 'Inherit from base' : 'Inherit (for example 6px)'} style={{ maxWidth: 220 }} />
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
      {readOnly && <div className="banner banner-info"><Info size={16} /><div>{theme.builtin ? 'Built-in themes are read-only. Copy this theme from the list to customise it.' : 'Only root can change themes; you can inspect and preview this one.'}</div></div>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-grid">
        <Field label="Name" required error={error?.fields?.name}><TextInput value={form.name} onChange={(v) => update({ name: v })} /></Field>
        <Field label="Base scheme" help="Dark bases start from the dark token set; tokens below override either."><Select value={form.base} onChange={(v) => update({ base: v })} options={BASES} /></Field>
        <Field label="Availability"><Toggle checked={form.enabled} disabled={readOnly} onChange={(v) => update({ enabled: v })} label={form.enabled ? 'Enabled: users and packages may pick it' : 'Disabled: hidden from users and packages'} /></Field>
      </div>
      <h3 style={{ margin: '16px 0 4px' }}>Design tokens</h3>
      <p className="muted" style={{ marginTop: 0 }}>Leave a token empty to inherit the base scheme. Values are validated as colours (hex, rgb(), hsl() or a named colour) or pixel lengths.</p>
      <VariableEditor catalog={catalog} value={form.variables} onChange={(v) => update({ variables: v })} errors={error?.fields} />
      <h3 style={{ margin: '20px 0 4px' }}>CSS override</h3>
      <p className="muted" style={{ marginTop: 0 }}>Served to every panel user with this theme, so <code>@import</code>, remote <code>url()</code> targets, quoted remote addresses (as in <code>image-set()</code> or <code>src()</code>) and script-like constructs are refused, including when written with CSS escape sequences. Relative paths and <code>data:image/</code> resources are fine. Stored under the panel data directory.</p>
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
