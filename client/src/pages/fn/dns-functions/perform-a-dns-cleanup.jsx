import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

export default function PerformADnsCleanup({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/dns/cleanup');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);

  const run = async ({ domains, all, republish }) => {
    const n = all ? data.orphans.length : domains?.length || 0;
    const what = [n && `delete ${n} orphaned zone(s) from BIND`, republish && `rewrite ${data.missingOnDisk.length} zone file(s) missing on disk`].filter(Boolean).join(' and ');
    if (!(await confirm({ title: 'Run DNS cleanup?', message: `This will ${what}. Deleting a zone cannot be undone.`, confirmLabel: 'Run cleanup', danger: Boolean(n), typeToConfirm: n > 1 ? 'CLEANUP' : undefined }))) return;
    setBusy(true);
    try {
      const { data: res } = await api.post('/dns/cleanup', { ...(all ? { all: true } : domains?.length ? { domains } : {}), republish: Boolean(republish) });
      setLast(res);
      toast.success(`Removed ${res.removed.filter((r) => r.removed).length} zone(s)${res.republished.length ? `, republished ${res.republished.filter((r) => r.ok).length}` : ''}`);
      setSelected([]);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Finds zones that no account owns any more (left behind by terminated accounts or manual edits), zone files on disk the panel does not know about, and zones missing from disk." actions={<Button onClick={() => refetch()}>Re-scan</Button>} />
      <ErrorBanner error={error} onRetry={refetch} />
      {data && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <div className="stat"><div className="label">Zones</div><div className="value">{data.total}</div></div>
          <div className="stat"><div className="label">Orphaned</div><div className="value">{data.orphans.length}</div></div>
          <div className="stat"><div className="label">Unmanaged on disk</div><div className="value">{data.bindInstalled ? data.unmanaged.length : '—'}</div></div>
          <div className="stat"><div className="label">Missing on disk</div><div className="value">{data.bindInstalled ? data.missingOnDisk.length : '—'}</div></div>
        </div>
      )}
      <Card title="Orphaned zones" subtitle="Zones with no account and no hosted domain behind them" padded={false}
        actions={data?.orphans.length > 0 && <><Button size="sm" variant="danger" loading={busy} disabled={!selected.length} onClick={() => run({ domains: selected })}>Delete selected ({selected.length})</Button><Button size="sm" variant="danger" loading={busy} onClick={() => run({ all: true })}>Delete all orphans</Button></>}>
        <DataTable
          columns={[
            { key: 'domain', label: 'Zone', render: (z) => <code>{z.domain}</code> },
            { key: 'reason', label: 'Why' },
            { key: 'serial', label: 'Serial', render: (z) => <code>{z.serial}</code> },
            { key: 'updated_at', label: 'Last change', render: (z) => formatDate(z.updated_at) },
          ]}
          rows={data?.orphans || []} loading={loading} rowKey={(z) => z.domain} selectable selected={selected} onSelectedChange={setSelected} dense emptyText="No orphaned zones. Nothing to clean up."
          rowActions={(z) => [{ label: 'Delete', primary: true, danger: true, onClick: () => run({ domains: [z.domain] }) }]}
        />
      </Card>
      {data && !data.bindInstalled && <Card><EmptyState title="BIND is not installed">Disk checks (unmanaged and missing zone files) run only on a host with BIND.</EmptyState></Card>}
      {data?.bindInstalled && (
        <>
          <Card title="Zone files not known to the panel" subtitle="Imported automatically when valid; these could not be parsed or are not domains" padded={false}>
            <DataTable columns={[{ key: 'domain', label: 'File / zone', render: (z) => <code>{z.domain}</code> }, { key: 'path', label: 'Path', render: (z) => <code>{z.path}</code> }]} rows={data.unmanaged} rowKey={(z) => z.domain} dense emptyText="Every zone file on disk is managed by the panel." />
          </Card>
          <Card title="Zones missing on disk" subtitle="Known to the panel but not present in the zone directory" padded={false}
            actions={data.missingOnDisk.length > 0 && <Button size="sm" variant="primary" loading={busy} onClick={() => run({ republish: true })}>Rewrite missing files</Button>}>
            <DataTable columns={[{ key: 'domain', label: 'Zone', render: (z) => <code>{z.domain}</code> }, { key: 'account', label: 'Account', render: (z) => z.account || <span className="muted">—</span> }]} rows={data.missingOnDisk} rowKey={(z) => z.domain} dense emptyText="All zones are present on disk." />
          </Card>
        </>
      )}
      {last && (
        <Card title="Last cleanup">
          <ul>
            {last.removed.map((r) => <li key={r.domain}><code>{r.domain}</code> <StatusPill status={r.removed ? 'ok' : 'failed'}>{r.removed ? 'removed' : r.error}</StatusPill></li>)}
            {last.republished.map((r) => <li key={r.domain}><code>{r.domain}</code> <StatusPill status={r.ok ? 'ok' : 'failed'}>{r.ok ? 'rewritten' : r.error}</StatusPill></li>)}
            {last.skipped.map((d) => <li key={d}><code>{d}</code> <StatusPill status="info">skipped (not an orphan)</StatusPill></li>)}
          </ul>
        </Card>
      )}
    </>
  );
}
