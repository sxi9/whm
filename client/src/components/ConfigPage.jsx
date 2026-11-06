import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useApi } from '../hooks/useApi.js';
import { PageHeader, Card, Loading } from './Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Textarea, FormActions, Button, ErrorBanner } from './Form.jsx';
import { useToast } from './Toast.jsx';

// Renders a settings schema as grouped fields backed by GET/PUT /system/settings.
// groups: [{ title, description, layout, fields: [{ key, label, type, help, options, placeholder, parse }] }]
// layout: 'grid' lays the group's fields out two per row (.form-grid) for short numeric settings.
// header={false} leaves the PageHeader to a wrapper that renders tabs under its own header.
// type: text | number | toggle | select | textarea | list (comma-separated → array)
export function ConfigPage({ fn, title, description, prefix, groups, onSaved, extra, header = true }) {
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
      {header && <PageHeader fn={fn} title={title} description={description} />}
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && groups.map((g) => (
        <Card key={g.title} title={g.title} subtitle={g.description} className="config-fields">
          {g.layout === 'grid'
            ? <div className="form-grid">{g.fields.map((f) => <ConfigField key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} />)}</div>
            : g.fields.map((f) => <ConfigField key={f.key} field={f} value={draft[f.key]} onChange={(v) => set(f.key, v)} />)}
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

// One entry per line; commas still split so pasted comma lists keep working.
// The draft is kept as text so a line being typed is not trimmed away.
function ListInput({ value, onChange, placeholder }) {
  const list = Array.isArray(value) ? value : value ? [String(value)] : [];
  const [text, setText] = useState(list.join('\n'));
  const [synced, setSynced] = useState(list.join('\n'));
  const joined = list.join('\n');
  if (joined !== synced) { setSynced(joined); setText(joined); }
  const rows = Math.min(8, Math.max(3, list.length + 1));
  return (
    <textarea className="input textarea" rows={rows} value={text} placeholder={placeholder} onChange={(e) => {
      const next = e.target.value;
      const parsed = next.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      setText(next); setSynced(parsed.join('\n')); onChange(parsed);
    }} />
  );
}

export function ConfigField({ field, value, onChange }) {
  const { label, help, type = 'text', options, placeholder } = field;
  if (type === 'toggle') return <Field inline><Toggle checked={value} onChange={onChange} label={label} description={help} /></Field>;
  if (type === 'number') return <Field label={label} help={help}><NumberInput value={value} onChange={onChange} placeholder={placeholder} min={field.min} max={field.max} /></Field>;
  if (type === 'select') return <Field label={label} help={help}><Select value={value} onChange={onChange} options={options} placeholder={placeholder} /></Field>;
  if (type === 'textarea') return <Field label={label} help={help}><Textarea value={value} onChange={onChange} rows={field.rows || 6} mono={field.mono} /></Field>;
  if (type === 'list') return <Field label={label} help={help || 'One per line'}><ListInput value={value} onChange={onChange} placeholder={placeholder} /></Field>;
  return <Field label={label} help={help}><TextInput value={value ?? ''} onChange={onChange} placeholder={placeholder} type={field.inputType || 'text'} /></Field>;
}
