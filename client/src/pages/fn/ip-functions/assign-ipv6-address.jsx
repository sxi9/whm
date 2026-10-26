import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Select, TextInput, Button, FormActions } from '../../../components/Form.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { AccountPicker } from '../../accounts/AccountPicker.jsx';
import { IpRequestError } from '../../ip/Shared.jsx';

export default function AssignIpv6Address({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isRoot = user?.role === 'root';
  const { data: assignments, loading, error, refetch } = useApi('/ip/ipv6/assignments');
  const { data: ranges } = useApi('/ip/ipv6/ranges', { enabled: isRoot });
  const [account, setAccount] = useState('');
  const [rangeId, setRangeId] = useState('');
  const [address, setAddress] = useState('');
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const existing = (assignments || []).find((a) => a.account === account);

  const assign = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null); setResult(null);
    try {
      const body = { account };
      if (rangeId) body.rangeId = Number(rangeId);
      if (address.trim()) body.address = address.trim();
      const { data } = await api.post('/ip/ipv6/assign', body);
      setResult(data);
      toast.success(`${data.address} assigned to ${data.account}`);
      setAddress('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };
  const remove = async (row) => {
    if (!(await confirm({ title: `Remove ${row.address} from ${row.account}?`, message: 'The address is unbound from the interface, its AAAA records are removed from the account\'s zones and the web server is told to stop listening on it.', confirmLabel: 'Remove', danger: true }))) return;
    try { const { data } = await api.delete(`/ip/ipv6/assignments/${row.account}`); toast.success(`${data.address} removed from ${data.account}`); refetch(); } catch (err) { toast.error(err); }
  };

  const enabledRanges = (ranges || []).filter((r) => r.enabled);
  return (
    <>
      <PageHeader fn={fn} description="Gives an account the next free address from an IPv6 range: the address is bound to the interface, recorded as dedicated to the account, published as AAAA records for the account's domains and passed to the web server when it is available." />
      <form onSubmit={assign}>
        <Card title="Assign an IPv6 address">
          <IpRequestError error={formError && !formError.fields ? formError : null} />
          <AccountPicker value={account} onChange={setAccount} label="Account" />
          {existing && <div className="banner banner-info"><div>{account} already has <code>{existing.address}</code>{existing.range ? ` from "${existing.range}"` : ''}. Remove it below before assigning another.</div></div>}
          <div className="form-grid">
            {isRoot ? (
              <Field label="Range" help={enabledRanges.length ? 'Blank uses the first enabled range mapped to the account, then any enabled range' : <>No enabled range yet — add one under <Link to="/ip-functions/ipv6-ranges">IPv6 Ranges</Link></>} error={formError?.fields?.rangeId}>
                <Select value={rangeId} onChange={setRangeId} options={enabledRanges.map((r) => ({ value: String(r.id), label: `${r.name} — ${r.range_cidr} (${r.assigned_count} assigned)` }))} placeholder="Automatic" />
              </Field>
            ) : <Field label="Range" help="Resellers draw from the ranges root mapped to the account"><TextInput value="Automatic" disabled onChange={() => {}} /></Field>}
            <Field label="Specific address" help="Blank picks the next free address in the range" error={formError?.fields?.address}><TextInput value={address} onChange={setAddress} placeholder="2001:db8:1::42" /></Field>
          </div>
          <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!account || Boolean(existing)}>Assign IPv6 address</Button></FormActions>
          {result && (
            <KeyValue items={[
              ['Account', result.account], ['Address', <code key="a">{result.address}/{result.prefix}</code>], ['Range', `${result.range} (${result.range_cidr})`], ['Interface', <code key="i">{result.interface}</code>],
              ['Bound on host', <StatusPill key="b" status={result.bound ? 'ok' : 'warning'}>{result.bound ? 'yes' : 'no'}</StatusPill>],
              ['DNS (AAAA)', result.dns?.skipped ? <StatusPill key="d" status="unknown">DNS service unavailable</StatusPill> : <span key="d">{(result.dns?.results || []).map((r) => <StatusPill key={r.domain} status={r.status === 'updated' ? 'ok' : r.status === 'no_zone' ? 'unknown' : 'failed'}>{r.domain}: {r.status === 'no_zone' ? 'no zone here' : r.status}</StatusPill>)}</span>],
              ['Web server', <StatusPill key="w" status={result.web === 'applied' ? 'ok' : result.web === 'failed' ? 'failed' : 'pending'}>{result.web === 'skipped' ? 'applied when the web service is installed' : result.web}</StatusPill>],
            ]} />
          )}
        </Card>
      </form>
      <IpRequestError error={error} onRetry={refetch} />
      <Card title="Current IPv6 assignments" padded={false}>
        <DataTable
          columns={[
            { key: 'account', label: 'Account', render: (r) => <Link to={`/account-functions/modify-an-account?username=${r.account}`}>{r.account}</Link> },
            { key: 'domain', label: 'Domain' },
            { key: 'address', label: 'IPv6 address', render: (r) => <code>{r.address}</code> },
            { key: 'range', label: 'Range', render: (r) => r.range ? `${r.range} (${r.range_cidr})` : <span className="muted">deleted range</span> },
            { key: 'created_at', label: 'Assigned', render: (r) => formatDate(r.created_at) },
          ]}
          rows={assignments || []} loading={loading} rowKey={(r) => r.account}
          rowActions={(r) => [{ label: 'Remove', primary: true, danger: true, onClick: () => remove(r) }]}
          emptyText="No account has an IPv6 address yet."
        />
      </Card>
    </>
  );
}
