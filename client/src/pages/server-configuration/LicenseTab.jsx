import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, KeyRound, RefreshCw } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, StatusPill, KeyValue, Loading, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

export const LICENSE_PATH = '/server-configuration/basic-webhost-manager-setup#license';
const TONE = { active: 'active', grace: 'warning', degraded: 'error', expired: 'error', suspended: 'suspended', revoked: 'error', unlicensed: 'warning' };
const FLAGS = ['api', 'transfers', 'clusters', 'multi_server', 'marketplace_free', 'marketplace_paid', 'white_label', 'autossl_wildcard', 'sso', 'terminal', 'priority_support', 'custom_branding_builder'];
const LIMIT_LABELS = { max_accounts: 'Hosting accounts', max_resellers: 'Resellers', max_activations: 'Servers', max_domains_per_account: 'Domains per account' };

export const describeStatus = (l) => ({
  active: 'This server is licensed and checking in with the hub.',
  grace: `The last token could not be refreshed; the panel keeps working for ${l.grace ?? 7} days while it retries.`,
  degraded: 'The panel is read-only: sites, mail and databases keep running, but nothing can be created or changed until a valid license is active.',
  expired: 'The license term has ended. Renew it with your vendor and check in again.',
  suspended: 'The vendor suspended this license. The panel is read-only until it is unsuspended.',
  revoked: 'The vendor revoked this license. The panel is read-only until a new key is activated.',
  unlicensed: 'No license is active on this server. Enter a key or start a free trial.',
}[l.status] || '');

const limitText = (v) => (v == null ? '—' : v === -1 ? 'unlimited' : String(v));

// Shell banner (Layout) for grace/degraded states; `license` is /api/auth/me.license.
export function LicenseBanner({ license }) {
  if (!license || !license.enforce || license.status === 'active') return null;
  const grace = license.status === 'grace';
  return (
    <div className={`banner ${grace ? 'banner-warning' : 'banner-error'}`} role="alert" data-testid="license-banner">
      <AlertTriangle size={18} />
      <div>
        <strong>{grace ? `License in grace period${license.daysLeft != null ? ` · ${license.daysLeft} days left` : ''}` : `License ${license.status}${license.reason ? ` (${license.reason.replace(/_/g, ' ')})` : ''}`}</strong>
        <small>{grace ? 'The panel could not refresh its license token; it keeps working while it retries. ' : 'The panel is read-only until a valid license is active; sites, mail and databases keep running. '}<Link to={license.action || LICENSE_PATH}>Open the License tab</Link></small>
      </div>
    </div>
  );
}

export function LicenseStatusCard({ license, onCheckin, checking }) {
  const l = license;
  return (
    <Card title="License" subtitle={describeStatus(l)} actions={l.activationId && <Button size="sm" icon={RefreshCw} loading={checking} onClick={onCheckin}>Check in now</Button>}>
      <KeyValue items={[
        ['Status', <StatusPill key="s" status={TONE[l.status] || 'unknown'}>{l.status}</StatusPill>],
        ['Edition', l.editionLabel || l.edition || '—'],
        ['Key', l.keyPrefix ? `${l.keyPrefix}-XXXX-XXXX-XXXX` : '—'],
        ['License expires', l.lexp ? `${formatDate(l.lexp * 1000)}${l.daysLeft != null ? ` (${l.daysLeft} days)` : ''}` : '—'],
        ['Token valid until', l.exp ? formatDate(l.exp * 1000) : '—'],
        ['Activation', l.activationId || '—'],
        ['Hub', l.hubUrl || 'not configured'],
        ['Last check-in', l.lastCheckinAt ? `${formatDate(l.lastCheckinAt)}${l.failCount ? ` · ${l.failCount} failed` : ''}` : 'never'],
        ['Next check-in', l.nextCheckinAt ? formatDate(l.nextCheckinAt) : '—'],
        ['Enforcement', l.enforce ? 'on' : <span className="muted">off (development)</span>],
      ]} />
      {l.hasToken && l.tokenVerified === false && (
        <p className="muted" data-testid="license-unverified" style={{ marginTop: 10 }}>
          <AlertTriangle size={14} /> The stored license token cannot be verified against the license keys shipped with this release, so no edition, limits or features are shown and the bootstrap hub is used. Check in now or re-enter the key.
        </p>
      )}
      {l.messages?.length > 0 && (
        <ul className="list-plain" style={{ marginTop: 10 }}>
          {l.messages.map((m, i) => <li key={`${m.code}-${i}`}><StatusPill status={m.level === 'error' ? 'error' : m.level === 'warning' ? 'warning' : 'pending'}>{m.code}</StatusPill> {m.text}</li>)}
        </ul>
      )}
    </Card>
  );
}

