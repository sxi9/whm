import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, CapabilityNotice } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { RadioGroup, Button, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';

const SHELLS = [
  { value: '/usr/sbin/nologin', label: 'Disabled', description: 'No SSH login (/usr/sbin/nologin). FTP and the panel still work.' },
  { value: '/usr/local/bin/jailshell', label: 'Jailed shell', description: 'SSH confined to the account\'s own files (/usr/local/bin/jailshell; must be installed).' },
  { value: '/bin/bash', label: 'Normal shell', description: 'Full /bin/bash login.' },
  { value: '/bin/sh', label: 'POSIX shell', description: '/bin/sh login.' },
];
const label = (shell) => SHELLS.find((s) => s.value === shell)?.label || shell;

export default function ManageShellAccess({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/account-functions/summary');
  const [selected, setSelected] = useState([]);
  const [shell, setShell] = useState('/usr/sbin/nologin');
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState(null);

  const apply = async (usernames) => {
    if (shell !== '/usr/sbin/nologin' && !(await confirm({ title: `Give ${usernames.length} account(s) a ${label(shell).toLowerCase()}?`, message: 'The Linux login shell is changed with usermod -s. The owner can log in over SSH with the account password or keys.', confirmLabel: 'Apply' }))) return;
    setBusy(true); setLastError(null);
    let ok = 0;
    for (const u of usernames) {
      try { await api.put(`/account-functions/shell/${u}`, { shell }); ok++; } catch (err) { setLastError(err); toast.error(`${u}: ${err.message}`); if (err.status === 501) break; }
    }
    setBusy(false);
    if (ok) toast.success(`Shell set to ${label(shell)} for ${ok} account(s)`);
    setSelected([]);
    refetch();
  };

  return (
    <>
      <PageHeader fn={fn} description="Controls SSH access per account: no shell, a jailed shell limited to the account's files, or a normal shell. Applied to the Linux user immediately." />
      <Card title="Shell to apply">
        <CapabilityNotice error={lastError} />
        {lastError && lastError.status !== 501 && <ErrorBanner error={lastError} />}
        <RadioGroup name="shell" value={shell} onChange={setShell} options={SHELLS} />
      </Card>
      <Card padded={false}>
        <ErrorBanner error={error} onRetry={refetch} />
        <DataTable
          columns={[
            { key: 'username', label: 'User', render: (r) => <code>{r.username}</code> },
            { key: 'domain', label: 'Domain' },
            { key: 'owner', label: 'Owner' },
            { key: 'shell', label: 'Current shell', render: (r) => <><StatusPill status={r.shell === '/usr/sbin/nologin' ? 'disabled' : 'enabled'}>{label(r.shell)}</StatusPill> <code className="muted">{r.shell}</code></> },
            { key: 'systemUser', label: 'Linux user', render: (r) => <StatusPill status={r.systemUser ? 'ok' : 'warning'}>{r.systemUser ? `uid ${r.uid}` : 'not provisioned'}</StatusPill> },
          ]}
          rows={data || []} loading={loading} rowKey={(r) => r.username} selectable selected={selected} onSelectedChange={setSelected}
          rowActions={(r) => [{ label: `Set ${label(shell)}`, primary: true, disabled: r.shell === shell, onClick: () => apply([r.username]) }]}
          toolbar={<Button variant="primary" disabled={!selected.length} loading={busy} onClick={() => apply(selected)}>Apply to selected ({selected.length})</Button>}
        />
      </Card>
    </>
  );
}
