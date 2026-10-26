import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, formatMb, CapabilityNotice } from '../../components/Common.jsx';
import { Field, Select, TextInput, NumberInput, Toggle, Button, ErrorBanner } from '../../components/Form.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function ResellerRequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

// Picks a reseller by username; ?username= in the URL pre-selects one so pages
// deep-link to each other (Reseller Center → Privileges, IP delegation…).
export function ResellerPicker({ value, onChange, label = 'Reseller', help }) {
  const [params] = useSearchParams();
  const { data, loading, error, refetch } = useApi('/resellers?pageSize=500&sort=username');
  const resellers = data || [];
  useEffect(() => {
    const preset = params.get('username');
    if (preset && !value && resellers.some((r) => r.username === preset)) onChange(preset);
  }, [params, resellers, value, onChange]);
  const options = useMemo(() => resellers.map((r) => ({ value: r.username, label: `${r.username} — ${r.usage.accounts} account(s)${r.suspended ? ' (suspended)' : ''}` })), [resellers]);
  return (
    <>
      <ErrorBanner error={error} onRetry={refetch} />
      <Field label={label} help={help || (loading ? 'Loading resellers…' : `${resellers.length} reseller(s)`)}>
        <Select value={value} onChange={onChange} options={options} placeholder={resellers.length ? 'Select a reseller' : 'No resellers yet'} />
      </Field>
    </>
  );
}

export function useReseller(username) {
  const { data, error, loading, refetch } = useApi(username ? `/resellers/${encodeURIComponent(username)}` : null, { enabled: Boolean(username) });
  return { reseller: username ? data : null, error, loading, refetch };
}

export function useResellerCatalog() {
  return useApi('/resellers/catalog');
}

