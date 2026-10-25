import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { PageHeader, Card, Loading } from './Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Textarea, FormActions, Button, ErrorBanner } from './Form.jsx';
import { useToast } from './Toast.jsx';

// Renders a settings schema as grouped fields backed by GET/PUT /system/settings.
// groups: [{ title, description, fields: [{ key, label, type, help, options, placeholder, parse }] }]
// type: text | number | toggle | select | textarea | list (comma-separated → array)
export function ConfigPage({ fn, title, description, prefix, groups, onSaved, extra }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi(`/system/settings?prefix=${encodeURIComponent(prefix)}`);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);

  const dirty = useMemo(() => data && JSON.stringify(draft) !== JSON.stringify(data), [draft, data]);
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data?.[k])));
      await api.put('/system/settings', changed);
      toast.success('Settings saved');
      await refetch();
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
          {g.fields.map((f) => <ConfigField key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} />)}
        </Card>
      ))}
      {extra}
      {data && (
        <div className="sticky-actions">
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
            <Button disabled={!dirty || saving} onClick={() => setDraft(data)}>Reset</Button>
          </FormActions>
        </div>
      )}
    </>
  );
}

export function ConfigField({ field, value, onChange }) {
  const { label, help, type = 'text', options, placeholder } = field;
  if (type === 'toggle') return <Field inline><Toggle checked={value} onChange={onChange} label={label} description={help} /></Field>;
  if (type === 'number') return <Field label={label} help={help}><NumberInput value={value} onChange={onChange} placeholder={placeholder} min={field.min} max={field.max} /></Field>;
  if (type === 'select') return <Field label={label} help={help}><Select value={value} onChange={onChange} options={options} placeholder={placeholder} /></Field>;
  if (type === 'textarea') return <Field label={label} help={help}><Textarea value={value} onChange={onChange} rows={field.rows || 6} mono={field.mono} /></Field>;
  if (type === 'list') return <Field label={label} help={help || 'Comma-separated'}><TextInput value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(v) => onChange(v.split(',').map((s) => s.trim()).filter(Boolean))} placeholder={placeholder} /></Field>;
  return <Field label={label} help={help}><TextInput value={value ?? ''} onChange={onChange} placeholder={placeholder} type={field.inputType || 'text'} /></Field>;
}
