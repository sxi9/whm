import { useState } from 'react';
import { RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button, FormActions } from '../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../components/Modal.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from '../databases/parts/shared.jsx';

// The account follows its own scan jobs here (/api/system/jobs is reseller-only).
export const jobStreamPath = (id) => `/panel/virus-scanner/scans/${id}/stream`;

export const SCOPES = ['home', 'mail', 'public_html'];

export function scopeLabel(key, t = untranslated) {
  return { home: t('panel.virus.scope_home', 'Entire home directory'), mail: t('panel.virus.scope_mail', 'Mail (mail/)'), public_html: t('panel.virus.scope_public_html', 'Websites (public_html/)') }[key] || key;
}

export function databaseAgeText(sec, t = untranslated) {
  if (sec == null) return t('panel.virus.db_unknown', 'signature database age unknown');
  const h = Math.floor(sec / 3600);
  if (h < 1) return t('panel.virus.db_fresh', 'signatures updated within the hour');
  if (h < 48) return fill(t('panel.virus.db_hours', 'signatures updated {hours} h ago'), { hours: h });
  return fill(t('panel.virus.db_days', 'signatures updated {days} days ago'), { days: Math.floor(h / 24) });
}

export function scanOutcome(job, t = untranslated) {
  if (!job) return { tone: 'unknown', text: t('panel.virus.never', 'never scanned') };
  if (job.status === 'failed') return { tone: 'error', text: t('panel.virus.failed', 'failed') };
  if (job.status === 'cancelled') return { tone: 'unknown', text: t('panel.virus.cancelled', 'cancelled') };
  const n = job.result?.infected?.length || 0;
  if (n) return { tone: 'error', text: fill(t('panel.virus.infected_count', '{count} infected'), { count: n }) };
  return { tone: 'ok', text: t('panel.virus.clean', 'clean') };
}