export function EntitlementsCard({ license }) {
  const l = license;
  if (!l.edition) return null;
  return (
    <Card title="Edition limits and features" subtitle="Limits are enforced when accounts or resellers are created; features gate whole functions.">
      <div className="grid-2">
        <KeyValue items={Object.entries(LIMIT_LABELS).map(([k, label]) => [label, limitText(l.limits?.[k])])} />
        <KeyValue items={FLAGS.map((f) => [f.replace(/_/g, ' '), <StatusPill key={f} status={l.features?.[f] ? 'enabled' : 'disabled'}>{l.features?.[f] ? 'included' : 'not included'}</StatusPill>])} />
      </div>
    </Card>
  );
}

export function LicenseKeyForm({ hasKey, busy, error, onSubmit, replace = false }) {
  const [key, setKey] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(key.trim() || undefined); }}>
      <Field label={replace ? 'New license key' : 'License key'} help="WHM-XXXX-XXXX-XXXX-XXXX, as issued by your vendor or reseller. The key is stored encrypted and never shown again." error={error?.fields?.key?.join(', ')}>
        <TextInput value={key} onChange={setKey} placeholder="WHM-XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} style={{ fontFamily: 'var(--mono)', maxWidth: 360 }} />
      </Field>
      <FormActions>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!key.trim() && !hasKey}>{replace ? 'Replace key and activate' : hasKey ? (key.trim() ? 'Activate' : 'Activate with the stored key') : 'Activate'}</Button>
      </FormActions>
    </form>
  );
}

