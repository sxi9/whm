import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { Field, Textarea, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

const LABELS = { index: 'Default site page (new accounts)', suspended: 'Suspended account page', moved: 'Site moved page', 'error-4xx': '4xx error page' };

export default function WebTemplateEditor({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: list, refetch: refetchList } = useApi('/account-functions/templates');
  const [name, setName] = useState('index');
  const { data: tpl, error: loadError, refetch } = useApi(`/account-functions/templates/${name}`);
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastWrite, setLastWrite] = useState(null);

  useEffect(() => { if (tpl) { setBody(tpl.body); setPreview(null); } }, [tpl]);
  const dirty = tpl && body !== tpl.body;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/account-functions/templates/${name}`, { body });
      setLastWrite(data);
      toast[data.written ? 'success' : 'warning'](data.written ? `${name}.html saved to ${data.path}` : `${name} saved in the panel; ${data.writeError || 'the file could not be written'}`);
      refetch(); refetchList();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = async () => {
    if (!(await confirm({ title: `Reset ${name} to the built-in template?`, message: 'Your customised HTML is replaced by the default page.', confirmLabel: 'Reset', danger: true }))) return;
    setBusy(true);
    try { await api.post(`/account-functions/templates/${name}/reset`); toast.success(`${name} reset`); refetch(); refetchList(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const doPreview = async () => {
    setBusy(true); setError(null);
    try { const { data } = await api.post(`/account-functions/templates/${name}/preview`, { body }); setPreview(data.html); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const meta = list?.templates.find((t) => t.name === name);
  return (
    <>
      <PageHeader fn={fn} description={`Edits the HTML pages the panel installs for new sites, suspended accounts, moved sites and 4xx errors. Saved under ${list?.dir || '/etc/whm/templates'}; the default site page is written into public_html when an account is created.`} />
      <Card title="Template">
        <div className="form-grid">
          <Field label="Page"><Select value={name} onChange={setName} options={(list?.templates || Object.keys(LABELS).map((n) => ({ name: n }))).map((t) => ({ value: t.name, label: `${LABELS[t.name] || t.name}${t.customised ? ' (customised)' : ''}` }))} /></Field>
        </div>
        {meta && <KeyValue items={[['File', <code key="f">{meta.path}</code>], ['Status', <StatusPill key="s" status={meta.customised ? 'enabled' : 'muted'}>{meta.customised ? 'customised' : 'built-in default'}</StatusPill>], ['Last saved', formatDate(meta.updated_at)], ['Variables', <code key="v">{(list?.variables || []).map((v) => `{{${v}}}`).join('  ')}</code>]]} />}
      </Card>
      <Card title={LABELS[name] || name} actions={<Button size="sm" onClick={doPreview} loading={busy}>Preview</Button>}>
        <ErrorBanner error={loadError || error} />
        <Field label="HTML" error={error?.fields?.body} help="A complete HTML document. Variables are HTML-escaped when rendered."><Textarea value={body} onChange={setBody} rows={18} mono /></Field>
        <FormActions>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button>
          <Button disabled={!dirty || busy} onClick={() => setBody(tpl.body)}>Discard changes</Button>
          <Button variant="danger" loading={busy} disabled={!meta?.customised} onClick={reset}>Reset to default</Button>
        </FormActions>
        {lastWrite && lastWrite.name === name && !lastWrite.written && <div className="banner banner-warning"><div><strong>Saved in the panel only</strong><p>{lastWrite.writeError}</p></div></div>}
      </Card>
      {preview != null && (
        <Card title="Preview" subtitle="Rendered with sample values">
          <iframe title="Template preview" srcDoc={preview} sandbox="" style={{ width: '100%', height: 420, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }} />
        </Card>
      )}
    </>
  );
}
