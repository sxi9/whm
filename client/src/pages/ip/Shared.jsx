import { Link } from 'react-router-dom';
import { useApi } from '../../hooks/useApi.js';
import { StatusPill, CapabilityNotice } from '../../components/Common.jsx';
import { Field, Select, ErrorBanner } from '../../components/Form.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

// Error display that distinguishes "install iproute2" from real failures.
export function IpRequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function FamilyPill({ family }) {
  return <span className={`pill ${family === 6 ? 'pill-info' : 'pill-muted'}`}>IPv{family}</span>;
}

const STATUS_TONE = { main: 'info', reserved: 'warning', dedicated: 'ok', shared: 'ok', free: 'unknown', missing: 'failed', unknown: 'failed', unmanaged: 'warning' };
const STATUS_LABEL = { main: 'main IP', reserved: 'reserved', dedicated: 'dedicated', shared: 'shared', free: 'free', missing: 'not on host', unknown: 'not recorded', unmanaged: 'dynamic (host-owned)' };

export function AddressStatusPill({ status }) {
  return <StatusPill status={STATUS_TONE[status] || 'unknown'}>{STATUS_LABEL[status] || status}</StatusPill>;
}

export function BoundPill({ bound }) {
  if (bound == null) return <StatusPill status="unknown">unknown</StatusPill>;
  return <StatusPill status={bound ? 'up' : 'down'}>{bound ? 'bound' : 'not bound'}</StatusPill>;
}

// Shown on list pages when the host has no iproute2: the inventory still works,
// but nothing can be bound or removed until the package is installed.
export function Iproute2Notice({ meta }) {
  if (!meta || meta.iproute2 !== false) return null;
  return (
    <div className="banner banner-warning">
      <div>
        <strong>iproute2 is not installed</strong>
        <p>The <code>ip</code> command was not found, so addresses cannot be bound to or removed from interfaces. The inventory below is read-only until the <code>iproute2</code> package is installed (for example via <Link to="/software/install-distro-packages">Install Distro Packages</Link>).</p>
      </div>
    </div>
  );
}

// Interface selector fed by GET /ip/interfaces; pre-fills the suggested device.
export function InterfaceSelect({ value, onChange, family = 4, label = 'Interface', help, error }) {
  const { data, loading } = useApi('/ip/interfaces');
  const options = (data?.interfaces || []).map((i) => ({ value: i.name, label: `${i.name}${i.state ? ` (${i.state.toLowerCase()})` : ''} — ${i.addresses.filter((a) => a.scope == null || a.scope === 'global').map((a) => a.address).slice(0, 3).join(', ') || 'no addresses'}` }));
  const suggested = data?.suggested?.[family === 6 ? 'ipv6' : 'ipv4'];
  return (
    <Field label={label} help={help || (loading ? 'Detecting interfaces…' : suggested ? `Blank uses ${suggested} (default route)` : 'Blank uses the interface of the default route')} error={error}>
      <Select value={value} onChange={onChange} options={options} placeholder={suggested ? `Auto (${suggested})` : 'Auto-detect'} />
    </Field>
  );
}

export function Summary({ items }) {
  return (
    <div className="stat-grid">
      {items.map(([label, value]) => <div className="stat" key={label}><div className="value">{value ?? '—'}</div><div className="label">{label}</div></div>)}
    </div>
  );
}
