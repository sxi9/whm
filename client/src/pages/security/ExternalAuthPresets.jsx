import { useState } from 'react';
import { Check, Copy, ExternalLink, ArrowLeft } from 'lucide-react';
import { api } from '../../api/client.js';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

// The redirect URI the panel sends is /api/auth/external/<name>/callback on the
// panel origin; the server reports the template, the identifier fills it in.
export function redirectUriFor(template, name) {
  if (!template) return '';
  return template.replace('{name}', name ? encodeURIComponent(name) : '<identifier>');
}

export function issuerPreview(preset) {
  if (!preset?.issuerTemplate) return '';
  if (preset.generic) return 'Any OpenID Connect issuer';
  return preset.issuerTemplate.replace('{clientId}', '<client-id>').replace(/\{(\w+)\}/g, '<$1>');
}

export function CopyValue({ value, label }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error('Copying failed; select the text and copy it by hand'); }
  };
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input className="input mono" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
      <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

const cardStyle = (enabled) => ({
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, textAlign: 'left', padding: '12px 14px', borderRadius: 8,
  border: '1px solid var(--border, #d8dde3)', background: 'var(--surface, #fff)', cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.6, font: 'inherit', color: 'inherit',
});

// Step one of "Add provider": one card per vendor preset. Unsupported vendors stay
// visible with the reason so nobody looks for them elsewhere.
export function PresetPicker({ presets, loading, onPick }) {
  const list = presets || [];
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>Pick where your users sign in. The panel knows each provider's issuer and endpoints; you add the OAuth client ID and secret.</p>
      {loading && !list.length && <p className="muted">Loading presets…</p>}
      <div className="tool-grid" role="list" data-testid="preset-grid">
        {list.map((p) => (
          <button key={p.id} type="button" role="listitem" className="preset-card" data-preset={p.id} disabled={!p.supported} onClick={() => onPick(p)} title={p.supported ? `Add ${p.label}` : p.reason} style={cardStyle(p.supported)}>
            <strong>{p.label}</strong>
            <small className="muted">{p.supported ? issuerPreview(p) : 'Not supported yet'}</small>
            {!p.supported && <small className="muted">{p.reason}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PresetInstructions({ preset, redirectUri, currentRedirectUri }) {
  return (
    <>
      <Field label="Redirect URI (register it at the provider)">
        <CopyValue value={redirectUri} label="Redirect URI" />
        {currentRedirectUri && currentRedirectUri !== redirectUri && (
          <div className="field-help">You are using the panel at a different address right now; the panel sends the address the browser used, so also register <code>{currentRedirectUri}</code> if users sign in through it.</div>
        )}
      </Field>
      {preset.instructions?.length > 0 && (
        <ol className="preset-steps" style={{ paddingLeft: 20, margin: '0 0 12px' }}>
          {preset.instructions.map((step, i) => <li key={i} style={{ marginBottom: 4 }}>{step}</li>)}
        </ol>
      )}
      {preset.docsUrl && <p style={{ margin: '0 0 12px' }}><a href={preset.docsUrl} target="_blank" rel="noreferrer noopener">{preset.label} documentation <ExternalLink size={13} style={{ verticalAlign: 'middle' }} /></a></p>}
      {preset.limitations && <div className="banner banner-info" style={{ marginBottom: 12 }}>{preset.limitations}</div>}
      {preset.pinnedEndpoints?.length > 0 && <p className="muted" style={{ marginTop: 0 }}>Pinned by the panel: {preset.pinnedEndpoints.map((e) => <code key={e.name} style={{ marginRight: 6 }}>{e.url}</code>)}</p>}
    </>
  );
}

// Step two: only the preset's own fields plus identifier, display name, client
// ID/secret and scopes; the server resolves the issuer and runs discovery.
export function PresetForm({ preset, redirectUriTemplate, currentRedirectUriTemplate, onDone, onBack }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({
    name: preset.id, displayName: preset.label, clientId: '', clientSecret: '', scopes: preset.scopes ?? '', enabled: true,
    fields: Object.fromEntries((preset.fields || []).map((f) => [f.key, f.default || ''])),
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setField = (k) => (v) => setForm((f) => ({ ...f, fields: { ...f.fields, [k]: v } }));
  const redirectUri = redirectUriFor(redirectUriTemplate, form.name);
  const currentRedirectUri = currentRedirectUriTemplate ? redirectUriFor(currentRedirectUriTemplate, form.name) : null;

  const submit = async (e, allowForeignEndpoints = false) => {
    e?.preventDefault?.();
    setBusy(true); setError(null);
    try {
      const body = {
        preset: preset.id, name: form.name, displayName: form.displayName, clientId: form.clientId, scopes: form.scopes, enabled: form.enabled, fields: form.fields,
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), ...(allowForeignEndpoints ? { allowForeignEndpoints: true } : {}),
      };
      const { data } = await api.post('/security/external-auth', body);
      toast.success(`${data.displayName} added; discovery fetched ${data.discovery?.issuer || data.issuerUrl}`);
      onDone(true);
    } catch (err) {
      if (!allowForeignEndpoints && err?.fields?.allowForeignEndpoints) {
        const ok = await confirm({ title: 'Endpoints on other hosts', message: `${err.message} The client secret is sent to the token endpoint, so only allow this when the provider documents those hosts.`, confirmLabel: 'Allow and add', danger: true });
        if (ok) return await submit(null, true);
        return;
      }
      setError(err);
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} data-preset-form={preset.id}>
      <ErrorBanner error={error} />
      <PresetInstructions preset={preset} redirectUri={redirectUri} currentRedirectUri={currentRedirectUri} />
      <div className="form-grid">
        <Field label="Identifier" required help="Lowercase; part of the redirect URI" error={error?.fields?.name}><TextInput value={form.name} onChange={set('name')} /></Field>
        <Field label="Display name" required help="Shown on the login page" error={error?.fields?.displayName}><TextInput value={form.displayName} onChange={set('displayName')} /></Field>
        {(preset.fields || []).map((f) => (
          <Field key={f.key} label={f.label} required help={f.help} error={error?.fields?.[`fields.${f.key}`]}><TextInput value={form.fields[f.key]} onChange={setField(f.key)} placeholder={f.placeholder || ''} /></Field>
        ))}
        <Field label="Client ID" required error={error?.fields?.clientId}><TextInput value={form.clientId} onChange={set('clientId')} autoComplete="off" /></Field>
        <Field label={preset.secret?.label || 'Client secret'} required={preset.secret?.required !== false} help={preset.secret?.help || 'Stored encrypted with the panel master key'} error={error?.fields?.clientSecret}><PasswordInput value={form.clientSecret} onChange={set('clientSecret')} showStrength={false} allowGenerate={false} autoComplete="off" /></Field>
        <Field label="Scopes" help={preset.scopes === '' ? 'None for this provider (see the note above)' : 'Space-separated; the preset default suits most setups'} error={error?.fields?.scopes}><TextInput value={form.scopes} onChange={set('scopes')} /></Field>
      </div>
      <Field inline><Toggle checked={form.enabled} onChange={set('enabled')} label="Enabled" /></Field>
      <FormActions>
        <Button type="submit" variant="primary" loading={busy}>Add {preset.label}</Button>
        {onBack && <Button icon={ArrowLeft} onClick={onBack}>Other provider</Button>}
        <Button onClick={() => onDone(false)}>Cancel</Button>
      </FormActions>
    </form>
  );
}
