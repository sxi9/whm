import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw, Archive, Download, Info } from 'lucide-react';
import { Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions, RadioGroup } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { isCapabilityError, isFeatureDisabled, kindLabel, statusTone, sizeText, filterBackups, RequestError, ImpersonationNotice } from './parts/shared.jsx';

const KIND_OPTIONS = [
  { value: 'home', label: 'Home directory and mail', description: 'Your files and mailboxes. The quickest way to keep a copy of your site.' },
  { value: 'full', label: 'Full account', description: 'Files, mailboxes, databases and DNS zones; large, but everything is in one archive.' },
];

export default function Backups({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const { data, meta, loading, error, refetch } = usePanelApi(`/backups?page=${page}&pageSize=25`);
  const [kind, setKind] = useState('home');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [job, setJob] = useState(null);
  const [q, setQ] = useState('');
  const capability = isCapabilityError(error);
  const actingAs = me?.actingAs;
  const running = meta?.running || null;
  const rows = useMemo(() => filterBackups(data || [], q), [data, q]);
  const activeJob = job || (running ? running.id : null);

  useEffect(() => { if (running && !job) setJob(running.id); }, [running, job]);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const generate = async () => {
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/backups', { kind });
      setJob(res.job.id);
      toast.info(`Generating a ${kindLabel(kind).toLowerCase()} backup`);
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const finished = (event) => {
    if (event.type === 'done') toast.success('Backup ready to download');
    else if (event.type === 'failed') toast.error(event.error || 'The backup failed');
    refetch();
  };

  const remove = async (row) => {
    const ok = await confirm({ title: `Delete ${row.name}?`, message: 'The archive is removed from the server. Download it first if you want to keep a copy.', confirmLabel: 'Delete backup', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/backups/${row.id}`); toast.success(`${row.name} deleted`); refetch(); } catch (err) { toast.error(err); }
  };

  const columns = [
    { key: 'name', label: 'Archive', render: (r) => <code>{r.name || `#${r.id}`}</code> },
    { key: 'kind', label: 'Contents', render: (r) => kindLabel(r.kind) },
    { key: 'size', label: 'Size', align: 'right', render: (r) => sizeText(r.size) },
    { key: 'status', label: 'Status', render: (r) => <StatusPill status={statusTone(r.status)}>{r.status === 'done' ? 'ready' : r.status}</StatusPill> },
    { key: 'created_at', label: 'Created', render: (r) => formatDate(r.created_at) },
  ];

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <ImpersonationNotice actingAs={actingAs}>Backups can be generated and restored by the account user only; the list and downloads are available.</ImpersonationNotice>
      <div className="grid-2">
        <Card title="Generate a backup" subtitle="A compressed archive of the account, kept on the server until you delete it.">
          <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
          <RequestError error={formError} />
          <RadioGroup name="backup-kind" value={kind} onChange={setKind} options={KIND_OPTIONS.filter((o) => !meta?.kinds || meta.kinds.includes(o.value))} />
          <FormActions>
            <Button variant="primary" icon={Archive} loading={busy} disabled={busy || Boolean(activeJob) || Boolean(actingAs)} onClick={generate}>Generate backup</Button>
            {running && <span className="muted small">A {kindLabel(running.kind).toLowerCase()} backup is {running.status}</span>}
          </FormActions>
          {activeJob && (
            <div style={{ marginTop: 14 }}>
              <ProgressLog jobId={activeJob} onFinished={finished} />
              <FormActions><Button size="sm" onClick={() => { setJob(null); refetch(); }}>Hide progress</Button></FormActions>
            </div>
          )}
        </Card>
        <Card title="What a backup contains">
          <KeyValue items={[
            ['Home directory and mail', 'Website files, configuration and mailboxes'],
            ['Full account', 'Everything above plus databases and DNS zones'],
            ['Kept where', `On ${me?.hostname || 'the server'} until you delete it`],
            ['Backups on this account', meta?.total ?? (data ? data.length : '—')],
          ]} />
          <div className="banner banner-info" style={{ marginTop: 14, marginBottom: 0 }}>
            <Info size={18} />
            <div>Download archives you want to keep: scheduled server backups are managed by your hosting provider and are not listed here. To put files back, open <Link to="/panel/backups/restore">Restore</Link>.</div>
          </div>
        </Card>
      </div>

      <Card title="Backups" subtitle={meta?.total ? `${meta.total} archive${meta.total === 1 ? '' : 's'}` : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={columns} rows={rows} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          total={meta?.total ?? null} page={page} pageSize={25} onPageChange={setPage}
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder="Search archives"
          rowActions={(r) => [
            r.downloadable ? { label: 'Download', primary: true, onClick: () => { window.location.href = `/api/panel/backups/${r.id}/download`; } } : null,
            r.status === 'done' && r.local_present ? { label: 'Restore files', onClick: () => navigate(`/panel/backups/restore?backup=${r.id}`) } : null,
            r.panelOwned ? { label: 'Delete', danger: true, disabled: Boolean(actingAs), onClick: () => remove(r) } : null,
          ]}
          emptyText={capability ? 'Backups appear here once the backup service is available on this server.' : q ? 'No archive matches the search.' : 'No backups yet. Generate one above; it appears here with its size and a download link when it is ready.'}
        />
      </Card>
      {data?.some((r) => r.downloadable) && (
        <p className="muted small"><Download size={12} /> Downloads are the archive as stored on the server (.tar.gz); keep them somewhere safe and upload them back under Restore if you ever need them.</p>
      )}
    </PanelPage>
  );
}
