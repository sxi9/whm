import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { ErrorBanner, Field, Select, TextInput } from '../../components/Form.jsx';

// One wording for every account chooser: '1 account' / '12 accounts'.
export const accountCountText = (count) => `${count} ${count === 1 ? 'account' : 'accounts'}`;

// Nothing to pick from: say where accounts come from instead of an empty select.
export function NoAccountsState() {
  return <p className="muted" style={{ margin: 0 }}>No accounts yet. <Link to="/account-functions/create-a-new-account">Create a new account</Link> first; it appears here as soon as it exists.</p>;
}

// Select an account by username; pre-selects ?username= from the URL so other
// pages can deep-link (e.g. List Accounts → Modify).
export function AccountPicker({ value, onChange, label = 'Account', suspendedOnly = false }) {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const { data, loading, error } = useApi(`/accounts?pageSize=500&sort=username${suspendedOnly ? '&suspended=true' : ''}`);
  const accounts = data || [];

  useEffect(() => {
    const preset = params.get('username');
    if (preset && !value && accounts.some((a) => a.username === preset)) onChange(preset);
  }, [params, accounts, value, onChange]);

  const options = useMemo(() => accounts
    .filter((a) => !filter || `${a.username} ${a.domain} ${a.owner}`.toLowerCase().includes(filter.toLowerCase()))
    .map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}${a.suspended ? ' (suspended)' : ''}` })), [accounts, filter]);

  if (!loading && !error && accounts.length === 0) return <NoAccountsState />;

  return (
    <div className="form-grid">
      <ErrorBanner error={error} />
      <Field label="Filter"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter by user, domain or owner" /></Field>
      <Field label={label} help={loading ? 'Loading accounts…' : accountCountText(accounts.length)}>
        <Select value={value} onChange={onChange} options={options} placeholder="Select an account" />
      </Field>
    </div>
  );
}

export function useSelectedAccount(username) {
  const { data, error, loading, refetch } = useApi(username ? `/accounts/${encodeURIComponent(username)}` : null, { enabled: Boolean(username) });
  return { account: username ? data : null, error, loading, refetch };
}
