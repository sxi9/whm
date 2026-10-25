import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { Field, Select, TextInput } from '../../components/Form.jsx';

// Select an account by username; pre-selects ?username= from the URL so other
// pages can deep-link (e.g. List Accounts → Modify).
export function AccountPicker({ value, onChange, label = 'Account', suspendedOnly = false }) {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const { data, loading } = useApi(`/accounts?pageSize=500&sort=username${suspendedOnly ? '&suspended=true' : ''}`);
  const accounts = data || [];

  useEffect(() => {
    const preset = params.get('username');
    if (preset && !value && accounts.some((a) => a.username === preset)) onChange(preset);
  }, [params, accounts, value, onChange]);

  const options = useMemo(() => accounts
    .filter((a) => !filter || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(filter.toLowerCase()))
    .map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}${a.suspended ? ' (suspended)' : ''}` })), [accounts, filter]);

  return (
    <div className="form-grid">
      <Field label="Filter"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter by user, domain or owner" /></Field>
      <Field label={label} help={loading ? 'Loading accounts…' : `${accounts.length} account(s)`}>
        <Select value={value} onChange={onChange} options={options} placeholder={accounts.length ? 'Select an account' : 'No accounts yet'} />
      </Field>
    </div>
  );
}

export function useSelectedAccount(username) {
  const { data, error, loading, refetch } = useApi(username ? `/accounts/${encodeURIComponent(username)}` : null, { enabled: Boolean(username) });
  return { account: username ? data : null, error, loading, refetch };
}