// Grouped ACL checkboxes like WHM's privilege editor, with preset lists.
export function AclEditor({ groups = [], lists = [], value = [], onChange, onSaveList, onDeleteList }) {
  const [listName, setListName] = useState('');
  const [newList, setNewList] = useState('');
  const has = (k) => value.includes(k);
  const toggle = (k) => onChange(has(k) ? value.filter((v) => v !== k) : [...value, k]);
  const setGroup = (g, on) => { const keys = g.acls.map((a) => a.key); onChange(on ? [...new Set([...value, ...keys])] : value.filter((v) => !keys.includes(v))); };
  const applyList = () => { const l = lists.find((x) => x.name === listName); if (l) onChange([...l.acls]); };
  return (
    <div className="acl-editor">
      <div className="form-grid" style={{ alignItems: 'end' }}>
        <Field label="Load an ACL list" help="Replaces the selection below with a saved preset">
          <div className="input-group">
            <Select value={listName} onChange={setListName} options={lists.map((l) => ({ value: l.name, label: `${l.name}${l.builtin ? ' (built-in)' : ''} — ${l.acls.length} privilege(s)` }))} placeholder="Choose a list" />
            <Button onClick={applyList} disabled={!listName}>Apply</Button>
            {onDeleteList && listName && !lists.find((l) => l.name === listName)?.builtin && <Button variant="danger-ghost" onClick={() => { onDeleteList(listName); setListName(''); }}>Delete</Button>}
          </div>
        </Field>
        {onSaveList && (
          <Field label="Save the selection as a list" help="Lowercase letters, digits, - or _">
            <div className="input-group">
              <TextInput value={newList} onChange={setNewList} placeholder="e.g. support-tier-2" />
              <Button onClick={() => { onSaveList(newList, value); setNewList(''); }} disabled={!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(newList)}>Save</Button>
            </div>
          </Field>
        )}
      </div>
      <p className="muted" style={{ margin: '4px 0 10px' }}>{value.length} privilege(s) selected{value.includes('all') ? ' — "All Features" grants root-level access to this reseller' : ''}.</p>
      {groups.map((g) => (
        <fieldset key={g.key} className="acl-group" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 12 }}>
          <legend style={{ fontWeight: 600, padding: '0 6px' }}>{g.label}</legend>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGroup(g, true)}>Select all</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGroup(g, false)}>Clear</button>
          </div>
          <div className="form-grid">
            {g.acls.map((a) => (
              <label key={a.key} className="checkbox" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
                <input type="checkbox" checked={has(a.key)} onChange={() => toggle(a.key)} style={{ marginTop: 3 }} />
                <span><strong style={{ fontWeight: 500 }}>{a.label}</strong> <code className="muted" style={{ fontSize: 11 }}>{a.key}</code>{a.help && <small className="muted" style={{ display: 'block' }}>{a.help}</small>}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export function NameserversEditor({ value = [], onChange, owns, onOwnsChange, defaults = [] }) {
  const rows = [...value, '', '', '', ''].slice(0, Math.max(2, Math.min(4, value.length + 1)));
  const set = (i, v) => { const next = [...rows]; next[i] = v; onChange(next.map((n) => n.trim()).filter(Boolean)); };
  return (
    <div>
      <div className="form-grid">
        {rows.map((n, i) => <Field key={i} label={`Nameserver ${i + 1}`} help={i < defaults.length && !n ? `Server default: ${defaults[i]}` : undefined}><TextInput value={n} onChange={(v) => set(i, v)} placeholder={defaults[i] || `ns${i + 1}.example.com`} /></Field>)}
      </div>
      <p className="muted" style={{ margin: '4px 0 8px' }}>Stored with the reseller and handed to DNS Functions when zones for its accounts are created (<code>ctx.resellers.nameserversFor</code>); until DNS Functions reads them, new zones advertise the server defaults.</p>
      {onOwnsChange && <Field inline><Toggle checked={owns} onChange={onOwnsChange} label="Reseller operates these nameservers" description="Informational: the hosts are run by the reseller rather than by this server" /></Field>}
    </div>
  );
}

export function LimitsFields({ form, set, fieldErr }) {
  return (
    <div className="form-grid">
      <Field label="Maximum accounts" help="Blank = unlimited" error={fieldErr('maxAccounts')}><NumberInput value={form.maxAccounts} onChange={set('maxAccounts')} min={0} /></Field>
      <Field label="Disk space (MB)" help="Total quota the reseller may allocate; blank = unlimited" error={fieldErr('maxDiskMb')}><NumberInput value={form.maxDiskMb} onChange={set('maxDiskMb')} min={0} /></Field>
      <Field label="Bandwidth (MB / month)" help="Total bandwidth the reseller may allocate; blank = unlimited" error={fieldErr('maxBandwidthMb')}><NumberInput value={form.maxBandwidthMb} onChange={set('maxBandwidthMb')} min={0} /></Field>
      <Field inline><Toggle checked={form.oversellDisk} onChange={set('oversellDisk')} label="Allow disk overselling" description="Allocated quotas may exceed the limit; only real usage counts" /></Field>
      <Field inline><Toggle checked={form.oversellBandwidth} onChange={set('oversellBandwidth')} label="Allow bandwidth overselling" /></Field>
    </div>
  );
}

export function PackagePicker({ packages = [], value = [], onChange }) {
  const toggle = (n) => onChange(value.includes(n) ? value.filter((v) => v !== n) : [...value, n]);
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{value.length ? `${value.length} package(s) allowed, plus any the reseller creates.` : 'No restriction: the reseller may use every global package it has the privilege to see.'}</p>
      <div className="form-grid">
        {packages.map((p) => (
          <label key={p.name} className="checkbox" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
            <input type="checkbox" checked={value.includes(p.name)} onChange={() => toggle(p.name)} />
            <span>{p.name} <small className="muted">({p.owner})</small></span>
          </label>
        ))}
        {!packages.length && <span className="muted">No packages defined yet.</span>}
      </div>
    </div>
  );
}

export function UsageBar({ used, max, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : null;
  return (
    <div className="usage-bar" title={label}>
      <div className="progress-bar" style={{ height: 6 }}><span style={{ width: `${pct ?? 0}%`, background: pct >= 100 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : undefined }} /></div>
      <small className="muted">{formatMb(used)} / {formatMb(max)}{pct != null ? ` (${pct}%)` : ''}</small>
    </div>
  );
}

export function ResellerStatusPill({ reseller }) {
  if (reseller.suspended) return <StatusPill status="suspended">Privileges suspended</StatusPill>;
  if (!reseller.configured) return <StatusPill status="unknown">Not configured</StatusPill>;
  return <StatusPill status="active">Active</StatusPill>;
}

export function Summary({ items }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 14 }}>
      {items.map(([label, value]) => <div className="stat" key={label}><div className="label">{label}</div><div className="value">{value ?? '—'}</div></div>)}
    </div>
  );
}
