import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, formatDate } from '../../../components/Common.jsx';
import { Field, Select, TextInput, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

const VARIABLES = ['%domain%', '%ip%', '%ipv6%', '%ns1%', '%ns2%', '%serial%', '%ttl%', '%hostname%'];

export default function EditZoneTemplates({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: templates, refetch } = useApi('/dns/templates');
  const [name, setName] = useState('standard');
  const [body, setBody] = useState('');
  const [newName, setNewName] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewDomain, setPreviewDomain] = useState('example.com');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const current = (templates || []).find((t) => t.name === name);

  useEffect(() => { if (current) { setBody(current.body); setPreview(null); setError(null); } }, [current]);

  const save = async () => {
    setBusy(true); setError(null);
    try { await api.put(`/dns/templates/${name}`, { body }); toast.success(`Template "${name}" saved`); refetch(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const create = async () => {
    if (!newName) return;
    setBusy(true); setError(null);
    try { await api.post('/dns/templates', { name: newName, body: body || current?.body || '' }); toast.success(`Template "${newName}" created`); await refetch(); setName(newName); setNewName(''); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete template "${name}"?`, message: 'Zones already created from it are not affected.', confirmLabel: 'Delete', danger: true }))) return;
    try { await api.delete(`/dns/templates/${name}`); toast.success('Template deleted'); setName('standard'); refetch(); } catch (err) { toast.error(err); }
  };
  const doPreview = async () => {
    setBusy(true); setError(null);
    try {
      if (body !== current?.body) await api.put(`/dns/templates/${name}`, { body });
      const { data } = await api.post(`/dns/templates/${name}/preview`, { domain: previewDomain || undefined });
      setPreview(data);
      refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Templates are rendered when a zone is created (Add a DNS Zone, account creation, parked domains). They must contain an SOA record and render to a valid BIND zone." />
      <Card title="Templates">
        <div className="form-grid">
          <Field label="Edit template"><Select value={name} onChange={setName} options={(templates || []).map((t) => ({ value: t.name, label: `${t.name}${t.builtin ? ' (built-in)' : ''}` }))} /></Field>
          <Field label="Create a new template" help="Starts as a copy of the editor contents">
            <div className="input-group"><TextInput value={newName} onChange={(v) => setNewName(v.toLowerCase())} placeholder="e.g. ipv6-only" /><Button onClick={create} disabled={!newName} loading={busy}>Create</Button></div>
          </Field>
        </div>
      </Card>
      {current && (
        <Card title={`Template "${current.name}"`} subtitle={`Updated ${formatDate(current.updated_at)} · variables: ${VARIABLES.join(' ')}`}>
          <ErrorBanner error={error && !error.fields ? error : null} />
          {error?.fields?.body && <div className="banner banner-error"><div><strong>Template does not render to a valid zone</strong><ul>{error.fields.body.map((e, i) => <li key={i}>{e}</li>)}</ul></div></div>}
          <Textarea value={body} onChange={setBody} rows={20} mono spellCheck={false} />
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Preview with domain"><TextInput value={previewDomain} onChange={setPreviewDomain} placeholder="example.com" /></Field>
          </div>
          <FormActions>
            <Button variant="primary" loading={busy} onClick={save} disabled={body === current.body}>Save</Button>
            <Button onClick={doPreview} loading={busy}>Save &amp; preview</Button>
            <Button onClick={() => setBody(current.body)} disabled={body === current.body}>Reset</Button>
            {!current.builtin && <Button variant="danger" onClick={remove}>Delete template</Button>}
          </FormActions>
          {preview && (
            <>
              <h3 style={{ marginTop: 16 }}>Rendered preview ({preview.records} records{preview.errors.length ? `, ${preview.errors.length} error(s)` : ''})</h3>
              {preview.errors.length > 0 && <div className="banner banner-error"><div><ul>{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div></div>}
              <pre className="log">{preview.body}</pre>
            </>
          )}
        </Card>
      )}
    </>
  );
}
