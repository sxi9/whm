import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, CapabilityNotice, formatMb } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, NumberInput, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountPicker, useSelectedAccount } from '../../accounts/AccountPicker.jsx';

export default function QuotaModification({ fn }) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const { data: report, error: reportError, loading: reportLoading, refetch: refetchReport } = useApi('/account-functions/quota/report');
  const [quota, setQuota] = useState(null);
  const [unlimited, setUnlimited] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (account) { setQuota(account.disk_quota_mb); setUnlimited(account.disk_quota_mb == null); } }, [account]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { data } = await api.put(`/account-functions/quota/${username}`, { diskQuotaMb: unlimited ? null : quota ?? 0 });
      toast.success(`${username}: quota ${data.disk_quota_mb == null ? 'removed' : `set to ${formatMb(data.disk_quota_mb)}`}${data.applied ? ` on ${data.filesystem}` : ' (recorded)'}`);
      refetch(); refetchReport();
    } catch (err) {
      setError(err);
      if (err.status === 501) { toast.warning(err.message); refetch(); }
    } finally { setBusy(false); }
  };

  const live = report?.find((r) => r.username === username)?.live;

  return (
    <>
      <PageHeader fn={fn} description="Changes an account's disk quota. The soft limit is the quota; the hard limit is 5% above it. Applied with setquota on the filesystem that holds the home directory." />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {account && (
        <form onSubmit={save}>
          <Card title={`${account.domain} (${account.username})`}>
            <KeyValue items={[['Used', live ? formatMb(live.usedMb) : formatMb(account.disk_used_mb)], ['Current quota', formatMb(account.disk_quota_mb)], live && ['Live limits (repquota)', `${formatMb(live.softMb)} soft / ${formatMb(live.hardMb)} hard`], ['Package default', formatMb(account.plan?.disk_mb)], ['Home', <code key="h">{account.home_dir}</code>]]} />
            <CapabilityNotice error={error} />
            {error && error.status !== 501 && <ErrorBanner error={error} />}
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field inline><Toggle checked={unlimited} onChange={setUnlimited} label="Unlimited disk space" /></Field>
              {!unlimited && <Field label="Disk quota (MB)" error={error?.fields?.diskQuotaMb} help="1024 MB = 1 GB"><NumberInput value={quota} onChange={setQuota} min={0} nullable={false} /></Field>}
            </div>
            <FormActions><Button type="submit" variant="primary" loading={busy}>Save quota</Button></FormActions>
          </Card>
        </form>
      )}
      <Card title="Quota report" subtitle="Live usage from repquota next to the panel's record" padded={false} actions={<Button size="sm" onClick={() => refetchReport()}>Refresh</Button>}>
        <CapabilityNotice error={reportError} onRetry={refetchReport} />
        {reportError && reportError.status !== 501 && <ErrorBanner error={reportError} onRetry={refetchReport} />}
        {!reportError && (
          <DataTable
            columns={[
              { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
              { key: 'domain', label: 'Domain' },
              { key: 'filesystem', label: 'Filesystem', render: (r) => <code>{r.filesystem}</code> },
              { key: 'used', label: 'Used', align: 'right', render: (r) => formatMb(r.live ? r.live.usedMb : r.disk_used_mb) },
              { key: 'disk_quota_mb', label: 'Quota', align: 'right', render: (r) => formatMb(r.disk_quota_mb) },
              { key: 'live', label: 'Live', render: (r) => <StatusPill status={r.live ? 'ok' : r.reportAvailable ? 'warning' : 'unknown'}>{r.live ? `${formatMb(r.live.softMb)} soft` : r.reportAvailable ? 'no quota set on disk' : 'report unavailable'}</StatusPill> },
            ]}
            rows={report || []} loading={reportLoading} rowKey={(r) => r.username} dense
            rowActions={(r) => [{ label: 'Edit', primary: true, onClick: () => setUsername(r.username) }]}
          />
        )}
      </Card>
    </>
  );
}
