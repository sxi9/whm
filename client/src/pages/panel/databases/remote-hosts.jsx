import { useState } from 'react';
import { RefreshCw, Plus, Globe } from 'lucide-react';
import { Card, StatusPill, KeyValue, EmptyState, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { RequestError, InfoNote, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';

const HOST_RE = /^[A-Za-z0-9.%:_-]{1,255}$/;

export function describeHost(host) {
  if (host === '%') return 'any host';
  if (host.includes('%') || host.includes('_')) return 'pattern';
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return 'IP address';
  return 'host name';
}

export default function RemoteHosts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/databases/access-hosts');
  const [host, setHost] = useState('');
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const capability = isCapabilityError(error);
  const unsupported = meta && meta.supported === false;

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const add = async (e) => {
    e.preventDefault();
    const value = host.trim();
    if (!HOST_RE.test(value)) { setFormError({ message: 'Enter a host name, an IP address or a pattern with %', fields: { host: ['Letters, digits, dots, colons, "_", "-" and "%" only'] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/databases/access-hosts', { host: value });
      setLastResult(res);
      if (res.applied === false) toast.warning(`${res.host} saved; it takes effect once the database server is available`);
      else if (res.failed?.length) toast.warning(`${res.host} added; ${res.failed.length} user${res.failed.length === 1 ? '' : 's'} could not be updated`);
      else toast.success(`${res.host} can now connect`);
      setHost('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: `Remove ${row.host}?`, message: 'Connections from this address are refused as soon as the change is applied. Connections from this server (localhost) keep working.', confirmLabel: 'Remove host', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/databases/access-hosts/${row.id}`); toast.success(`${row.host} removed`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <div className="grid-2">
        <form onSubmit={add}>
          <Card title="Allow a remote host" subtitle="Lets a computer outside this server open your databases with your database users.">
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            {unsupported ? (
              <EmptyState icon={Globe} title="Not available for PostgreSQL"><p>Remote access rules apply to MySQL and MariaDB. Ask your hosting provider if you need external access to a PostgreSQL database.</p></EmptyState>
            ) : (
              <>
                <Field label="Host name or IP address" required error={formError?.fields?.host} help={<>Use <code>%</code> as a wildcard, for example <code>203.0.113.%</code> for a whole network. <code>%</code> alone allows every host and is not recommended.</>} htmlFor="rh-host">
                  <TextInput id="rh-host" value={host} onChange={setHost} placeholder="203.0.113.5 or office.example.com" autoCapitalize="none" spellCheck={false} />
                </Field>
                <FormActions>
                  <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={!host.trim()}>Allow host</Button>
                  {lastResult && <span className="muted small">{lastResult.host} <PendingPill result={lastResult} /></span>}
                </FormActions>
              </>
            )}
          </Card>
        </form>
        <Card title="Connecting from outside" subtitle="What to enter in a database client or an application running elsewhere.">
          <KeyValue items={[
            ['Server', <code key="h">{me?.hostname || me?.account?.domain || '—'}</code>],
            ['Port', <code key="p">3306</code>],
            ['User', 'A database user of this account'],
            ['Password', 'That user\'s password'],
            ['Database', <code key="d">{`${me?.account?.username || 'account'}_…`}</code>],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>The client's public address must be listed here, and the server firewall must accept the database port. Your sites on this server connect through <code>localhost</code> without any rule.</p>
        </Card>
      </div>

      <Card title="Allowed hosts" subtitle={data?.length ? `${data.length} allowed` : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'host', label: 'Host', render: (r) => <code>{r.host}</code> },
            { key: 'kind', label: 'Matches', render: (r) => describeHost(r.host) },
            { key: 'scope', label: 'Set by', render: (r) => (r.scope === 'global' ? <StatusPill status="info">server-wide</StatusPill> : <StatusPill status="ok">you</StatusPill>) },
            { key: 'created_at', label: 'Added', render: (r) => (r.created_at ? formatDate(r.created_at) : <span className="muted">—</span>) },
          ]}
          rows={data || []} loading={loading} error={capability ? null : error} rowKey={(r) => r.id}
          rowActions={(r) => [r.editable ? { label: 'Remove', primary: true, danger: true, onClick: () => remove(r) } : null]}
          emptyText={capability ? 'Allowed hosts appear here once the database server is available.' : unsupported ? 'Remote hosts do not apply to PostgreSQL.' : 'No remote host is allowed yet. Only this server can reach your databases; add an address above to connect from elsewhere.'}
        />
        {data?.some((r) => r.scope === 'global') && <div className="card-body"><InfoNote>Server-wide hosts were allowed by your hosting provider for every account and cannot be removed here.</InfoNote></div>}
      </Card>
    </PanelPage>
  );
}