export default function VirusScanner({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { data, loading, error, refetch } = usePanelApi('/virus-scanner');
  const [scope, setScope] = useState('public_html');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [startError, setStartError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const capability = isCapabilityError(error);
  const scanner = data?.scanner;
  const installed = Boolean(scanner?.installed);
  const active = data?.active || null;

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const start = async (e) => {
    e.preventDefault();
    setBusy(true); setStartError(null);
    try {
      const { data: res } = await panelApi.post('/virus-scanner/scans', { scope });
      setJob({ id: res.job.id, scope: res.scope, path: res.path });
    } catch (err) {
      if (err?.code === 'scan_running' && err?.fields?.job?.id) setJob({ id: err.fields.job.id, scope, path: null });
      else setStartError(err);
    } finally { setBusy(false); }
  };

  const onJobFinished = (event) => {
    if (event.type === 'done') {
      const n = event.result?.infected?.length || 0;
      if (n) toast.error(fill(t('panel.virus.found_toast', '{count} infected file(s) found'), { count: n }));
      else toast.success(t('panel.virus.clean_toast', 'Nothing found'));
      setJob((j) => (j ? { ...j, result: event.result } : j));
    } else if (event.type === 'failed') toast.error(event.error || t('panel.virus.job_failed', 'The scan failed'));
    refetch();
  };

  const removeFiles = async (files) => {
    const ok = await confirm({ title: fill(t('panel.virus.delete_title', 'Delete {count} infected file(s)?'), { count: files.length }), message: t('panel.virus.delete_message', 'The files are removed from your account. If a website needs one of them, restore it from a backup instead. This cannot be undone.'), confirmLabel: t('panel.virus.delete', 'Delete'), danger: true });
    if (!ok) return;
    try {
      const { data: res } = await panelApi.post('/virus-scanner/infected/remove', { paths: files });
      toast.success(fill(t('panel.virus.deleted', '{count} file(s) deleted'), { count: res.removed?.length ?? files.length }));
      const drop = new Set(res.removed || files);
      const prune = (j) => (j?.result ? { ...j, result: { ...j.result, infected: (j.result.infected || []).filter((f) => !drop.has(f.file)) } } : j);
      setJob(prune); setViewing(prune);
      refetch();
    } catch (err) { toast.error(err); }
  };

  const infectedTable = (result) => (
    <DataTable
      columns={[
        { key: 'file', label: t('panel.virus.col_file', 'File'), render: (r) => <code>{r.file}</code> },
        { key: 'signature', label: t('panel.virus.col_signature', 'Signature'), render: (r) => <StatusPill status="error">{r.signature}</StatusPill> },
      ]}
      rows={result?.infected || []} rowKey={(r) => r.file}
      rowActions={(r) => [{ label: t('panel.virus.delete', 'Delete'), danger: true, onClick: () => removeFiles([r.file]) }]}
      emptyText={t('panel.virus.none_infected', 'No infected files.')}
    />
  );

  const history = data?.history || [];

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      {capability && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}

      <form onSubmit={start}>
        <Card title={t('panel.virus.start_title', 'Start a scan')} subtitle={t('panel.virus.start_subtitle', 'ClamAV reads your files as your own account and reports anything that matches a known signature. Nothing is changed by the scan itself.')}>
          <RequestError error={startError} />
          {!capability && data && !installed && <InfoNote>{t('panel.virus.not_installed', 'The virus scanner is not installed on this server.')} {t('panel.virus.ask_provider', 'Ask your hosting provider.')}</InfoNote>}
          {installed && <p className="muted small">{fill(t('panel.virus.engine', 'ClamAV {version}'), { version: scanner.version || '' })}, {databaseAgeText(scanner.databaseAgeSec, t)}.</p>}
          {active && !job && <InfoNote>{t('panel.virus.already_running', 'A scan is already running.')} <button type="button" className="btn btn-sm" onClick={() => setJob({ id: active.id, scope: active.params?.scope, path: active.params?.rel })}>{t('panel.virus.follow', 'Follow it')}</button></InfoNote>}
          <div className="form-grid">
            <Field label={t('panel.virus.scope', 'What to scan')} htmlFor="virus-scope" help={t('panel.virus.scope_help', 'A full home scan can take a while; it stops after 15 minutes')}>
              <Select id="virus-scope" value={scope} onChange={setScope} options={SCOPES.map((k) => ({ value: k, label: scopeLabel(k, t) }))} disabled={!installed} />
            </Field>
          </div>
          <FormActions>
            <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy} disabled={busy || !installed || Boolean(active)}>{t('panel.virus.scan_now', 'Scan now')}</Button>
          </FormActions>
        </Card>
      </form>

      <Card title={t('panel.virus.history_title', 'Recent scans')} padded={false}>
        <DataTable
          columns={[
            { key: 'when', label: t('panel.virus.col_when', 'When'), render: (r) => (r.finishedAt || r.createdAt || '').replace('T', ' ').slice(0, 19) },
            { key: 'scope', label: t('panel.virus.col_scope', 'Scope'), render: (r) => scopeLabel(r.params?.scope, t) },
            { key: 'outcome', label: t('panel.virus.col_outcome', 'Result'), render: (r) => { const o = scanOutcome(r, t); return <StatusPill status={o.tone}>{o.text}</StatusPill>; } },
            { key: 'duration', label: t('panel.virus.col_duration', 'Duration'), render: (r) => (r.result?.durationMs != null ? `${Math.max(1, Math.round(r.result.durationMs / 1000))} s` : '—') },
          ]}
          rows={history} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [{ label: t('panel.virus.view', 'View'), primary: true, onClick: () => setViewing(r) }]}
          emptyText={t('panel.virus.history_empty', 'No scan has run yet.')}
        />
      </Card>

      <Modal open={Boolean(job)} title={job ? fill(t('panel.virus.scanning', 'Scanning {scope}'), { scope: scopeLabel(job.scope, t) }) : ''} onClose={() => setJob(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setJob(null)}>{t('common.close', 'Close')}</button>}>
        {job && <ProgressLog jobId={job.id} onFinished={onJobFinished} streamPath={jobStreamPath} />}
        {job?.result && (
          <>
            <InfoNote>{job.result.infected?.length ? fill(t('panel.virus.found_note', '{count} infected file(s). Delete what you do not recognise; a plugin or theme that is flagged should be reinstalled from its source.'), { count: job.result.infected.length }) : t('panel.virus.clean_note', 'Nothing matched a known signature.')}</InfoNote>
            {Boolean(job.result.infected?.length) && <div className="table-wrap">{infectedTable(job.result)}</div>}
            {Boolean(job.result.infected?.length) && <p><Button variant="danger" icon={Trash2} onClick={() => removeFiles(job.result.infected.map((f) => f.file))}>{t('panel.virus.delete_all', 'Delete all infected files')}</Button></p>}
            {Boolean(job.result.errors?.length) && <p className="muted small">{fill(t('panel.virus.errors_note', '{count} file(s) could not be read and were skipped.'), { count: job.result.errors.length })}</p>}
          </>
        )}
      </Modal>

      <Modal open={Boolean(viewing)} title={viewing ? fill(t('panel.virus.result_title', 'Scan of {scope}'), { scope: scopeLabel(viewing.params?.scope, t) }) : ''} onClose={() => setViewing(null)} size="lg" footer={<button className="btn btn-primary" onClick={() => setViewing(null)}>{t('common.close', 'Close')}</button>}>
        {viewing && (
          <>
            <KeyValue items={[
              { label: t('panel.virus.col_outcome', 'Result'), value: scanOutcome(viewing, t).text },
              { label: t('panel.virus.col_when', 'When'), value: (viewing.finishedAt || viewing.createdAt || '').replace('T', ' ').slice(0, 19) },
              ...(viewing.error ? [{ label: t('panel.virus.error', 'Error'), value: viewing.error }] : []),
            ]} />
            {Boolean(viewing.result?.infected?.length) && <div className="table-wrap">{infectedTable(viewing.result)}</div>}
            {Boolean(viewing.result?.errors?.length) && <p className="muted small">{fill(t('panel.virus.errors_note', '{count} file(s) could not be read and were skipped.'), { count: viewing.result.errors.length })}</p>}
          </>
        )}
      </Modal>
    </PanelPage>
  );
}
