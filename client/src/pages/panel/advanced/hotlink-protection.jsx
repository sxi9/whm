import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus, ImageOff, X } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { RequestError } from '../files/parts/common.jsx';
import { managerHref, isCapabilityError, isFeatureDisabled } from '../files/parts/paths.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REDIRECT_RE = /^https?:\/\/[^\s"'\\$%#[\]]+$/;
export const DEFAULT_EXTENSIONS = ['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp'];
export const EXTENSION_GROUPS = [
  ['images', ['jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff']],
  ['media', ['mp4', 'webm', 'mov', 'mp3', 'ogg', 'wav']],
  ['documents', ['pdf', 'zip', 'rar', '7z']],
];

// Quick shape checks; the server validates for real.
export const normalizeHost = (h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
export function hostProblem(input, t = untranslated) {
  const h = normalizeHost(input);
  if (!h) return null;
  if (!HOST_RE.test(h)) return t('panel.advanced.host_invalid', 'Enter a hostname such as partner.example.com');
  return null;
}
export function redirectProblem(input, extensions, t = untranslated) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (!REDIRECT_RE.test(s)) return t('panel.advanced.redirect_invalid', 'Enter an http(s) address without spaces, quotes, "$", "%" or "#"');
  let pathname = '';
  try { pathname = new URL(s).pathname.toLowerCase(); } catch { return t('panel.advanced.redirect_invalid', 'Enter an http(s) address without spaces, quotes, "$", "%" or "#"'); }
  if (extensions.some((e) => pathname.endsWith(`.${e}`))) return t('panel.advanced.redirect_loops', 'The address must not be one of the protected file types, or it would be blocked too');
  return null;
}

