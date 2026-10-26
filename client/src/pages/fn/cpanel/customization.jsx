import { useEffect, useMemo, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, KeyValue, formatBytes, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, Textarea, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { notifyBrandingChanged } from '../../cpanel/branding.js';

const TEXT_FIELDS = ['companyName', 'tagline', 'primaryColor', 'chromeColor', 'helpUrl', 'docsUrl', 'supportUrl', 'loginNotice', 'footerText'];
const KINDS = {
  logo: { label: 'Logo', help: 'PNG, JPEG, GIF, WebP or SVG up to 512 KB. Shown in the top bar and on the login page.', accept: '.png,.jpg,.jpeg,.gif,.webp,.svg,image/*' },
  favicon: { label: 'Favicon', help: 'ICO, PNG or SVG up to 128 KB.', accept: '.ico,.png,.svg,image/x-icon,image/png,image/svg+xml' },
};

function ColorField({ label, value, onChange, help }) {
  const valid = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value || '');
  return (
    <Field label={label} help={help}>
      <div className="input-group">
        <input type="color" aria-label={`${label} picker`} value={valid && value.length === 7 ? value : '#1b8fc9'} onChange={(e) => onChange(e.target.value)} style={{ width: 44, height: 36, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'transparent' }} />
        <TextInput value={value} onChange={onChange} placeholder="#rrggbb (empty = theme default)" className="input mono" />
        {value && <button type="button" className="btn btn-sm" onClick={() => onChange('')}>Clear</button>}
      </div>
    </Field>
  );
}

function ImageCard({ kind, descriptor, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const spec = KINDS[kind];
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.postRaw(`/cpanel/branding/${kind}`, file, file.type || 'application/octet-stream');
      toast.success(`${spec.label} updated`);
      setFile(null);
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Remove the ${spec.label.toLowerCase()}?`, message: 'The default WHM mark is shown until a new image is uploaded.', confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true);
    try { await api.delete(`/cpanel/branding/${kind}`); toast.success(`${spec.label} removed`); onChanged(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title={spec.label} subtitle={spec.help}>
      <div className="form-grid">
        <div>
          {descriptor ? (
            <>
              <div style={{ padding: 12, background: 'var(--surface-2)', borderRadius: 'var(--radius)', display: 'inline-block', marginBottom: 10 }}>
                <img src={descriptor.url} alt={`Current ${spec.label.toLowerCase()}`} style={{ maxHeight: kind === 'logo' ? 64 : 32, maxWidth: 320, display: 'block' }} />
              </div>
              <KeyValue items={[['Type', descriptor.mime], ['Size', formatBytes(descriptor.size)], ['Updated', formatDate(descriptor.updatedAt)]]} />
            </>
          ) : <p className="muted"><ImageIcon size={16} /> No {spec.label.toLowerCase()} uploaded; the built-in WHM mark is used.</p>}
        </div>
        <div>
          <Field label={`Upload a new ${spec.label.toLowerCase()}`} htmlFor={`${kind}-file`}>
            <input id={`${kind}-file`} className="input" type="file" accept={spec.accept} onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </Field>
          <div className="action-row">
            <Button variant="primary" loading={busy} disabled={!file} onClick={upload}>Upload</Button>
            {descriptor && <Button variant="danger" disabled={busy} onClick={remove}>Remove</Button>}
          </div>
          <ErrorBanner error={error} />
        </div>
      </div>
    </Card>
  );
}

export default function Customization({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/cpanel/branding');
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (data) setDraft(Object.fromEntries(TEXT_FIELDS.map((k) => [k, data[k] ?? '']))); }, [data]);
  const dirty = useMemo(() => data && TEXT_FIELDS.some((k) => (draft[k] ?? '') !== (data[k] ?? '')), [draft, data]);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const changed = () => { refetch(); notifyBrandingChanged(); };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = Object.fromEntries(TEXT_FIELDS.filter((k) => (draft[k] ?? '') !== (data[k] ?? '')).map((k) => [k, draft[k]]));
      await api.put('/cpanel/branding', body);
      toast.success('Branding saved');
      changed();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      {loading && !data && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <>
          <Card title="Company" subtitle="Shown in the top bar, the browser title and the login page">
            <div className="form-grid">
              <Field label="Company name" required><TextInput value={draft.companyName} onChange={set('companyName')} maxLength={80} /></Field>
              <Field label="Tagline" help="Replaces “WebHost Manager” next to the logo."><TextInput value={draft.tagline} onChange={set('tagline')} maxLength={120} /></Field>
              <Field label="Footer text" help="Shown in the footer of every page; empty keeps the default."><TextInput value={draft.footerText} onChange={set('footerText')} maxLength={200} /></Field>
            </div>
          </Card>
          <Card title="Colours" subtitle="Applied on top of the active theme; a theme that sets the same token wins (Themes › Theme Manager)">
            <div className="form-grid">
              <ColorField label="Primary colour" value={draft.primaryColor} onChange={set('primaryColor')} help="Buttons, links and the active sidebar item." />
              <ColorField label="Chrome colour" value={draft.chromeColor} onChange={set('chromeColor')} help="Top bar and sidebar background." />
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
              <span className="muted small">Preview:</span>
              <span className="btn btn-primary" style={draft.primaryColor ? { background: draft.primaryColor, borderColor: draft.primaryColor } : undefined}>Primary button</span>
              <span style={{ padding: '6px 12px', borderRadius: 'var(--radius)', background: draft.chromeColor || 'var(--chrome)', color: '#fff' }}>Chrome</span>
            </div>
          </Card>
          <Card title="Help and documentation links" subtitle="Linked from the top bar user menu and the login page when set">
            <div className="form-grid">
              <Field label="Help URL"><TextInput value={draft.helpUrl} onChange={set('helpUrl')} placeholder="https://help.example.com/" type="url" /></Field>
              <Field label="Documentation URL"><TextInput value={draft.docsUrl} onChange={set('docsUrl')} placeholder="https://docs.example.com/" type="url" /></Field>
              <Field label="Support URL"><TextInput value={draft.supportUrl} onChange={set('supportUrl')} placeholder="https://support.example.com/tickets" type="url" /></Field>
            </div>
          </Card>
          <Card title="Login page notice" subtitle="Plain text or simple Markdown shown above the login form, for example a legal or acceptable-use notice">
            <Textarea value={draft.loginNotice} onChange={set('loginNotice')} rows={4} maxLength={2000} placeholder="Authorised administrators only. All activity is logged." />
          </Card>
          <div className="sticky-actions">
            <ErrorBanner error={saveError} />
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
              <Button disabled={!dirty || saving} onClick={() => setDraft(Object.fromEntries(TEXT_FIELDS.map((k) => [k, data[k] ?? ''])))}>Reset</Button>
            </FormActions>
          </div>
          <ImageCard kind="logo" descriptor={data.logo} onChanged={changed} />
          <ImageCard kind="favicon" descriptor={data.favicon} onChanged={changed} />
        </>
      )}
    </>
  );
}
