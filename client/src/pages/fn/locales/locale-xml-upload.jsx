import { useRef, useState } from 'react';
import { AlertTriangle, Upload } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, RadioGroup, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { RequestError, useLocales, TranslationProgress } from '../../locales/Shared.jsx';

const MODES = [
  { value: 'merge', label: 'Merge', description: 'Add and overwrite the strings in the file; keep everything else the locale already has. Creates the locale when it does not exist.' },
  { value: 'replace', label: 'Replace', description: 'The locale ends up with exactly the strings in the file. Creates the locale when it does not exist.' },
  { value: 'create', label: 'Create only', description: 'Refuse the upload if a locale with this code already exists.' },
];

export default function LocaleXmlUpload({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { reload } = useT();
  const { locales, error, refetch } = useLocales();
  const fileRef = useRef(null);
  const [xml, setXml] = useState('');
  const [fileName, setFileName] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('merge');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const body = () => ({ xml, mode, ...(code.trim() ? { code: code.trim().toLowerCase().replace(/-/g, '_') } : {}), ...(name.trim() ? { name: name.trim() } : {}) });
  const onFile = (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Locale files are limited to 2 MB'); return; }
    const reader = new FileReader();
    reader.onload = () => { setXml(String(reader.result || '')); setFileName(file.name); setPreview(null); setUploadError(null); };
    reader.readAsText(file);
  };
  const validate = async () => {
    setBusy(true); setUploadError(null); setPreview(null);
    try { const { data } = await api.post('/locales/xml', { ...body(), dryRun: true }); setPreview(data); } catch (err) { setUploadError(err); } finally { setBusy(false); }
  };
  const upload = async () => {
    const p = preview;
    const message = p?.exists ? `"${p.code}" exists: ${p.added} string(s) added, ${p.changed} changed${p.removed ? `, ${p.removed} removed` : ''}.` : `A new locale "${p?.code || code}" will be created.`;
    if (!(await confirm({ title: 'Import this locale?', message, confirmLabel: 'Import', danger: Boolean(p?.removed) }))) return;
    setBusy(true); setUploadError(null);
    try {
      const { data } = await api.post('/locales/xml', body());
      toast.success(`Imported "${data.code}": ${data.added} added, ${data.changed} changed${data.removed ? `, ${data.removed} removed` : ''}`);
      refetch();
      reload();
      navigate(`/locales/edit-a-locale?code=${data.code}`);
    } catch (err) { setUploadError(err); toast.error(err); } finally { setBusy(false); }
  };

  const existing = preview ? locales.find((l) => l.code === preview.code) : null;

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      <Card title="Import a locale from XML" subtitle="Accepts the format produced by Locale XML Download. The file is validated before anything is written; the built-in English locale cannot be overwritten.">
        <div className="form-grid">
          <Field label="Locale file" help="A .xml file up to 2 MB, or paste the document below.">
            <input ref={fileRef} type="file" accept=".xml,application/xml,text/xml" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            <div><Button icon={Upload} onClick={() => fileRef.current?.click()}>Choose .xml file</Button></div>
            {fileName && <div className="field-help">Loaded {fileName} ({xml.length.toLocaleString()} characters)</div>}
          </Field>
          <Field label="Locale code (optional)" help="Overrides the code attribute in the file, for example to import as a different locale."><TextInput value={code} onChange={(v) => { setCode(v); setPreview(null); }} placeholder="From the file" /></Field>
          <Field label="Display name (optional)" help="Overrides the name attribute in the file."><TextInput value={name} onChange={(v) => { setName(v); setPreview(null); }} placeholder="From the file" /></Field>
        </div>
        <Field label="XML document"><Textarea value={xml} onChange={(v) => { setXml(v); setPreview(null); }} rows={12} mono placeholder={'<?xml version="1.0" encoding="UTF-8"?>\n<locale code="es" name="Español">\n  <string key="common.home">Inicio</string>\n</locale>'} /></Field>
        <Field label="When the locale already exists"><RadioGroup name="mode" value={mode} onChange={(v) => { setMode(v); setPreview(null); }} options={MODES} /></Field>
        {uploadError && uploadError.fields?.xml ? (
          <div className="banner banner-error" role="alert">
            <AlertTriangle size={18} />
            <div>
              <strong>The locale XML is not valid</strong>
              <ul>{uploadError.fields.xml.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          </div>
        ) : <ErrorBanner error={uploadError} />}
        {preview && (
          <Field label="Validation result" help="Nothing has been written yet.">
            <KeyValue items={[
              ['Locale', <span key="l"><code>{preview.code}</code> {preview.name}</span>],
              ['Action', existing || preview.exists ? <StatusPill key="a" status="warning">Updates existing locale ({preview.mode})</StatusPill> : <StatusPill key="a" status="ok">Creates a new locale</StatusPill>],
              ['Strings in file', preview.keys],
              ['Added / changed / removed', `${preview.added} / ${preview.changed} / ${preview.removed}`],
              ['Keys not in the English catalog', preview.unknownKeys.length ? <span key="u" className="row-actions small" style={{ flexWrap: 'wrap' }}>{preview.unknownKeys.slice(0, 10).map((k) => <code key={k}>{k}</code>)}{preview.unknownKeys.length > 10 && `+${preview.unknownKeys.length - 10} more`}</span> : 'None'],
              ['Coverage after import', <TranslationProgress key="p" stats={preview.stats} />],
            ]} />
          </Field>
        )}
        <FormActions>
          <Button loading={busy} disabled={!xml.trim()} onClick={validate}>Validate</Button>
          <Button variant="primary" loading={busy} disabled={!xml.trim() || !preview} onClick={upload}>Import</Button>
          <Link className="btn" to="/locales/locale-xml-download">Download an existing locale</Link>
        </FormActions>
        {!preview && xml.trim() && <p className="muted small">Validate first to see what the import would change.</p>}
      </Card>
    </>
  );
}
