import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, queryString } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { EngineBanner, RequestError, AccountSelect, HostInput, useDbStatus, useIsRoot } from '../../databases/Shared.jsx';

export default function ManageDatabaseAccessHosts({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const isRoot = useIsRoot();
  const status = useDbStatus();
  const [account, setAccount] = useState('');
  const { data, meta, loading, error, refetch } = useApi(`/databases/access-hosts${queryString({ account })}`);
  const [host, setHost] = useState('');
  const [formError, setFormError] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null); setResult(null);
    try {
      const body = { host: host.trim() };
      if (account) body.account = account;
      const { data: res } = await api.post('/databases/access-hosts', body);
      setResult(res);
      toast.success(`${res.host} allowed${res.account ? ` for ${res.account}` : ' globally'}`);
      setHost('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: `Remove ${row.host}?`, message: `Database users ${row.account ? `of ${row.account}` : 'of every account'} lose access from this host; their user@host entries are dropped.`, confirmLabel: 'Remove host', danger: true });
    if (!ok) return;
    try { const { data: res } = await api.delete(`/databases/access-hosts/${row.id}`); toast.success(`${row.host} removed (${res.removedFrom.length} user(s) updated)`); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Remote hosts that may connect to an account's databases. Each host becomes a user@host entry with the same password and privileges as the localhost user, so applications on other servers can connect. Make sure the server listens on a reachable address (bind_address) and the firewall allows port 3306." actions={<Button onClick={() => refetch()}>Refresh</Button>} />
      <EngineBanner status={status.data} loading={status.loading} error={status.error} onRetry={status.refetch} />
      {meta && meta.supported === false && <div className="banner banner-info"><div>The active profile is PostgreSQL: hosts are recorded here but client access is controlled by <code>pg_hba.conf</code>, which the panel does not manage.</div></div>}
      <form onSubmit={add}>
        <Card title="Allow a remote host">
          <RequestError error={formError && !formError.fields ? formError : null} />
          {formError?.fields && <ErrorBanner error={formError} />}
          <div className="form-grid">
            <AccountSelect value={account} onChange={setAccount} label="Scope" allowNone={isRoot} noneLabel="All accounts (global, root only)" help={isRoot ? 'A global host applies to every account user; pick an account to limit it' : undefined} />
            <HostInput value={host} onChange={setHost} error={formError?.fields?.host} />
          </div>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!host || (!isRoot && !account)}>Allow host</Button></FormActions>
          {result && (
            <div className="banner banner-info"><div>
              <strong>{result.host} added ({result.scope})</strong>
              <p>{result.supported ? `${result.applied.length} user(s) cloned to the new host${result.failed.length ? `; ${result.failed.length} failed: ${result.failed.map((f) => `${f.user} (${f.error})`).join(', ')}` : ''}.` : 'Recorded only (PostgreSQL profile).'} Need the server to accept remote connections? Set <code>bind_address</code> under <Link to="/database-services/edit-database-configuration">Edit Database Configuration</Link>.</p>
            </div></div>
          )}
        </Card>
      </form>
      <Card title={account ? `Access hosts for ${account}` : 'Access hosts'} padded={false}>
        <DataTable
          columns={[
            { key: 'host', label: 'Host', render: (r) => <code>{r.host}</code> },
            { key: 'scope', label: 'Scope', render: (r) => <StatusPill status={r.scope === 'global' ? 'info' : 'ok'}>{r.scope === 'global' ? 'all accounts' : r.account}</StatusPill> },
            { key: 'created_at', label: 'Added', render: (r) => formatDate(r.created_at) },
          ]}
          rows={data || []} loading={loading} error={error} rowKey={(r) => r.id}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => remove(r), disabled: r.scope === 'global' && !isRoot }]}
          emptyText="No remote hosts allowed; only localhost can connect."
        />
      </Card>
    </>
  );
}
