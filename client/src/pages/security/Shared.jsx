import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, CapabilityNotice, KeyValue } from '../../components/Common.jsx';
import { Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Modal.jsx';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

// Error display that distinguishes "install the daemon" from real failures.
export function RequestError({ error, onRetry }) {
  if (!error) return null;
  if (isCapabilityError(error)) return <CapabilityNotice error={error} onRetry={onRetry} />;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="row-actions" role="tablist" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={`btn btn-sm ${value === t.value ? 'btn-primary' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="pill pill-muted" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function GradePill({ grade }) {
  const map = { critical: 'failed', warning: 'warning', info: 'pending', ok: 'ok' };
  return <StatusPill status={map[grade] || 'unknown'}>{grade}</StatusPill>;
}

export function ManagedFileNote({ path }) {
  if (!path) return null;
  return <p className="muted" style={{ marginTop: 10 }}>Managed file: <code>{path}</code></p>;
}

// One on/off switch backed by GET/PUT of the same resource; used by Compiler
// Access, Traceroute and SMTP Restrictions.
export function ToggleFeaturePage({ fn, path, field, onLabel = 'Enable', offLabel = 'Disable', isOn, confirmOn, confirmOff, renderStatus, renderDetails, notInstalled }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi(path);
  const [busy, setBusy] = useState(false);
  const on = data ? isOn(data) : false;

  const set = async (value) => {
    const message = value ? confirmOn : confirmOff;
    if (message && !(await confirm({ title: `${value ? onLabel : offLabel}?`, message, confirmLabel: value ? onLabel : offLabel, danger: !value }))) return;
    setBusy(true);
    try {
      await api.put(path, { [field]: value });
      toast.success(`${fn.label}: ${value ? 'enabled' : 'disabled'}`);
      await refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && (
        <Card title="Current state">
          {notInstalled && notInstalled(data) ? notInstalled(data) : (
            <>
              <KeyValue items={[['Status', <StatusPill key="s" status={on ? 'enabled' : 'disabled'}>{renderStatus ? renderStatus(data, on) : on ? 'Enabled' : 'Disabled'}</StatusPill>]]} />
              <FormActions>
                {!on && <Button variant="primary" loading={busy} onClick={() => set(true)}>{onLabel}</Button>}
                {on && <Button variant="danger" loading={busy} onClick={() => set(false)}>{offLabel}</Button>}
                <Button onClick={() => refetch()}>Refresh</Button>
              </FormActions>
            </>
          )}
          {renderDetails && renderDetails(data)}
        </Card>
      )}
    </>
  );
}

// Table of the binaries a chmod-based toggle controls.
export function BinaryTable({ binaries }) {
  if (!binaries?.length) return null;
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table>
        <thead><tr><th>Binary</th><th>Also reached via</th><th>Mode</th><th>Everyone may run</th></tr></thead>
        <tbody>
          {binaries.map((b) => (
            <tr key={b.realPath}>
              <td><code>{b.realPath}</code></td>
              <td>{b.paths.filter((p) => p !== b.realPath).map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}</td>
              <td><code>{b.mode}</code></td>
              <td><StatusPill status={b.othersCanExecute ? 'warning' : 'ok'}>{b.othersCanExecute ? 'yes' : 'no'}</StatusPill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FixLink({ fix }) {
  if (!fix) return null;
  return <Link className="btn btn-sm" to={fix.path}>{fix.label}</Link>;
}
