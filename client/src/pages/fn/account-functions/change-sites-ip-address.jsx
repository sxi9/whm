import { useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { AccountPicker, useSelectedAccount } from '../../accounts/AccountPicker.jsx';

const WEB_REASONS = {
  capability_missing: 'Apache not installed; applied on the next sync',
  web_category_missing: 'Service Configuration is not loaded; recorded only',
  no_vhost_on_previous_ip: 'no virtual host used the old address; nothing to rewrite',
  php_missing: 'vhosts rewritten; PHP-FPM is not installed, so .php files are static until it is',
  php_pool_failed: 'vhosts rewritten; the PHP-FPM pool could not be written (see Service Configuration)',
};
const webStatus = (web) => (web?.applied ? `vhosts rewritten${web.updated != null ? ` (${web.updated} address${web.updated === 1 ? '' : 'es'} replaced)` : ''}${web.domains?.length ? `: ${web.domains.join(', ')}` : ''}` : WEB_REASONS[web?.reason] || web?.reason || 'not applied');

export default function ChangeSitesIpAddress({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const { account, refetch } = useSelectedAccount(username);
  const { data: addresses } = useApi(user.role === 'root' ? '/ip/addresses' : null, { enabled: user.role === 'root' });
  const [ip, setIp] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const options = (addresses || []).map((a) => ({ value: a.address, label: `${a.address}${a.is_main ? ' (main)' : ''}${a.dedicated_to ? ' (dedicated)' : ''}${a.reserved ? ' (reserved)' : ''}`, disabled: Boolean(a.reserved) }));

  const submit = async (e) => {
    e.preventDefault();
    if (!(await confirm({ title: `Move ${account.domain} to ${ip}?`, message: 'The virtual hosts are rewritten and every A record that pointed at the old address is changed in the DNS zone. Visitors follow once DNS caches expire.', confirmLabel: 'Change IP' }))) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const { data } = await api.put(`/account-functions/ip/${username}`, { ip });
      setResult(data);
      toast.success(`${username} now uses ${data.ip}`);
      setIp('');
      refetch();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} description="Moves an account's websites to another IP address configured on this server: the account record, its Apache vhosts and the A records of its zones that pointed at the old address." />
      <Card title="Select an account"><AccountPicker value={username} onChange={(u) => { setUsername(u); setResult(null); }} /></Card>
      {account && (
        <form onSubmit={submit}>
          <Card title={`${account.domain} (${account.username})`}>
            <KeyValue items={[['Current IP', <code key="ip">{account.ip || 'shared / unset'}</code>], ['Owner', account.owner], ['Domains', account.domains?.map((d) => d.domain).join(', ')]]} />
            <ErrorBanner error={error} />
            <div className="form-grid" style={{ marginTop: 14 }}>
              {options.length ? (
                <Field label="New IP address" required error={error?.fields?.ip} help="Addresses come from IP Functions; a free address becomes dedicated to this account">
                  <Select value={ip} onChange={setIp} options={options.filter((o) => o.value !== account.ip)} placeholder="Select an address" />
                </Field>
              ) : (
                <Field label="New IP address" required error={error?.fields?.ip} help="An IPv4 or IPv6 address bound to this server"><TextInput value={ip} onChange={setIp} placeholder="203.0.113.10" /></Field>
              )}
            </div>
            <FormActions><Button type="submit" variant="primary" loading={busy} disabled={!ip}>Change IP address</Button></FormActions>
          </Card>
        </form>
      )}
      {result && (
        <Card title="Result">
          <KeyValue items={[
            ['Previous address', <code key="p">{result.previousIp || '—'}</code>], ['New address', <code key="n">{result.ip}</code>],
            ['Dedicated', result.dedicated ? 'yes' : 'no (shared address)'],
            ['Web server', <StatusPill key="w" status={result.web?.applied ? 'ok' : 'pending'}>{webStatus(result.web)}</StatusPill>],
          ]} />
          {result.dns.length > 0 && (
            <ul style={{ marginTop: 12 }}>
              {result.dns.map((d, i) => <li key={i}><code>{d.name ? `${d.name === '@' ? '' : `${d.name}.`}${d.domain}` : d.domain}</code> <StatusPill status={d.applied ? 'ok' : 'pending'}>{d.applied ? (d.name ? 'A record updated' : d.reason) : d.reason || 'saved; published once BIND runs'}</StatusPill></li>)}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
