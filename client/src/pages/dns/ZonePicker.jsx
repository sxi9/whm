import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { Field, Select, TextInput } from '../../components/Form.jsx';
import { StatusPill } from '../../components/Common.jsx';

// Select a DNS zone by domain; pre-selects ?domain= so pages can deep-link.
export function ZonePicker({ value, onChange, label = 'Zone' }) {
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const { data, loading, error, refetch } = useApi('/dns/zones?pageSize=500&sort=domain');
  const zones = data || [];

  useEffect(() => {
    const preset = params.get('domain');
    if (preset && !value && zones.some((z) => z.domain === preset)) onChange(preset);
  }, [params, zones, value, onChange]);

  const options = useMemo(() => zones
    .filter((z) => !filter || `${z.domain} ${z.account || ''}`.toLowerCase().includes(filter.toLowerCase()))
    .map((z) => ({ value: z.domain, label: `${z.domain}${z.account ? ` — ${z.account}` : ' — (no account)'}` })), [zones, filter]);

  return (
    <div className="form-grid">
      <Field label="Filter"><TextInput value={filter} onChange={setFilter} placeholder="Type to filter by domain or account" /></Field>
      <Field label={label} help={loading ? 'Loading zones…' : error ? error.message : `${zones.length} zone(s)`}>
        <Select value={value} onChange={onChange} options={options} placeholder={zones.length ? 'Select a zone' : 'No zones yet'} />
      </Field>
      {error && <button className="link-button" onClick={refetch}>Retry</button>}
    </div>
  );
}

export function useZone(domain) {
  const { data, error, loading, refetch, setData } = useApi(domain ? `/dns/zones/${encodeURIComponent(domain)}` : null, { enabled: Boolean(domain) });
  return { zone: domain ? data : null, error, loading, refetch, setData };
}

// Every DNS mutation answers with { applied, reloaded, serial } so pages can
// tell "saved and live" from "saved but BIND is missing on this host".
export function PublishBadge({ result }) {
  if (!result || result.applied == null) return null;
  if (result.applied === false) return <StatusPill status="warning">Saved, not published: BIND is not installed</StatusPill>;
  if (result.reloadError) return <StatusPill status="warning">Written (serial {result.serial}) but reload failed: {result.reloadError}</StatusPill>;
  return <StatusPill status="ok">Published · serial {result.serial}</StatusPill>;
}

export function publishMessage(result, verb = 'saved') {
  if (!result) return verb;
  if (result.applied === false) return `${verb} (not published: BIND is not installed on this server)`;
  if (result.reloadError) return `${verb}; named reload failed: ${result.reloadError}`;
  return `${verb} and published (serial ${result.serial})`;
}
