import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useLocales, LocaleSelect, TranslationProgress } from '../../locales/Shared.jsx';

const CODE_RE = /^[a-z]{2,3}(_[a-z0-9]{2,8})?$/;

export default function CopyALocale({ fn }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { locales, loading, error, refetch } = useLocales();
  const [from, setFrom] = useState(params.get('from') || '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => { if (!from && locales.length) setFrom(locales.find((l) => l.isDefault)?.code || locales[0].code); }, [locales, from]);
  const source = locales.find((l) => l.code === from);
  const normalized = code.trim().toLowerCase().replace(/-/g, '_');
  const codeTaken = locales.some((l) => l.code === normalized);
  const codeOk = CODE_RE.test(normalized) && !codeTaken;

  const copy = async () => {
    setBusy(true); setSaveError(null);
    try {
      const { data } = await api.post(`/locales/${from}/copy`, { code: normalized, ...(name.trim() ? { name: name.trim() } : {}) });
      toast.success(`Locale "${data.code}" created from "${from}"`);
      navigate(`/locales/edit-a-locale?code=${data.code}`);
    } catch (err) { setSaveError(err); toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !locales.length && <Loading />}
      {locales.length > 0 && (
        <Card title="Duplicate a locale" subtitle="The copy starts with every string of the source and is disabled until you enable it under Configure Application Locales. Copy the built-in English locale to start a brand-new translation.">
          <div className="form-grid">
            <Field label="Source locale" required><LocaleSelect value={from} onChange={setFrom} locales={locales} placeholder={null} /></Field>
            <Field label="New locale code" required error={code && !CODE_RE.test(normalized) ? 'Codes look like "es", "de_at" or "pt_br"' : codeTaken ? 'That code is already installed' : null} help="A two or three letter language code, optionally followed by _ and a region.">
              <TextInput value={code} onChange={setCode} placeholder="e.g. es_mx" />
            </Field>
            <Field label="Display name" help="Shown to users in the language picker."><TextInput value={name} onChange={setName} placeholder={source ? `${source.name} (copy)` : ''} /></Field>
          </div>
          {source && <KeyValue items={[['Source', `${source.name} (${source.code})`], ['Strings in source', `${source.stats.translated} translated of ${source.stats.total}`], ['Progress', <TranslationProgress key="p" stats={source.stats} />]]} />}
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={busy} disabled={!from || !codeOk} onClick={copy}>Copy locale</Button>
            <Link className="btn" to="/locales/view-available-locales">Cancel</Link>
          </FormActions>
        </Card>
      )}
    </>
  );
}
