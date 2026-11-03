import { useMemo, useState } from 'react';
import { RefreshCw, Download, ScrollText, AlertTriangle, Eye } from 'lucide-react';
import { Card, KeyValue, EmptyState, formatBytes, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, filesForDomain, domainOfFile, LOCATION_LABELS, RequestError } from './parts/shared.jsx';

const TAIL_SIZES = [{ value: '16384', label: 'Last 16 KB' }, { value: '65536', label: 'Last 64 KB' }, { value: '262144', label: 'Last 256 KB' }, { value: '1048576', label: 'Last 1 MB' }];
const KINDS = [{ value: 'apache', label: 'Apache' }, { value: 'nginx', label: 'NGINX' }];

export const downloadHref = (kind, file) => `/api/panel/logs/download?kind=${encodeURIComponent(kind)}&file=${encodeURIComponent(file)}`;

function RetentionCard({ disabled }) {
  const toast = useToast();
  const { data, error, loading, refetch, setData } = usePanelApi('/logs/retention');
  const [busy, setBusy] = useState(false);
  const save = async (patch) => {
    setBusy(true);
    try { const { data: res } = await panelApi.put('/logs/retention', patch); setData(res); toast.success('Log retention saved'); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Card title="Log retention" subtitle="What happens to raw logs at the end of each month.">
      <PanelCapabilityState error={error} onRetry={refetch} />
      <RequestError error={isFeatureDisabled(error) ? null : error} onRetry={refetch} />
      {loading && !data && <p className="muted">Loading…</p>}
      {data && (
        <>
          <Field inline><Toggle checked={Boolean(data.archiveLogs)} onChange={(v) => save({ archiveLogs: v })} disabled={disabled || busy} label="Archive logs monthly" description={`Keeps a compressed copy of each month's logs in ${data.archiveDir || 'your logs folder'}`} /></Field>
          <Field inline><Toggle checked={Boolean(data.removeOldArchives)} onChange={(v) => save({ removeOldArchives: v })} disabled={disabled || busy} label="Remove old archives" description={data.retainMonths ? `Archives older than ${data.retainMonths} month${data.retainMonths === 1 ? '' : 's'} are deleted` : 'Old archives are deleted automatically'} /></Field>
          <KeyValue items={[['Last archived', data.lastArchivedAt ? formatDate(data.lastArchivedAt) : 'Never'], ['Archive folder', data.archiveDir ? <code key="d">{data.archiveDir}</code> : null]]} />
        </>
      )}
    </Card>
  );
}

export default function AccessLogs({ fn }) {
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

  const kindOptions = KINDS.map((k) => ({ ...k, label: data && data[k.value] === false ? `${k.label} (not installed)` : k.label }));
  const kindLabel = KINDS.find((k) => k.value === kind)?.label || kind;
  // A 200 listing can still report the chosen server as absent (`apache:false`).
  const missing = capability ? error : data && data[kind] === false ? { status: 501, code: 'capability_missing', message: `${kindLabel} is not installed on this server, so there are no ${kindLabel} logs to show.` } : null;
  const lines = tail.data?.content ? tail.data.content.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1) : [];

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => { refetch(); if (file) tail.refetch(); }}>Refresh</Button>}>
      {data?.warnings?.length > 0 && (
        <div className="banner banner-warning"><AlertTriangle size={18} /><div><strong>Some log locations were skipped</strong><ul>{data.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div></div>
      )}
      <div className="grid-2">
        <Card title="Choose a log" subtitle="Raw web server logs for the domains on this account.">
          <PanelCapabilityState error={missing} onRetry={refetch} />
          <RequestError error={error} onRetry={refetch} />
          <div className="form-grid">
            <Field label="Web server" htmlFor="logs-kind"><Select id="logs-kind" value={kind} onChange={(v) => { setKind(v); setFile(''); }} options={kindOptions} /></Field>
            <Field label="Domain" htmlFor="logs-domain"><Select id="logs-domain" value={domain} onChange={(v) => { setDomain(v); setFile(''); }} placeholder="All domains" options={domains} /></Field>
          </div>
          <Field label="Log file" htmlFor="logs-file" help={selected ? `${LOCATION_LABELS[selected.location] || selected.location} · ${formatBytes(selected.size)} · updated ${formatDate(selected.mtime)}` : files.length ? undefined : 'No log files yet for this selection'}>
            <Select id="logs-file" value={file} onChange={setFile} placeholder={files.length ? 'Choose a file' : 'No files'} options={files.map((f) => ({ value: f.name, label: f.name }))} disabled={!files.length} />
          </Field>
          <div className="form-grid">
            <Field label="Show" htmlFor="logs-bytes"><Select id="logs-bytes" value={bytes} onChange={setBytes} options={TAIL_SIZES} /></Field>
            <Field label="Follow" htmlFor="logs-follow"><Toggle checked={live} onChange={setLive} label="Refresh every 5 seconds" description="Keeps the view current while you watch traffic" disabled={!file} /></Field>
          </div>
          <FormActions>
            <Button icon={Eye} disabled={!file} onClick={() => tail.refetch()}>Reload view</Button>
            {file && <a className="btn" href={downloadHref(kind, file)} download><Download size={16} /> Download {file}</a>}
          </FormActions>
        </Card>
        <RetentionCard disabled={Boolean(me?.actingAs)} />
      </div>

      <Card title={file ? `Tail of ${file}` : 'Log view'} subtitle={tail.data ? `${tail.data.truncated ? 'Last' : 'All'} ${formatBytes(tail.data.length)} of ${formatBytes(tail.data.size)}${tail.data.mtime ? ` · updated ${formatDate(tail.data.mtime)}` : ''}` : undefined}
        actions={tail.data && <span className="muted small">{lines.length} line{lines.length === 1 ? '' : 's'}{live ? ' · following' : ''}</span>}>
        <PanelCapabilityState error={missing || tail.error} onRetry={missing ? refetch : tail.refetch} />
        <RequestError error={tail.error} onRetry={tail.refetch} />
        {!file && !missing && (
          <EmptyState icon={ScrollText} title="Nothing selected"><p>Choose a domain and a log file above. The last part of the file shows here and can be followed live.</p>{data && !data.files?.length && <p className="muted">No log files exist yet. The web server writes the first lines when a visitor opens one of your domains.</p>}</EmptyState>
        )}
        {file && tail.data && tail.data.size === 0 && <EmptyState icon={ScrollText} title="This log is empty"><p>Requests appear here as soon as the web server records them.</p></EmptyState>}
        {file && tail.data && tail.data.size > 0 && <pre className="log">{tail.data.content}</pre>}
        {file && tail.loading && !tail.data && <p className="muted">Reading the log…</p>}
      </Card>

      <Card title="Log files" subtitle={data?.files?.length ? `${data.files.length} file${data.files.length === 1 ? '' : 's'} for ${domain || 'all domains'}` : undefined} padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: 'File', render: (f) => <code>{f.name}</code> },
            { key: 'domain', label: 'Domain', render: (f) => domainOfFile(f.name, domains) || <span className="muted">—</span> },
            { key: 'location', label: 'Location', render: (f) => LOCATION_LABELS[f.location] || f.location },
            { key: 'size', label: 'Size', align: 'right', render: (f) => formatBytes(f.size) },
            { key: 'mtime', label: 'Updated', render: (f) => formatDate(f.mtime) },
          ]}
          rows={files} loading={loading} error={capability || isFeatureDisabled(error) ? null : error} rowKey={(f) => f.name} dense
          rowActions={(f) => [
            { label: 'View', primary: true, onClick: () => { setFile(f.name); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
            { label: 'Download', onClick: () => { window.location.href = downloadHref(kind, f.name); } },
          ]}
          emptyText={missing ? `Log files appear here once ${kindLabel} is available on this server.` : 'No log files yet. The web server creates one per domain once it has served a request; archived months land in your logs folder.'}
        />
      </Card>
    </PanelPage>
  );
}
