import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Card, StatusPill, CapabilityNotice, KeyValue, Loading } from '../../components/Common.jsx';
import { Field, Select, TextInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal } from '../../components/Modal.jsx';

export const PRIVILEGES = ['ALL PRIVILEGES', 'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX', 'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
export const PG_PRIVILEGES = ['ALL PRIVILEGES', 'CONNECT', 'CREATE', 'TEMPORARY'];

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

// Capability errors become the install prompt; everything else is a plain banner.
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function useIsRoot() {
  const { user } = useAuth();
  return user?.role === 'root';
}

export function useDbStatus() {
  return useApi('/databases/status');
}

export const engineLabel = (engine) => ({ mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL' }[engine] || engine || 'unknown');

// Header strip shared by the database pages: active profile, detected engine,
// version and unit state, plus a link to the profiles page.
export function EngineBanner({ status, loading, error, onRetry }) {
  if (loading && !status) return <Loading text="Checking the database server…" />;
  if (error && !status) return <RequestError error={error} onRetry={onRetry} />;
  if (!status) return null;
  const engineOk = status.profile && status.capabilities?.[status.profile.engine === 'postgres' ? 'postgres' : 'mysql'];
  return (
    <Card>
      <div className="stat-grid">
        <div className="stat"><div className="label">Active profile</div><div className="value">{status.profile ? status.profile.profile_name : '—'}</div><div className="muted">{status.profile ? `${engineLabel(status.profile.engine)} · ${status.profile.host}${status.profile.port ? `:${status.profile.port}` : ''}` : <Link to="/database-services/manage-database-profiles">Add a profile</Link>}</div></div>
        <div className="stat"><div className="label">Server</div><div className="value">{status.version ? status.version.version : <StatusPill status={engineOk ? 'warning' : 'not-installed'}>{engineOk ? (status.error?.message || 'unreachable') : 'not installed'}</StatusPill>}</div><div className="muted">{status.detect?.engine ? `${engineLabel(status.detect.engine)} tooling detected` : 'no MySQL/MariaDB binaries found'}{status.detect?.postgres?.installed ? ' · PostgreSQL present' : ''}</div></div>
        <div className="stat"><div className="label">Service</div><div className="value">{status.unit ? <StatusPill status={status.unit.state === 'active' ? 'active' : status.unit.state === 'not-installed' ? 'not-installed' : 'down'}>{status.unit.unit || 'no unit'} · {status.unit.state}</StatusPill> : <span className="muted">—</span>}</div><div className="muted">{status.unit?.pid ? `PID ${status.unit.pid}` : status.profile && !status.profile.is_local ? 'remote server' : ''}</div></div>
        <div className="stat"><div className="label">Managed</div><div className="value">{status.counts?.databases ?? 0} / {status.counts?.users ?? 0}</div><div className="muted">databases / users mapped to accounts{status.prefixing ? ' · prefixing on' : ''}</div></div>
      </div>
    </Card>
  );
}

// Account selector for root (with an optional "no account" choice) that becomes
// a plain list of the reseller's own accounts otherwise.
export function AccountSelect({ value, onChange, label = 'Account', allowNone = false, noneLabel = 'None (server-wide, root only)', help }) {
  const isRoot = useIsRoot();
  const { data, loading } = useApi('/accounts?pageSize=500&sort=username');
  const accounts = data || [];
  useEffect(() => { if (!isRoot && !value && accounts.length === 1) onChange(accounts[0].username); }, [isRoot, accounts, value, onChange]);
  const options = accounts.map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}${a.suspended ? ' (suspended)' : ''}` }));
  return (
    <Field label={label} help={help || (loading ? 'Loading accounts…' : `${accounts.length} account(s)`)}>
      <Select value={value} onChange={onChange} options={options} placeholder={allowNone && isRoot ? noneLabel : accounts.length ? 'Select an account' : 'No accounts yet'} />
    </Field>
  );
}

export function PrivilegesEditor({ value = [], onChange, engine = 'mysql' }) {
  const list = engine === 'postgres' ? PG_PRIVILEGES : PRIVILEGES;
  const all = value.includes('ALL PRIVILEGES');
  const toggle = (p) => {
    if (p === 'ALL PRIVILEGES') { onChange(all ? [] : ['ALL PRIVILEGES']); return; }
    const next = new Set(value.filter((v) => v !== 'ALL PRIVILEGES'));
    if (next.has(p)) next.delete(p); else next.add(p);
    onChange([...next]);
  };
  return (
    <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
      {list.map((p) => (
        <label key={p} className="radio" style={{ padding: '4px 0' }}>
          <input type="checkbox" checked={all ? true : value.includes(p)} disabled={all && p !== 'ALL PRIVILEGES'} onChange={() => toggle(p)} />
          <span><strong>{p}</strong></span>
        </label>
      ))}
    </div>
  );
}

// Modal that edits a user's per-database grants against the databases the
// current principal may grant on (same account for resellers, all for root).
export function GrantsModal({ user, engine, onClose, onSaved }) {
  const { data: current, loading, error } = useApi(user ? `/databases/users/${encodeURIComponent(user.name)}/grants` : null, { enabled: Boolean(user) });
  const { data: dbs } = useApi(user ? `/databases/databases?pageSize=500${user.account ? `&account=${encodeURIComponent(user.account)}` : ''}` : null, { enabled: Boolean(user) });
  const [grants, setGrants] = useState([]);
  const [selectedDb, setSelectedDb] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (current) setGrants(current.grants.map((g) => ({ ...g }))); }, [current]);
  const available = useMemo(() => (dbs || []).filter((d) => !grants.some((g) => g.database === d.name)), [dbs, grants]);
  const setPrivs = (database, privileges) => setGrants((gs) => gs.map((g) => (g.database === database ? { ...g, privileges } : g)));
  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      const payload = grants.filter((g) => g.privileges.length);
      const { data } = await api.put(`/databases/users/${encodeURIComponent(user.name)}/grants`, { grants: payload });
      onSaved?.(data);
      onClose();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={Boolean(user)} title={`Privileges for ${user?.name}`} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={loading}>Save privileges</Button></>}>
      {loading && <Loading />}
      <RequestError error={error} />
      <ErrorBanner error={saveError} />
      {current && (
        <>
          {current.hosts?.length > 0 && <p className="muted">Applied at hosts: {current.hosts.map((h) => <code key={h} style={{ marginRight: 6 }}>{h}</code>)}</p>}
          {grants.length === 0 && <p className="muted">This user has no database privileges yet.</p>}
          {grants.map((g) => (
            <Card key={g.database} title={<code>{g.database}</code>} actions={<Button size="sm" variant="danger-ghost" onClick={() => setGrants((gs) => gs.filter((x) => x.database !== g.database))}>Remove</Button>}>
              <PrivilegesEditor value={g.privileges} onChange={(p) => setPrivs(g.database, p)} engine={engine} />
            </Card>
          ))}
          <div className="form-grid">
            <Field label="Add a database" help={available.length ? '' : 'Every database you may grant on is already listed'}>
              <Select value={selectedDb} onChange={setSelectedDb} options={available.map((d) => ({ value: d.name, label: d.name }))} placeholder="Select a database" />
            </Field>
            <FormActions><Button disabled={!selectedDb} onClick={() => { setGrants((gs) => [...gs, { database: selectedDb, privileges: ['ALL PRIVILEGES'] }]); setSelectedDb(''); }}>Add with all privileges</Button></FormActions>
          </div>
        </>
      )}
    </Modal>
  );
}

// Dropdown of database users the principal may manage.
export function DbUserSelect({ value, onChange, label = 'Database user', includeUnmapped = true }) {
  const { data, loading, error, refetch } = useApi('/databases/users?pageSize=500');
  const users = (data || []).filter((u) => includeUnmapped || u.mapped);
  return (
    <>
      <RequestError error={error} onRetry={refetch} />
      <Field label={label} help={loading ? 'Loading users…' : `${users.length} user(s)`}>
        <Select value={value} onChange={onChange} options={users.map((u) => ({ value: u.name, label: `${u.name}${u.account ? ` — ${u.account}` : ''}${u.onServer === false ? ' (missing on server)' : ''}` }))} placeholder={users.length ? 'Select a user' : 'No database users yet'} />
      </Field>
    </>
  );
}

export function ProfileSummary({ profile }) {
  if (!profile) return null;
  return <KeyValue items={[['Profile', profile.profile_name], ['Engine', engineLabel(profile.engine)], ['Host', `${profile.host}${profile.port ? `:${profile.port}` : ''}`], ['Admin user', profile.admin_user || (profile.is_local ? 'root via /root/.my.cnf or socket' : '—')]]} />;
}

export function HostInput({ value, onChange, error }) {
  return (
    <Field label="Remote host" required error={error} help="IP address, hostname or wildcard pattern (203.0.113.% or %.example.com). localhost is always allowed.">
      <TextInput value={value} onChange={onChange} placeholder="203.0.113.5" />
    </Field>
  );
}
