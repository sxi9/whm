import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, Button, FormActions, Textarea, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, useLocales, LocaleSelect, TranslationProgress, downloadXml } from '../../locales/Shared.jsx';

export default function LocaleXmlDownload({ fn }) {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { locales, loading, error, refetch } = useLocales();
  const code = params.get('code') || '';
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => { if (!code && locales.length) setParams({ code: locales[0].code }, { replace: true }); }, [code, locales, setParams]);
  useEffect(() => { setPreview(null); }, [code]);
  const selected = locales.find((l) => l.code === code);

  const fetchXml = async () => {
    setBusy(true); setFetchError(null);
    try { const { data } = await api.get(`/locales/${code}/xml`); setPreview(data); return data; } catch (err) { setFetchError(err); toast.error(err); return null; } finally { setBusy(false); }
  };
  const download = async () => { const data = preview || await fetchXml(); if (data) { downloadXml(data.filename, data.content); toast.success(`Downloaded ${data.filename}`); } };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !locales.length && <Loading />}
      {locales.length > 0 && (
        <Card title="Export a locale as XML" subtitle="The file holds every translated string of the locale as <string key=…> elements and can be edited offline, then re-imported with Locale XML Upload.">
          <Field label="Locale"><LocaleSelect value={code} onChange={(v) => setParams({ code: v })} locales={locales} placeholder={null} /></Field>
          {selected && <KeyValue items={[['Name', selected.name], ['Strings', `${selected.stats.translated} translated of ${selected.stats.total}${selected.stats.extra ? ` (+${selected.stats.extra} extra)` : ''}`], ['Progress', <TranslationProgress key="p" stats={selected.stats} />], preview && ['File', `${preview.filename} · ${preview.bytes} bytes`]]} />}
          <ErrorBanner error={fetchError} />
          <FormActions>
            <Button variant="primary" icon={Download} loading={busy} disabled={!code} onClick={download}>Download {code ? `${code}.xml` : ''}</Button>
            <Button disabled={!code} loading={busy} onClick={fetchXml}>Preview</Button>
          </FormActions>
          {preview && <Textarea value={preview.content} onChange={() => {}} readOnly rows={18} mono />}
        </Card>
      )}
    </>
  );
}
