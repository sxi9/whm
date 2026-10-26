import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, Loading, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { RequestError, Tabs, useLocales, LocaleSelect, LocalePills, TranslationProgress, LocaleLinks } from '../../locales/Shared.jsx';

const PAGE = 100;

export default function EditALocale({ fn }) {
  const toast = useToast();
  const { reload } = useT();
  const [params, setParams] = useSearchParams();
  const { locales, loading: listLoading, error: listError, refetch: refetchList } = useLocales();
  const code = params.get('code') || '';
  const locale = useApi(code ? `/locales/${code}` : null, { enabled: Boolean(code) });
  const base = useApi('/locales/keys');
  const [edits, setEdits] = useState({});
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => { setEdits({}); setPage(1); }, [code]);
  useEffect(() => { if (locale.data) setName(locale.data.name); }, [locale.data]);
  useEffect(() => { if (!code && locales.length) setParams({ code: (locales.find((l) => !l.builtin) || locales[0]).code }, { replace: true }); }, [code, locales, setParams]);

  const current = locale.data?.strings || {};
  const baseStrings = base.data?.strings || {};
  const rows = useMemo(() => {
    const keys = new Set([...Object.keys(baseStrings), ...Object.keys(current)]);
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const key of [...keys].sort()) {
      const english = baseStrings[key];
      const value = key in edits ? edits[key] : current[key];
      const translated = typeof value === 'string' && value.trim() !== '';
      const extra = !(key in baseStrings);
      if (filter === 'untranslated' && translated) continue;
      if (filter === 'translated' && !translated) continue;
      if (filter === 'changed' && !(key in edits)) continue;
      if (filter === 'extra' && !extra) continue;
      if (needle && !key.toLowerCase().includes(needle) && !(english || '').toLowerCase().includes(needle) && !(value || '').toLowerCase().includes(needle)) continue;
      out.push({ key, english, value: value ?? '', translated, extra, changed: key in edits });
    }
    return out;
  }, [baseStrings, current, edits, q, filter]);
  const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
  const counts = useMemo(() => {
    const keys = new Set([...Object.keys(baseStrings), ...Object.keys(current)]);
    let untranslated = 0; let extra = 0;
    for (const key of keys) { const v = key in edits ? edits[key] : current[key]; if (!(typeof v === 'string' && v.trim() !== '')) untranslated++; if (!(key in baseStrings)) extra++; }
    return { all: keys.size, untranslated, translated: keys.size - untranslated, changed: Object.keys(edits).length, extra };
  }, [baseStrings, current, edits]);

  const setValue = (key, v) => setEdits((e) => { const next = { ...e }; if ((current[key] ?? '') === v) delete next[key]; else next[key] = v; return next; });
  const readOnly = Boolean(locale.data?.builtin);
  const dirty = Object.keys(edits).length > 0 || (locale.data && name.trim() !== locale.data.name);

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const strings = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v.trim() === '' ? null : v]));
      const body = { ...(Object.keys(strings).length ? { strings } : {}), ...(name.trim() !== locale.data.name ? { name: name.trim() } : {}) };
      const { data } = await api.put(`/locales/${code}`, body);
      toast.success(`Saved "${code}": ${data.changed} string(s) changed, ${data.removed} cleared`);
      setEdits({});
      await locale.refetch();
      refetchList();
      reload();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader fn={fn} actions={locale.data && <LocaleLinks code={code} except="edit" />} />
      <RequestError error={listError} onRetry={refetchList} />
      <Card title="Locale" subtitle="Pick the locale to edit. The built-in English locale is the reference and cannot be edited: copy it to start a new translation.">
        <div className="form-grid">
          <Field label="Locale"><LocaleSelect value={code} onChange={(v) => setParams({ code: v })} locales={locales} /></Field>
          <Field label="Display name" help={readOnly ? 'Built-in locale; name is fixed' : undefined}><TextInput value={name} onChange={setName} disabled={readOnly || !locale.data} /></Field>
        </div>
        {locale.data && <div className="row-actions" style={{ justifyContent: 'flex-start', gap: 12 }}><LocalePills locale={locale.data} /><TranslationProgress stats={locale.data.stats} /></div>}
        {listLoading && !locales.length && <Loading />}
      </Card>
      <RequestError error={locale.error} onRetry={locale.refetch} />
      <RequestError error={base.error} onRetry={base.refetch} />
      {locale.data && base.data && (
        <Card title="Strings" subtitle={readOnly ? 'Reference values of the English catalog.' : 'Edit the translation next to its English source. Clear a field to fall back to English. Changes are kept until you save.'} padded={false}
          actions={!readOnly && <><Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save {counts.changed ? `(${counts.changed})` : ''}</Button><Button disabled={!dirty} onClick={() => { setEdits({}); setName(locale.data.name); }}>Discard</Button></>}>
          <div style={{ padding: '12px 16px 0' }}>
            <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} tabs={[
              { value: 'all', label: 'All', count: counts.all }, { value: 'untranslated', label: 'Untranslated', count: counts.untranslated }, { value: 'translated', label: 'Translated', count: counts.translated },
              { value: 'changed', label: 'Unsaved', count: counts.changed }, ...(counts.extra ? [{ value: 'extra', label: 'Not in catalog', count: counts.extra }] : []),
            ]} />
            <input className="input" placeholder="Search keys, English text or translations…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} style={{ marginBottom: 12 }} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: '28%' }}>Key</th><th style={{ width: '32%' }}>English</th><th>{locale.data.name}</th></tr></thead>
              <tbody>
                {pageRows.length === 0 && <tr><td colSpan={3} className="table-state">No strings match{q ? ' the search' : ' this filter'}.</td></tr>}
                {pageRows.map((r) => (
                  <tr key={r.key} className={r.changed ? 'is-selected' : ''}>
                    <td><code className="small">{r.key}</code>{r.extra && <div><StatusPill status="warning">not in catalog</StatusPill></div>}</td>
                    <td className="small">{r.english ?? <span className="muted">—</span>}</td>
                    <td>
                      {readOnly ? <span className="small">{r.value}</span> : (
                        <input className="input" value={r.value} placeholder={r.english || ''} onChange={(e) => setValue(r.key, e.target.value)} aria-label={`Translation for ${r.key}`} style={!r.translated ? { borderStyle: 'dashed' } : undefined} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PAGE && (
            <div className="datatable-footer">
              <span className="muted">{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, rows.length)} of {rows.length}</span>
              <div className="pager">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <span>Page {page} of {Math.ceil(rows.length / PAGE)}</span>
                <Button size="sm" disabled={page >= Math.ceil(rows.length / PAGE)} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
          <div style={{ padding: '0 16px 12px' }}>
            <ErrorBanner error={saveError} />
            {!readOnly && <FormActions><Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save changes</Button></FormActions>}
            {readOnly && <p className="muted small"><Link to={`/locales/copy-a-locale?from=${code}`}>Copy this locale</Link> to create an editable translation.</p>}
          </div>
        </Card>
      )}
      {code && locale.loading && !locale.data && <Loading />}
    </>
  );
}