export function ActivationsCard({ activations, license, onDeactivate, onTransfer, busy }) {
  if (!activations) return null;
  const { current, others, max } = activations;
  return (
    <Card title="Activations" subtitle={max != null ? `${max === -1 ? 'Unlimited' : max} server${max === 1 ? '' : 's'} allowed on this license.` : undefined}>
      {!current && !others?.length && <p className="muted">This server is not activated.</p>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Activation</th><th>Hostname</th><th>Last check-in</th><th>Status</th><th /></tr></thead>
          <tbody>
            {current && (
              <tr>
                <td><code>{current.id}</code></td>
                <td>{current.hostname || '—'} <span className="pill pill-info">this server</span></td>
                <td>{current.lastCheckinAt ? formatDate(current.lastCheckinAt) : 'never'}</td>
                <td><StatusPill status={TONE[current.status] || 'unknown'}>{current.status}</StatusPill></td>
                <td className="row-actions"><Button size="sm" variant="danger" loading={busy} onClick={onDeactivate}>Deactivate this server</Button></td>
              </tr>
            )}
            {(others || []).map((a) => (
              <tr key={a.id}>
                <td><code>{a.id}</code></td>
                <td>{a.hostname || '—'}</td>
                <td>{a.last_checkin ? formatDate(a.last_checkin) : 'unknown'}</td>
                <td><StatusPill status="inactive">other server</StatusPill></td>
                <td className="row-actions">{license?.hasKey && <Button size="sm" loading={busy} onClick={() => onTransfer(a)}>Transfer here</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function TrialCard({ onStart, busy, error, defaultEmail = '' }) {
  const [email, setEmail] = useState(defaultEmail);
  return (
    <Card title="Start a free trial" subtitle="14 days, 5 hosting accounts, one trial per server and e-mail address. The trial converts to a paid edition without re-activation.">
      <form onSubmit={(e) => { e.preventDefault(); onStart(email.trim()); }}>
        <Field label="E-mail address" error={error?.fields?.email?.join(', ')}><TextInput type="email" value={email} onChange={setEmail} placeholder="ops@example.com" style={{ maxWidth: 360 }} /></Field>
        <FormActions><Button type="submit" loading={busy} disabled={!email.trim()}>Start trial</Button></FormActions>
      </form>
    </Card>
  );
}

export function TransferModal({ open, activations, onClose, onTransfer, busy }) {
  return (
    <Modal open={open} title="All activations are in use" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <p>This license has no free activation. Transfer one of the servers below to this one; the other server enters read-only mode at its next check-in.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Activation</th><th>Hostname</th><th>Last check-in</th><th /></tr></thead>
          <tbody>
            {(activations || []).map((a) => (
              <tr key={a.id}><td><code>{a.id}</code></td><td>{a.hostname || '—'}</td><td>{a.last_checkin ? formatDate(a.last_checkin) : 'unknown'}</td><td className="row-actions"><Button size="sm" variant="primary" loading={busy} onClick={() => onTransfer(a)}>Transfer here</Button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export default function LicenseTab({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useAuth();
  const { data: license, loading, error, refetch } = useApi('/license');
  const { data: activations, refetch: refetchActivations } = useApi('/license/activations');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [pendingKey, setPendingKey] = useState(null);

  const run = async (name, fn2, ok) => {
    setBusy(name);
    setActionError(null);
    try {
      const res = await fn2();
      if (ok) toast.success(ok(res));
      await Promise.all([refetch(), refetchActivations(), refresh()]);
      return res;
    } catch (err) {
      if (err.code === 'activation_limit' && err.fields?.activations?.length) setTransfer(err.fields.activations);
      setActionError(err);
      toast.error(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const activate = (key, transferFrom) => {
    setPendingKey(key ?? null);
    return run('key', () => api.post('/license/key', { ...(key ? { key } : {}), ...(transferFrom ? { transferFrom } : {}) }), (r) => `License activated: ${r.data.editionLabel || r.data.edition}`);
  };
  const checkin = () => run('checkin', () => api.post('/license/checkin'), (r) => (r.data.ok ? `Checked in: ${r.data.status}` : `Check-in failed: ${r.data.message}`));
  const deactivate = async () => {
    if (!(await confirm({ title: 'Deactivate this server?', message: 'The activation is released for another server. The panel becomes read-only here until a key is activated again; sites keep running.', confirmLabel: 'Deactivate', danger: true }))) return;
    run('deactivate', () => api.post('/license/deactivate', {}), () => 'License deactivated on this server');
  };
  const startTrial = (email) => run('trial', () => api.post('/license/trial', { email }), () => 'Trial started');
  const doTransfer = async (a) => { setTransfer(null); await activate(pendingKey ?? undefined, a.id); };

  return (
    <>
      <PageHeader fn={fn} title="License" description="Activate, replace or check in the license for this server. The key is entered only here." />
      {loading && !license && <Loading />}
      <ErrorBanner error={error} onRetry={refetch} />
      {license && (
        <>
          <LicenseStatusCard license={license} onCheckin={checkin} checking={busy === 'checkin'} />
          <ErrorBanner error={actionError} />
          <EntitlementsCard license={license} />
          <Card title={license.activationId ? 'Replace the license key' : 'Activate with a license key'} subtitle={license.hubUrl ? `Activation is requested from ${license.hubUrl}.` : 'No hub is configured: set WHM_LICENSE_HUB_URL on the server before activating.'}>
            <LicenseKeyForm hasKey={license.hasKey} replace={Boolean(license.activationId)} busy={busy === 'key'} error={actionError?.code === 'invalid_key' ? actionError : null} onSubmit={(key) => activate(key)} />
          </Card>
          <ActivationsCard activations={activations} license={license} busy={busy === 'deactivate' || busy === 'key'} onDeactivate={deactivate} onTransfer={(a) => activate(undefined, a.id)} />
          {!license.activationId && <TrialCard onStart={startTrial} busy={busy === 'trial'} error={actionError?.code === 'validation_failed' ? actionError : null} />}
          {license.hubUrl && <p className="muted">Renewals, upgrades and invoices: <a href={license.hubUrl} target="_blank" rel="noreferrer">open the vendor portal</a>.</p>}
          {license.events?.length > 0 && (
            <Card title="Recent license events">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
                  <tbody>{license.events.slice(0, 15).map((e) => <tr key={e.id}><td>{formatDate(e.ts)}</td><td><code>{e.event}</code></td><td className="muted">{e.detail ? Object.entries(e.detail).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</td></tr>)}</tbody>
                </table>
              </div>
            </Card>
          )}
          <TransferModal open={Boolean(transfer)} activations={transfer} onClose={() => setTransfer(null)} onTransfer={doTransfer} busy={busy === 'key'} />
        </>
      )}
    </>
  );
}
