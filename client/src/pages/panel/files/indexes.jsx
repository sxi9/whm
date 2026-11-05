import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, List } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT, translate } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { RequestError } from './parts/common.jsx';
import { managerHref, isCapabilityError, isFeatureDisabled } from './parts/paths.js';
import { FolderPicker, folderFromParams } from './parts/FolderPicker.jsx';

export const INDEX_OPTIONS = [
  { value: 'inherit', label: 'Server default', description: 'No rule of your own in this folder: it behaves like its parent (the server hides listings unless a folder above turned them on).' },
  { value: 'off', label: 'No indexing', description: 'A folder without an index page answers 403 Forbidden instead of listing its files.' },
  { value: 'on', label: 'Show the file list', description: 'A folder without an index page shows its files and sub-folders to visitors.' },
];

export const indexLabel = (value) => { const o = INDEX_OPTIONS.find((x) => x.value === value); return o ? translate(`panel.files.index_${o.value}`, o.label) : value; };

export default function Indexes({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const folder = folderFromParams(params);
  const { data, error, loading, refetch } = usePanelApi(`/files/indexes?path=${encodeURIComponent(folder)}`);
  const [choice, setChoice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [probe, setProbe] = useState(null);
  useEffect(() => { setChoice(null); setSaveError(null); }, [data]);
  const capability = isCapabilityError(error);
  const current = data?.indexes ?? 'inherit';
  const value = choice ?? current;
  const dirty = value !== current;
  const options = INDEX_OPTIONS.map((o) => ({ value: o.value, label: t(`panel.files.index_${o.value}`, o.label), description: t(`panel.files.index_${o.value}_help`, o.description) }));

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data: res } = await panelApi.put('/files/indexes', { path: folder, indexes: value });
      setProbe(res.probe);
      toast.success(fill(t('panel.files.index_saved', '{rule} for ~/{folder}'), { rule: indexLabel(value), folder }));
      refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const probeText = probe && (probe.status
    ? fill(t('panel.files.probe_answered', 'Checked: the folder answered {status}'), { status: probe.status })
    : `${t('panel.files.probe_failed', 'The folder could not be probed')}${probe.error ? ` (${probe.error})` : ''}`);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('panel.files.refresh', 'Refresh')}</Button>}>
      <Card title={t('panel.files.folder', 'Folder')} subtitle={t('panel.files.index_folder_help', 'Pick a folder of your website; the rule applies to it and to every folder below it that has no rule of its own.')}>
        <FolderPicker value={folder} onChange={(p) => setParams({ path: p })} />
        {data && (
          <KeyValue items={[
            [t('panel.files.folder', 'Folder'), <code key="f">~/{data.path}</code>],
            [t('panel.files.served_as', 'Served as'), data.domain],
            [t('panel.files.rule', 'Rule'), <span key="r"><StatusPill status={current === 'inherit' ? 'unknown' : current === 'off' ? 'ok' : 'warning'}>{indexLabel(current)}</StatusPill>{data.managed ? '' : <span className="muted small"> · {t('panel.files.no_panel_rules', 'no panel rules in this folder yet')}</span>}</span>],
          ]} />
        )}
      </Card>

      <Card title={t('panel.files.directory_listing', 'Directory listing')} subtitle={fill(t('panel.files.directory_listing_help', 'What visitors see when they open a folder under ~/{folder} that has no index.html or index.php.'), { folder })}>
        {capability && <PanelCapabilityState error={error} onRetry={refetch} />}
        {!capability && <RequestError error={error} onRetry={refetch} />}
        {error?.status === 422 && <p className="muted">{t('panel.files.choose_folder_inside', 'Choose a folder inside')} <code>public_html</code> {t('panel.files.or_addon_folders', 'or one of your addon or subdomain folders.')}</p>}
        {!error && (
          <>
            <RadioGroup name="indexes" value={value} onChange={setChoice} options={options} />
            {saveError && <RequestError error={saveError} />}
            <FormActions>
              <Button variant="primary" loading={saving} disabled={!data || !dirty || loading} onClick={save}>{t('panel.files.save', 'Save')}</Button>
              <Button disabled={!dirty || saving} onClick={() => setChoice(null)}>{t('panel.files.reset', 'Reset')}</Button>
              {probe && <span className="muted small">{probeText}</span>}
            </FormActions>
          </>
        )}
      </Card>
      <p className="muted small"><List size={12} /> {t('panel.files.index_rule_is', 'The rule is an')} <code>Options ±Indexes</code> {t('panel.files.index_line_in', 'line in')} <code>~/{folder}/.htaccess</code>{t('panel.files.index_kept_between', ', kept between the panel\'s markers. Open the folder in the')} <Link to={managerHref(folder)}>{t('panel.files.file_manager_link', 'file manager')}</Link> {t('panel.files.index_to_see', 'to see the file.')}</p>
    </PanelPage>
  );
}
