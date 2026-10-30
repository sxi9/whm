import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { PageHeader, Card, Loading } from './Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Textarea, FormActions, Button, ErrorBanner, isBlank, fieldErrors } from './Form.jsx';
import { useToast } from './Toast.jsx';

export const REQUIRED_MESSAGE = 'Enter a value: this setting cannot be left empty.';

// Keys of required fields the draft leaves empty. A cleared number field is
// null (never 0), so a required setting cannot be saved as a bogus value; the
// server also refuses null for registry keys, which lands inline through
// error.fields.
export function missingRequired(groups, draft) {
  return (groups || []).flatMap((g) => g.fields || []).filter((f) => f.required && isBlank(draft?.[f.key])).map((f) => f.key);
}

function withoutField(error, key) {
  if (!error?.fields || !(key in error.fields)) return error;
  const { [key]: _dropped, ...fields } = error.fields;
  return Object.assign(Object.create(Object.getPrototypeOf(error)), error, { fields: Object.keys(fields).length ? fields : null });
}

// Renders a settings schema as grouped fields backed by GET/PUT /system/settings.
// groups: [{ title, description, fields: [{ key, label, type, help, options, placeholder, required, min, max }] }]
// type: text | number | toggle | select | textarea | list (comma-separated → array)
export function ConfigPage({ fn, title, description, prefix, groups, onSaved, extra }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi(`/system/settings?prefix=${encodeURIComponent(prefix)}`);
  // The draft follows the server's values until the first edit, so a page
  // never renders an empty form while the effect that would seed it waits.
  const [edited, setEdited] = useState(null);
  const draft = edited ?? data ?? {};
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => { setEdited(null); }, [data]);

  const dirty = useMemo(() => data && JSON.stringify(draft) !== JSON.stringify(data), [draft, data]);
  const missing = useMemo(() => missingRequired(groups, draft), [groups, draft]);
  const set = (key, value) => {
    setEdited((d) => ({ ...(d ?? data ?? {}), [key]: value }));
    setSaveError((e) => withoutField(e, key));
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data?.[k])));
      await api.put('/system/settings', changed);
      toast.success('Settings saved');
      await refetch();
      setEdited(null);
      onSaved?.(changed);
    } catch (err) {
      setSaveError(err);
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader fn={fn} title={title} description={description} />
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && groups.map((g) => (
        <Card key={g.title} title={g.title} subtitle={g.description} className="config-fields">
          {g.fields.map((f) => <ConfigField key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} error={fieldErrors(saveError, f.key)} />)}
        </Card>
      ))}
      {extra}
      {data && (
        <div className="sticky-actions">
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!dirty || missing.length > 0} title={missing.length ? 'Fill in the required settings first' : undefined} onClick={save}>Save</Button>
            <Button disabled={!dirty || saving} onClick={() => { setEdited(null); setSaveError(null); }}>Reset</Button>
          </FormActions>
        </div>
      )}
    </>
  );
}

export function ConfigField({ field, value, onChange, error }) {
  const { label, help, type = 'text', options, placeholder, required } = field;
  const errors = [...(required && isBlank(value) ? [REQUIRED_MESSAGE] : []), ...(Array.isArray(error) ? error : error ? [error] : [])];
  if (type === 'toggle') return <Field inline error={errors}><Toggle checked={value} onChange={onChange} label={label} description={help} /></Field>;
  if (type === 'number') return <Field label={label} help={help} required={required} error={errors}><NumberInput value={value} onChange={onChange} placeholder={placeholder} min={field.min} max={field.max} required={required} aria-invalid={errors.length ? true : undefined} /></Field>;
  if (type === 'select') return <Field label={label} help={help} required={required} error={errors}><Select value={value} onChange={onChange} options={options} placeholder={placeholder} /></Field>;
  if (type === 'textarea') return <Field label={label} help={help} required={required} error={errors}><Textarea value={value} onChange={onChange} rows={field.rows || 6} mono={field.mono} /></Field>;
  if (type === 'list') return <Field label={label} help={help || 'Comma-separated'} required={required} error={errors}><TextInput value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(v) => onChange(v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder={placeholder} /></Field>;
  return <Field label={label} help={help} required={required} error={errors}><TextInput value={value ?? ''} onChange={onChange} placeholder={placeholder} type={field.inputType || 'text'} /></Field>;
}
