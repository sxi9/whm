import { useMemo, useState } from 'react';
import { RefreshCw, Download, ScrollText, AlertTriangle, Eye } from 'lucide-react';
import { Card, KeyValue, EmptyState, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, filesForDomain, domainOfFile, locationLabel, RequestError } from './parts/shared.jsx';

const TAIL_SIZES = [{ value: '16384', size: '16 KB' }, { value: '65536', size: '64 KB' }, { value: '262144', size: '256 KB' }, { value: '1048576', size: '1 MB' }];
const KINDS = [{ value: 'apache', label: 'Apache' }, { value: 'nginx', label: 'NGINX' }];

export const downloadHref = (kind, file) => `/api/panel/logs/download?kind=${encodeURIComponent(kind)}&file=${encodeURIComponent(file)}`;

function RetentionCard({ disabled }) {
  const toast = useToast();
  const { t } = useT();
  const { data, error, loading, refetch, setData } = usePanelApi('/logs/retention');
  const [busy, setBusy] = useState(false);
  const save = async (patch) => {
    setBusy(true);
    try { const { data: res } = await panelApi.put('/logs/retention', patch); setData(res); toast.success(t('panel.logs.retention_saved', 'Log retention saved')); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title={t('panel.logs.retention_title', 'Log retention')} subtitle={t('panel.logs.retention_subtitle', 'What happens to raw logs at the end of each month.')}>
      <PanelCapabilityState error={error} onRetry={refetch} />
      <RequestError error={isFeatureDisabled(error) ? null : error} onRetry={refetch} />
      {loading && !data && <p className="muted">{t('common.loading', 'Loading…')}</p>}
      {data && (
        <>
          <Field inline><Toggle checked={Boolean(data.archiveLogs)} onChange={(v) => save({ archiveLogs: v })} disabled={disabled || busy} label={t('panel.logs.archive_monthly', 'Archive logs monthly')} description={fill(t('panel.logs.archive_monthly_help', 'Keeps a compressed copy of each month\'s logs in {dir}'), { dir: data.archiveDir || t('panel.logs.your_logs_folder', 'your logs folder') })} /></Field>
          <Field inline><Toggle checked={Boolean(data.removeOldArchives)} onChange={(v) => save({ removeOldArchives: v })} disabled={disabled || busy} label={t('panel.logs.remove_old', 'Remove old archives')} description={data.retainMonths ? plural(t, 'panel.logs.remove_old_months', data.retainMonths, 'Archives older than {count} month are deleted', 'Archives older than {count} months are deleted') : t('panel.logs.remove_old_help', 'Old archives are deleted automatically')} /></Field>
          <KeyValue items={[[t('panel.logs.last_archived', 'Last archived'), data.lastArchivedAt ? formatDate(data.lastArchivedAt) : t('panel.logs.never', 'Never')], [t('panel.logs.archive_folder', 'Archive folder'), data.archiveDir ? <code key="d">{data.archiveDir}</code> : null]]} />
        </>
      )}
    </Card>
  );
}

export default function AccessLogs({ fn }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const [kind, setKind] = useState('apache');
  const [domain, setDomain] = useState('');
  const [fileChoice, setFile] = useState('');
  const [bytes, setBytes] = useState('65536');
  const [live, setLive] = useState(false);
  const { data, error, loading, refetch } = usePanelApi(`/logs?kind=${kind}`);
  const capability = isCapabilityError(error);
  const domains = [...new Set(data?.domains || [])];
  const files = useMemo(() => filesForDomain(data?.files, domain), [data, domain]);
  // The first file of the selection is shown until the user picks another one.
  const file = files.some((f) => f.name === fileChoice) ? fileChoice : (files[0]?.name || '');
  const selected = files.find((f) => f.name === file) || null;
  const tail = usePanelApi(file ? `/logs/tail?kind=${kind}&file=${encodeURIComponent(file)}&bytes=${bytes}` : null, { enabled: Boolean(file), refreshMs: live && file ? 5000 : 0 });

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const kindOptions = KINDS.map((k) => ({ ...k, label: data && data[k.value] === false ? fill(t('panel.logs.kind_not_installed', '{kind} (not installed)'), { kind: k.label }) : k.label }));
  const kindLabel = KINDS.find((k) => k.value === kind)?.label || kind;
  const tailSizes = TAIL_SIZES.map((s) => ({ value: s.value, label: fill(t('panel.logs.last_size', 'Last {size}'), { size: s.size }) }));
  // A 200 listing can still report the chosen server as absent (`apache:false`).
  const missing = capability ? error : data && data[kind] === false ? { status: 501, code: 'capability_missing', message: fill(t('panel.logs.kind_missing', '{kind} is not installed on this server, so there are no {kind} logs to show.'), { kind: kindLabel }) } : null;
  const lines = tail.data?.content ? tail.data.content.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1) : [];
  const updated = (mtime) => fill(t('panel.logs.updated_at', 'updated {date}'), { date: formatDate(mtime) });

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => { refetch(); if (file) tail.refetch(); }}>{t('common.refresh', 'Refresh')}</Button>}>
      {data?.warnings?.length > 0 && (
        <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>{t('panel.logs.skipped_title', 'Some log locations were skipped')}</strong><ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>
      )}
      {/* The missing web server is said once, above the grid; the pickers stay so another server can be chosen. */}
      {missing && <PanelCapabilityState card error={missing} onRetry={refetch} />}
      <div className="grid-2">
        <Card title={t('panel.logs.choose_title', 'Choose a log')} subtitle={missing ? fill(t('panel.logs.files_empty_capability', 'Log files appear here once {kind} is available on this server.'), { kind: kindLabel }) : t('panel.logs.choose_subtitle', 'Raw web server logs for the domains on this account.')}>
          <RequestError error={error} onRetry={refetch} />
          <div className="form-grid">
            <Field label={t('panel.logs.web_server', 'Web server')} htmlFor="logs-kind"><Select id="logs-kind" value={kind} onChange={(v) => { setKind(v); setFile(''); }} options={kindOptions} /></Field>
            <Field label={t('panel.logs.domain', 'Domain')} htmlFor="logs-domain"><Select id="logs-domain" value={domain} onChange={(v) => { setDomain(v); setFile(''); }} placeholder={t('panel.logs.all_domains', 'All domains')} options={domains} /></Field>
          </div>
          <Field label={t('panel.logs.log_file', 'Log file')} htmlFor="logs-file" help={selected ? `${locationLabel(selected.location, t)} · ${formatBytes(selected.size)} · ${updated(selected.mtime)}` : files.length ? undefined : t('panel.logs.no_files_selection', 'No log files yet for this selection')}>
            <Select id="logs-file" value={file} onChange={setFile} placeholder={files.length ? t('panel.logs.choose_file', 'Choose a file') : t('panel.logs.no_files', 'No files')} options={files.map((f) => ({ value: f.name, label: f.name }))} disabled={!files.length} />
          </Field>
          <div className="form-grid">
            <Field label={t('panel.logs.show', 'Show')} htmlFor="logs-bytes"><Select id="logs-bytes" value={bytes} onChange={setBytes} options={tailSizes} /></Field>
            <Field label={t('panel.logs.follow', 'Follow')} htmlFor="logs-follow"><Toggle checked={live} onChange={setLive} label={t('panel.logs.follow_label', 'Refresh every 5 seconds')} description={t('panel.logs.follow_help', 'Keeps the view current while you watch traffic')} disabled={!file} /></Field>
          </div>
          <FormActions>
            <Button icon={Eye} disabled={!file} onClick={() => tail.refetch()}>{t('panel.logs.reload_view', 'Reload view')}</Button>
            {file && <a className="btn" href={downloadHref(kind, file)} download><Download size={16} /> {t('common.download', 'Download')} {file}</a>}
          </FormActions>
        </Card>
        <RetentionCard disabled={Boolean(me?.actingAs)} />
      </div>

      {!missing && <Card title={file ? fill(t('panel.logs.tail_of', 'Tail of {file}'), { file }) : t('panel.logs.log_view', 'Log view')} subtitle={tail.data ? `${tail.data.truncated ? t('panel.logs.last', 'Last') : t('panel.logs.all', 'All')} ${fill(t('panel.logs.bytes_of', '{shown} of {total}'), { shown: formatBytes(tail.data.length), total: formatBytes(tail.data.size) })}${tail.data.mtime ? ` · ${updated(tail.data.mtime)}` : ''}` : undefined}
        actions={tail.data && <span className="muted small">{plural(t, 'panel.logs.lines', lines.length, '{count} line', '{count} lines')}{live ? ` · ${t('panel.logs.following', 'following')}` : ''}</span>}>
        <PanelCapabilityState error={tail.error} onRetry={tail.refetch} />
        <RequestError error={tail.error} onRetry={tail.refetch} />
        {!file && (
          <EmptyState icon={ScrollText} title={t('panel.logs.nothing_selected', 'Nothing selected')}><p>{t('panel.logs.nothing_selected_text', 'Choose a domain and a log file above. The last part of the file shows here and can be followed live.')}</p>{data && !data.files?.length && <p className="muted">{t('panel.logs.no_files_yet', 'No log files exist yet. The web server writes the first lines when a visitor opens one of your domains.')}</p>}</EmptyState>
        )}
        {file && tail.data && tail.data.size === 0 && <EmptyState icon={ScrollText} title={t('panel.logs.empty_log', 'This log is empty')}><p>{t('panel.logs.empty_log_text', 'Requests appear here as soon as the web server records them.')}</p></EmptyState>}
        {file && tail.data && tail.data.size > 0 && <pre className="log">{tail.data.content}</pre>}
        {file && tail.loading && !tail.data && <p className="muted">{t('panel.logs.reading', 'Reading the log…')}</p>}
      </Card>}

      {!missing && <Card title={t('panel.logs.files_title', 'Log files')} subtitle={data?.files?.length ? plural(t, 'panel.logs.files_count', data.files.length, '{count} file for {domain}', '{count} files for {domain}', { domain: domain || t('panel.logs.all_domains_lower', 'all domains') }) : undefined} padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: t('panel.logs.col_file', 'File'), render: (f) => <code>{f.name}</code> },
            { key: 'domain', label: t('panel.logs.domain', 'Domain'), render: (f) => domainOfFile(f.name, domains) || <span className="muted">—</span> },
            { key: 'location', label: t('panel.logs.col_location', 'Location'), render: (f) => locationLabel(f.location, t) },
            { key: 'size', label: t('panel.logs.col_size', 'Size'), align: 'right', render: (f) => formatBytes(f.size) },
            { key: 'mtime', label: t('panel.logs.col_updated', 'Updated'), render: (f) => formatDate(f.mtime) },
          ]}
          rows={files} loading={loading} error={capability || isFeatureDisabled(error) ? null : error} rowKey={(f) => f.name} dense
          rowActions={(f) => [
            { label: t('panel.logs.view', 'View'), primary: true, onClick: () => { setFile(f.name); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            { label: t('common.download', 'Download'), onClick: () => { window.location.href = downloadHref(kind, f.name); } },
          ]}
          emptyText={t('panel.logs.files_empty', 'No log files yet. The web server creates one per domain once it has served a request; archived months land in your logs folder.')}
        />
      </Card>}
    </PanelPage>
  );
}
