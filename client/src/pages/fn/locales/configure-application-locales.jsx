import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { PageHeader, Card, Loading } from '../../../components/Common.jsx';
import { Field, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT, setPreferredLocale, preferredLocale } from '../../../i18n/useT.js';
import { RequestError, useLocales, LocaleSelect, TranslationProgress } from '../../locales/Shared.jsx';

export default function ConfigureApplicationLocales({ fn }) {
  const toast = useToast();
  const { reload, locale: activeCode } = useT();
  const { locales, loading, error, refetch, defaultCode } = useLocales();
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [preference, setPreference] = useState(preferredLocale() || '');

  useEffect(() => { if (locales.length && !draft) setDraft({ default: defaultCode, enabled: locales.filter((l) => l.enabled).map((l) => l.code) }); }, [locales, defaultCode, draft]);

  const toggle = (code, on) => setDraft((d) => ({ ...d, enabled: on ? [...new Set([...d.enabled, code])] : d.enabled.filter((c) => c !== code) }));
  // The draft is only discarded once the fresh list (rows and meta) has
  // arrived; clearing it earlier rebuilt it from the stale default.
  const resetToServer = async () => { await refetch(); setDraft(null); };
  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const res = await api.put('/locales/config', { default: draft.default, enabled: [...new Set([...draft.enabled, draft.default])] });
      toast.success(`Default locale is now "${res.meta?.default || draft.default}"`);
      await resetToServer();
      reload();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };
  const applyPreference = async (code) => {
    setPreference(code);
    await setPreferredLocale(code || null);
    toast.info(code ? `This browser now shows the interface in "${code}"` : 'This browser follows the server default again');
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !draft && <Loading />}
      {draft && (
        <Card title="Interface languages" subtitle="The default applies to everyone who has not picked a language; enabled locales are the ones users may choose. The default is always enabled.">
          <Field label="Default locale" required help="Used until a user picks another enabled locale.">
            <LocaleSelect value={draft.default} onChange={(v) => setDraft({ ...draft, default: v })} locales={locales} placeholder={null} />
          </Field>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Locale</th><th>Translated</th><th>Available to users</th></tr></thead>
              <tbody>
                {locales.map((l) => {
                  const forced = l.code === draft.default;
                  return (
                    <tr key={l.code}>
                      <td><strong>{l.name}</strong> <code>{l.code}</code>{l.builtin && <span className="pill pill-info" style={{ marginLeft: 6 }}>built-in</span>}</td>
                      <td><TranslationProgress stats={l.stats} /></td>
                      <td><Toggle checked={forced || draft.enabled.includes(l.code)} disabled={forced} onChange={(on) => toggle(l.code, on)} label={forced ? 'default' : draft.enabled.includes(l.code) ? 'enabled' : 'disabled'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ErrorBanner error={saveError} />
          <FormActions>
            <Button variant="primary" loading={saving} onClick={save}>Save</Button>
            <Button onClick={resetToServer}>Reset</Button>
            <Link className="btn" to="/locales/view-available-locales">View available locales</Link>
          </FormActions>
        </Card>
      )}
      <Card title="Your preference in this browser" subtitle={`The interface currently renders in "${activeCode || defaultCode}". A preference only applies to enabled locales and is stored in this browser.`}>
        <Field label="Interface language for this browser">
          <LocaleSelect value={preference} onChange={applyPreference} locales={locales} filter={(l) => l.enabled} placeholder={`Server default (${defaultCode})`} />
        </Field>
      </Card>
    </>
  );
}