export default function HotlinkProtection({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const { data, error, loading, refetch } = usePanelApi('/advanced/hotlink');
  const [form, setForm] = useState(null);
  const [host, setHost] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [probe, setProbe] = useState(null);
  useEffect(() => { setForm(null); setSaveError(null); }, [data]);
  const capability = isCapabilityError(error);
  const current = data ? { enabled: data.enabled, hosts: data.hosts, extensions: data.extensions, allowBlank: data.allowBlank, redirect: data.redirect ?? '' } : { enabled: false, hosts: [], extensions: DEFAULT_EXTENSIONS, allowBlank: true, redirect: '' };
  const f = form ?? current;
  const dirty = form != null && JSON.stringify(form) !== JSON.stringify(current);
  const patch = (p) => setForm({ ...f, ...p });
  const available = data?.available ?? EXTENSION_GROUPS.flatMap(([, list]) => list);
  const hostErr = hostProblem(host, t);
  const redirectErr = redirectProblem(f.redirect, f.extensions, t);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const addHost = (e) => {
    e?.preventDefault();
    const h = normalizeHost(host);
    if (!h || hostErr) return;
    if (f.hosts.includes(h) || (data?.domains ?? []).includes(h)) { setHost(''); return; }
    patch({ hosts: [...f.hosts, h] });
    setHost('');
  };
  const toggleExt = (ext) => patch({ extensions: f.extensions.includes(ext) ? f.extensions.filter((x) => x !== ext) : [...f.extensions, ext] });

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data: res } = await panelApi.put('/advanced/hotlink', { enabled: f.enabled, hosts: f.hosts, extensions: f.extensions, allowBlank: f.allowBlank, redirect: f.redirect.trim() || null });
      setProbe(res.probe);
      toast.success(res.enabled ? t('panel.advanced.hotlink_enabled', 'Hotlink protection is on') : t('panel.advanced.hotlink_disabled', 'Hotlink protection is off'));
      refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const groupLabel = { images: t('panel.advanced.ext_images', 'Images'), media: t('panel.advanced.ext_media', 'Audio and video'), documents: t('panel.advanced.ext_documents', 'Documents and archives') };
  const probeText = probe && (probe.status
    ? fill(t('panel.advanced.probe_answered', 'Checked: the site answered {status}'), { status: probe.status })
    : `${t('panel.advanced.probe_failed', 'The site could not be probed')}${probe.error ? ` (${probe.error})` : ''}`);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <Card title={t('panel.advanced.hotlink_status_title', 'Status')} subtitle={t('panel.advanced.hotlink_status_help', 'Hotlinking is when another website embeds your images or files directly, using your bandwidth. The rule covers every site of this account.')}>
        {capability && <PanelCapabilityState error={error} onRetry={refetch} />}
        {!capability && <RequestError error={error} onRetry={refetch} />}
        {data && (
          <KeyValue items={[
            [t('panel.advanced.hotlink_state', 'Protection'), <StatusPill key="s" status={data.enabled ? 'ok' : 'unknown'}>{data.enabled ? t('panel.advanced.hotlink_on', 'On') : t('panel.advanced.hotlink_off', 'Off')}</StatusPill>],
            [t('panel.advanced.your_domains', 'Your domains (always allowed)'), <span key="d">{(data.domains ?? []).map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>)}</span>],
            [t('panel.advanced.folder', 'Folder'), <code key="f">~/{data.path}</code>],
          ]} />
        )}
        {!error && (
          <Toggle checked={f.enabled} onChange={(v) => patch({ enabled: v })} disabled={!data} label={t('panel.advanced.hotlink_toggle', 'Block hotlinking')} description={t('panel.advanced.hotlink_toggle_help', 'Requests for the protected file types are refused (403) or redirected unless they come from one of the allowed sites.')} />
        )}
      </Card>

      {!error && (
        <Card title={t('panel.advanced.hotlink_rules_title', 'Rules')} subtitle={t('panel.advanced.hotlink_rules_help', 'Which sites may embed your files, which file types are protected, and what a blocked request gets.')}>
          <Field label={t('panel.advanced.extra_hosts', 'Other sites allowed to embed your files')} help={t('panel.advanced.extra_hosts_help', 'Partner sites or a CDN; www. is implied.')} htmlFor="hl-host" error={hostErr}>
            <form onSubmit={addHost} className="input-group" style={{ maxWidth: 560 }}>
              <TextInput id="hl-host" value={host} onChange={setHost} placeholder="partner.example.com" spellCheck={false} disabled={!data || !f.enabled} />
              <Button type="submit" icon={Plus} disabled={!data || !f.enabled || !normalizeHost(host) || Boolean(hostErr)}>{t('panel.advanced.add_host', 'Add')}</Button>
            </form>
            {f.hosts.length > 0 && (
              <ul className="chip-list" style={{ listStyle: 'none', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {f.hosts.map((h) => <li key={h}><code>{h}</code> <button type="button" className="btn btn-ghost btn-sm" aria-label={fill(t('panel.advanced.remove_host', 'Remove {host}'), { host: h })} onClick={() => patch({ hosts: f.hosts.filter((x) => x !== h) })} disabled={!f.enabled}><X size={12} /></button></li>)}
              </ul>
            )}
          </Field>

          <Toggle checked={f.allowBlank} onChange={(v) => patch({ allowBlank: v })} disabled={!data || !f.enabled} label={t('panel.advanced.allow_blank', 'Allow direct requests')} description={t('panel.advanced.allow_blank_help', 'A request without a Referer header (a typed address, a bookmark, some privacy settings and most feed readers) is let through. Turn this off only if you want those blocked too.')} />

          <fieldset className="field" style={{ marginTop: 12 }}>
            <legend className="field-label">{t('panel.advanced.protected_types', 'Protected file types')}</legend>
            <div className="form-grid">
              {EXTENSION_GROUPS.map(([group, list]) => (
                <div key={group}>
                  <div className="muted small" style={{ marginBottom: 4 }}>{groupLabel[group]}</div>
                  {list.filter((x) => available.includes(x)).map((ext) => (
                    <label key={ext} className="radio"><input type="checkbox" checked={f.extensions.includes(ext)} onChange={() => toggleExt(ext)} disabled={!f.enabled} /><span><code>.{ext}</code></span></label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>

          <Field label={t('panel.advanced.redirect_to', 'Send blocked requests to')} help={t('panel.advanced.redirect_help', 'Leave empty to answer 403 Forbidden. An address of your own site must not be a protected file type.')} htmlFor="hl-redirect" error={redirectErr || saveError?.fields?.redirect}>
            <TextInput id="hl-redirect" value={f.redirect} onChange={(v) => patch({ redirect: v })} placeholder="https://example.com/no-hotlinking.html" spellCheck={false} disabled={!data || !f.enabled} maxLength={2048} />
          </Field>

          {saveError && <RequestError error={saveError} />}
          <FormActions>
            <Button variant="primary" loading={saving} disabled={!data || !dirty || loading || Boolean(redirectErr) || (f.enabled && !f.extensions.length)} onClick={save}>{t('common.save', 'Save')}</Button>
            <Button disabled={!dirty || saving} onClick={() => setForm(null)}>{t('panel.advanced.reset', 'Reset')}</Button>
            {probe && <span className="muted small">{probeText}</span>}
          </FormActions>
        </Card>
      )}
      <p className="muted small"><ImageOff size={12} /> {t('panel.advanced.hotlink_note_before', 'The rules are')} <code>RewriteCond %{'{'}HTTP_REFERER{'}'}</code> {t('panel.advanced.hotlink_note_middle', 'lines in')} <code>~/public_html/.htaccess</code>{t('panel.advanced.hotlink_note_after', ', kept between the panel\'s markers; addon and subdomain folders under public_html inherit them. Open the folder in the')} <Link to={managerHref('public_html')}>{t('panel.advanced.file_manager_link', 'file manager')}</Link>{t('panel.advanced.hotlink_note_end', ' to see the file.')}</p>
    </PanelPage>
  );
}
