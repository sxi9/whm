import { useEffect, useState } from 'react';
import { Save, Languages } from 'lucide-react';
import { Card, KeyValue, Loading } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { useT, translate, setPreferredLocale } from '../../../i18n/useT.js';
import { usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const NOTIFICATIONS = [
  ['quota', 'Disk quota', 'When the account is close to or over its disk quota.'],
  ['bandwidth', 'Bandwidth', 'When the monthly bandwidth is close to or over the plan limit.'],
  ['passwordChange', 'Password changes', 'Each time the account password changes, to every contact address.'],
];

// Pure, so tests can call it: field errors for the contact form.
export function validateContact({ email, email2 }) {
  const fields = {};
  if (!EMAIL.test(String(email || '').trim())) fields.email = [translate('panel.overview.email_invalid', 'Enter a valid email address')];
  if (email2 && !EMAIL.test(String(email2).trim())) fields.email2 = [translate('panel.overview.email2_invalid', 'Enter a valid email address or leave it empty')];
  if (email2 && email && email2.trim().toLowerCase() === email.trim().toLowerCase()) fields.email2 = [translate('panel.overview.email2_same', 'The second address must differ from the first')];
  return Object.keys(fields).length ? { fields } : null;
}

export const draftFrom = (p) => ({ email: p?.email || '', email2: p?.email2 || '', notify: { quota: p?.notify?.quota !== false, bandwidth: p?.notify?.bandwidth !== false, passwordChange: p?.notify?.passwordChange !== false }, currentPassword: '' });

export default function Preferences({ fn }) {
  const toast = useToast();
  const { t, enabled: enabledLocales } = useT();
  const { me, reload } = usePanelMe();
  const prefs = me?.preferences;
  const actingAs = me?.actingAs;
  const [draft, setDraft] = useState(() => draftFrom(prefs));
  const [locale, setLocale] = useState(prefs?.locale || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { setDraft(draftFrom(prefs)); setLocale(prefs?.locale || ''); }, [prefs]);

  const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
  const setNotify = (key) => (value) => setDraft((d) => ({ ...d, notify: { ...d.notify, [key]: value } }));

  const saveContact = async (e) => {
    e?.preventDefault?.();
    const problem = validateContact(draft);
    if (problem) { setError({ status: 422, message: t('panel.overview.check_addresses', 'Check the addresses'), ...problem }); return; }
    if (!actingAs && !draft.currentPassword) { setError({ status: 422, message: t('panel.overview.confirm_password', 'Confirm the change with your current password'), fields: { currentPassword: [t('panel.overview.pw_enter_current', 'Enter your current password')] } }); return; }
    setBusy('contact'); setError(null);
    try {
      await panelApi.put('/me/contact', { email: draft.email.trim(), email2: draft.email2.trim() || null, notify: draft.notify, ...(actingAs ? {} : { currentPassword: draft.currentPassword }) });
      toast.success(t('panel.overview.saved', 'Preferences saved'));
      setDraft((d) => ({ ...d, currentPassword: '' }));
      reload?.();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const saveLocale = async (e) => {
    e?.preventDefault?.();
    setBusy('locale'); setError(null);
    try {
      await panelApi.put('/me/locale', { locale: locale || null });
      await setPreferredLocale(locale || null);
      toast.success(t('panel.overview.language_saved', 'Language saved'));
      reload?.();
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const locales = (prefs?.locales?.length ? prefs.locales : (enabledLocales || []).map((code) => ({ code, name: code })));
  const options = [{ value: '', label: `${t('panel.overview.server_default', 'Server default')} (${prefs?.defaultLocale || 'en'})` }, ...locales.map((l) => ({ value: l.code, label: `${l.name} (${l.code})` }))];

  return (
    <PanelPage fn={fn}>
      {!me && <Loading />}
      {me && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <Card title={t('panel.overview.contact', 'Contact information')} subtitle={t('panel.overview.contact_help', 'Where the server reaches you: password resets and the notices below go to these addresses.')}>
            <form onSubmit={saveContact}>
              <ErrorBanner error={error?.fields ? null : error} />
              <Field label={t('panel.overview.email', 'Contact email')} required htmlFor="pref-email" error={error?.fields?.email} help={t('panel.overview.email_help', 'Also the address the sign-in page sends password-reset links to.')}>
                <TextInput id="pref-email" type="email" autoComplete="email" value={draft.email} onChange={set('email')} maxLength={254} />
              </Field>
              <Field label={t('panel.overview.email2', 'Second contact email')} htmlFor="pref-email2" error={error?.fields?.email2} help={t('panel.overview.email2_help', 'Optional. Gets a copy of every notice.')}>
                <TextInput id="pref-email2" type="email" value={draft.email2} onChange={set('email2')} maxLength={254} />
              </Field>
              <Field label={t('panel.overview.notifications', 'Notifications')}>
                {NOTIFICATIONS.map(([key, label, help]) => (
                  <Toggle key={key} checked={draft.notify[key]} onChange={setNotify(key)} label={t(`panel.overview.notify_${key}`, label)} description={t(`panel.overview.notify_${key}_help`, help)} />
                ))}
              </Field>
              {!actingAs && (
                <Field label={t('panel.overview.current_password', 'Current password')} required htmlFor="pref-current-password" error={error?.fields?.currentPassword} help={t('panel.overview.current_password_help', 'These addresses receive password-reset links, so changing them takes your password.')}>
                  <TextInput id="pref-current-password" type="password" autoComplete="current-password" value={draft.currentPassword} onChange={set('currentPassword')} />
                </Field>
              )}
              <FormActions>
                <Button type="submit" variant="primary" icon={Save} loading={busy === 'contact'} disabled={Boolean(busy)}>{t('panel.overview.save', 'Save')}</Button>
              </FormActions>
            </form>
          </Card>
          <Card title={t('panel.overview.language', 'Language')} subtitle={t('panel.overview.language_help', 'The language of this panel for your login. The server default applies until you pick one.')}>
            {actingAs ? (
              <>
                <KeyValue items={[[t('panel.overview.language', 'Language'), prefs?.locale || t('panel.overview.server_default', 'Server default')]]} />
                <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>{t('panel.overview.language_acting', 'The language belongs to the account login and is not changed while logged in as the account.')}</p>
              </>
            ) : (
              <form onSubmit={saveLocale}>
                <Field label={t('panel.overview.language', 'Language')} htmlFor="pref-locale" error={error?.fields?.locale}>
                  <Select id="pref-locale" value={locale} onChange={setLocale} options={options} />
                </Field>
                <FormActions>
                  <Button type="submit" variant="primary" icon={Languages} loading={busy === 'locale'} disabled={Boolean(busy)}>{t('panel.overview.save_language', 'Save language')}</Button>
                </FormActions>
              </form>
            )}
          </Card>
        </div>
      )}
    </PanelPage>
  );
}
