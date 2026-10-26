import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, KeyValue, StatusPill, CapabilityNotice, formatBytes } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { ProgressLog } from '../../../components/ProgressLog.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { AccountPicker, useSelectedAccount } from '../../accounts/AccountPicker.jsx';

export default function RearrangeAnAccount({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const { data: parts, loading, error: partsError, refetch: refetchParts } = useApi('/account-functions/rearrange/partitions');
  const [target, setTarget] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const currentRoot = account ? (parts?.roots || []).map((r) => r.root).sort((a, b) => b.length - a.length).find((r) => account.home_dir?.startsWith(`${r}/`)) : null;
  const options = (parts?.roots || []).filter((r) => r.exists && r.root !== currentRoot).map((r) => ({ value: r.root, label: `${r.root} — ${r.mountpoint ? `${r.filesystem} on ${r.mountpoint}, ${formatBytes(r.availableBytes)} free` : 'mountpoint unknown'}` }));

  const submit = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Move ${username} to ${target}?`, message: `The home directory is copied with rsync to ${target}/${username}, the Linux user and web server are pointed at it, and the old directory is deleted. Sites keep serving from the old copy until the switch.`, confirmLabel: 'Move account', danger: true, typeToConfirm: username }))) return;
    setBusy(true); setError(null);
    try {
      const { data } = await api.post(`/account-functions/rearrange/${username}`, { target });
      setJob(data.job.id);
      toast.success(`Moving ${username} (${data.bytes != null ? formatBytes(data.bytes) : 'size unknown'}) to ${data.to}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Moves an account's home directory to another partition (for example /home2) when a disk fills up. Runs as a job: rsync copy, a second sync for files changed meanwhile, usermod -d, vhost rewrite, then removal of the old tree." />
      <Card title="Home partitions" padded={false} actions={<Button size="sm" onClick={() => refetchParts()}>Refresh</Button>}>
        <ErrorBanner error={partsError} onRetry={refetchParts} />
        <DataTable
          columns={[
            { key: 'root', label: 'Directory', render: (r) => <code>{r.root}</code> },
            { key: 'exists', label: 'Present', render: (r) => <StatusPill status={r.exists ? 'ok' : 'not-installed'}>{r.exists ? 'yes' : 'missing'}</StatusPill> },
            { key: 'mountpoint', label: 'Filesystem', render: (r) => (r.mountpoint ? <><code>{r.filesystem}</code> on <code>{r.mountpoint}</code></> : <span className="muted">—</span>) },
            { key: 'availableBytes', label: 'Free', align: 'right', render: (r) => formatBytes(r.availableBytes) },
            { key: 'usedPercent', label: 'Used', align: 'right', render: (r) => (r.usedPercent == null ? '—' : `${r.usedPercent}%`) },
            { key: 'accounts', label: 'Accounts', align: 'right' },
          ]}
          rows={parts?.roots || []} loading={loading} rowKey={(r) => r.root} dense
        />
      </Card>
      <Card title="Select an account"><AccountPicker value={username} onChange={(u) => { setUsername(u); setJob(null); }} /></Card>
      {account && (
        <form onSubmit={submit}>
          <Card title={`${account.domain} (${account.username})`}>
            <KeyValue items={[['Current home', <code key="h">{account.home_dir}</code>], ['Partition', <code key="p">{currentRoot || 'unknown'}</code>], ['Linux user', <StatusPill key="u" status={account.systemUser ? 'ok' : 'warning'}>{account.systemUser ? `uid ${account.uid}` : 'not provisioned'}</StatusPill>]]} />
            <CapabilityNotice error={error} />
            {error && error.status !== 501 && <ErrorBanner error={error} />}
            <div className="form-grid" style={{ marginTop: 14 }}>
              <Field label="Move to" required error={error?.fields?.target} help={options.length ? 'Only partitions that exist on this server are offered' : 'No other home partition exists; create /home2 (or mount one) first'}>
                <Select value={target} onChange={setTarget} options={options} placeholder="Select a partition" />
              </Field>
            </div>
            <FormActions><Button type="submit" variant="danger" loading={busy} disabled={!target}>Move account</Button></FormActions>
          </Card>
        </form>
      )}
      {job && <Card title="Move progress"><ProgressLog jobId={job} onFinished={() => { refetch(); refetchParts(); }} /></Card>}
    </>
  );
}
