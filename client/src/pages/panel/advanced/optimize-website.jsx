import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, Zap } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { RequestError } from '../files/parts/common.jsx';
import { managerHref, isCapabilityError, isFeatureDisabled } from '../files/parts/paths.js';
import { FolderPicker, folderFromParams } from '../files/parts/FolderPicker.jsx';

export const MODES = ['off', 'all', 'custom'];

// The catalogue the server offers, grouped for the custom picker.
export const TYPE_GROUPS = [
  ['pages', ['text/html', 'application/xhtml+xml', 'text/plain', 'text/xml', 'application/xml', 'application/rss+xml', 'application/atom+xml']],
  ['assets', ['text/css', 'text/javascript', 'application/javascript', 'application/x-javascript', 'application/json', 'image/svg+xml']],
  ['fonts', ['font/ttf', 'font/otf', 'font/woff', 'font/woff2', 'application/vnd.ms-fontobject']],
];

export function modeLabel(mode, t = untranslated) {
  if (mode === 'all') return t('panel.advanced.optimize_all', 'Compress all content');
  if (mode === 'custom') return t('panel.advanced.optimize_custom', 'Compress the selected types');
  return t('panel.advanced.optimize_off', 'Disabled');
}

export function modeOf(types, available) {
  if (!types?.length) return 'off';
  return available.every((x) => types.includes(x)) ? 'all' : 'custom';
}

export default function OptimizeWebsite({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const folder = folderFromParams(params);
  const { data, error, loading, refetch } = usePanelApi(`/advanced/optimize?path=${encodeURIComponent(folder)}`);
  const [mode, setMode] = useState(null);
  const [types, setTypes] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [probe, setProbe] = useState(null);
  useEffect(() => { setMode(null); setTypes(null); setSaveError(null); }, [data]);
  const capability = isCapabilityError(error);
  const available = data?.available ?? TYPE_GROUPS.flatMap(([, list]) => list);
  const currentMode = data?.mode ?? 'off';
  const currentTypes = data?.types ?? [];
  const value = mode ?? currentMode;
  const chosen = types ?? (currentTypes.length ? currentTypes : available);
  const dirty = value !== currentMode || (value === 'custom' && (chosen.length !== currentTypes.length || chosen.some((x) => !currentTypes.includes(x))));
  const toggle = (type) => setTypes(chosen.includes(type) ? chosen.filter((x) => x !== type) : [...chosen, type]);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data: res } = await panelApi.put('/advanced/optimize', { path: folder, mode: value, types: value === 'custom' ? chosen : [] });
      setProbe(res.probe);
      toast.success(fill(t('panel.advanced.optimize_saved', '{mode} for ~/{folder}'), { mode: modeLabel(res.mode, t), folder }));
      refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const options = [
    { value: 'off', label: modeLabel('off', t), description: t('panel.advanced.optimize_off_help', 'Files are sent as they are. Visitors on slow connections wait longer for pages, styles and scripts.') },
    { value: 'all', label: modeLabel('all', t), description: t('panel.advanced.optimize_all_help', 'Pages, styles, scripts, feeds, SVG images and fonts are compressed before they leave the server. Photos, video and archives are never recompressed.') },
    { value: 'custom', label: modeLabel('custom', t), description: t('panel.advanced.optimize_custom_help', 'Pick the content types to compress from the list below.') },
  ];
  const groupLabel = { pages: t('panel.advanced.types_pages', 'Pages and feeds'), assets: t('panel.advanced.types_assets', 'Styles, scripts and SVG'), fonts: t('panel.advanced.types_fonts', 'Fonts') };
  const probeText = probe && (probe.status
    ? fill(t('panel.advanced.probe_answered', 'Checked: the site answered {status}'), { status: probe.status })
    : `${t('panel.advanced.probe_failed', 'The site could not be probed')}${probe.error ? ` (${probe.error})` : ''}`);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <Card title={t('panel.advanced.folder', 'Folder')} subtitle={t('panel.advanced.optimize_folder_help', 'Compression is set per folder and applies to everything below it; public_html covers your whole main site.')}>
        <FolderPicker value={folder} onChange={(p) => setParams({ path: p })} />
        {data && (
          <KeyValue items={[
            [t('panel.advanced.folder', 'Folder'), <code key="f">~/{data.path}</code>],
            [t('panel.advanced.served_as', 'Served as'), data.domain],
            [t('panel.advanced.compression', 'Compression'), <span key="c"><StatusPill status={currentMode === 'off' ? 'unknown' : 'ok'}>{modeLabel(currentMode, t)}</StatusPill>{currentMode === 'custom' ? <span className="muted small"> · {fill(t('panel.advanced.types_count', '{count} content types'), { count: currentTypes.length })}</span> : null}</span>],
          ]} />
        )}
      </Card>

      <Card title={t('panel.advanced.optimize_title', 'Compression (gzip)')} subtitle={t('panel.advanced.optimize_subtitle', 'Browsers that accept compressed responses get them; others get the file as it is.')}>
        {capability && <PanelCapabilityState error={error} onRetry={refetch} />}
        {!capability && <RequestError error={error} onRetry={refetch} />}
        {error?.status === 422 && <p className="muted">{t('panel.advanced.choose_folder_inside', 'Choose a folder inside')} <code>public_html</code> {t('panel.advanced.or_addon_folders', 'or one of your addon or subdomain folders.')}</p>}
        {!error && (
          <>
            <RadioGroup name="optimize" value={value} onChange={setMode} options={options} />
            {value === 'custom' && (
              <div className="form-grid" style={{ marginTop: 12 }}>
                {TYPE_GROUPS.map(([group, list]) => (
                  <fieldset key={group} className="field">
                    <legend className="field-label">{groupLabel[group]}</legend>
                    {list.filter((x) => available.includes(x)).map((type) => (
                      <label key={type} className="radio"><input type="checkbox" checked={chosen.includes(type)} onChange={() => toggle(type)} /><span><code>{type}</code></span></label>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
            {saveError && <RequestError error={saveError} />}
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!data || !dirty || loading || (value === 'custom' && !chosen.length)} onClick={save}>{t('common.save', 'Save')}</Button>
              <Button disabled={!dirty || saving} onClick={() => { setMode(null); setTypes(null); }}>{t('panel.advanced.reset', 'Reset')}</Button>
              {probe && <span className="muted small">{probeText}</span>}
            </FormActions>
          </>
        )}
      </Card>
      <p className="muted small"><Zap size={12} /> {t('panel.advanced.optimize_note_before', 'The rule is an')} <code>AddOutputFilterByType DEFLATE</code> {t('panel.advanced.optimize_note_middle', 'line in')} <code>~/{folder}/.htaccess</code>{t('panel.advanced.optimize_note_after', ', kept between the panel\'s markers; check it with a tool that shows response headers (Content-Encoding: gzip). Open the folder in the')} <Link to={managerHref(folder)}>{t('panel.advanced.file_manager_link', 'file manager')}</Link>{t('panel.advanced.optimize_note_end', ' to see the file.')}</p>
    </PanelPage>
  );
}
