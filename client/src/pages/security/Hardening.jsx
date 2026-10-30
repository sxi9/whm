import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, CapabilityNotice } from '../../components/Common.jsx';
import { Button, TextInput, Toggle, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { useToast } from '../../components/Toast.jsx';
import { RequestError } from './Shared.jsx';

export const STATUS_LABELS = { applied: 'Applied', not_applied: 'Not applied', not_applicable: 'Not applicable', unknown: 'Unknown' };
const STATUS_PILLS = { applied: 'ok', not_applied: 'warning', not_applicable: 'unknown', unknown: 'pending' };
// Items Apply all may switch on without a question; the firewall baseline always asks.
export const SAFE_ITEMS = ['fail2ban', 'auto-updates', 'ssh', 'sysctl'];

export const portLabel = (p) => (typeof p === 'number' ? String(p) : `${p.from}-${p.to}`);

export function ItemStatusPill({ status }) {
  return <StatusPill status={STATUS_PILLS[status] || 'unknown'}>{STATUS_LABELS[status] || status}</StatusPill>;
}

// What the status line under an item says, per item.
export function itemDetailLines(item) {
  const d = item.detail || {};
  const lines = [];
  if (d.reason) lines.push(d.reason);
  if (d.blocked) lines.push(d.blocked);
  switch (item.id) {
    case 'fail2ban':
      if (d.installed && d.jails?.length) lines.push(`Jails: ${d.jails.map((j) => `${j.name}${j.running ? '' : ' (stopped)'}`).join(', ')} · ${d.bannedTotal ?? 0} address${d.bannedTotal === 1 ? '' : 'es'} banned now`);
      break;
    case 'auto-updates':
      if (d.family) lines.push(`${d.family === 'debian' ? 'unattended-upgrades' : 'dnf-automatic'}${d.installed ? '' : ' (not installed)'}${d.timer ? ` · ${d.timer}` : ''}`);
      break;
    case 'ssh':
      if (d.effective) lines.push(Object.entries(d.effective).map(([k, v]) => `${k} ${v ?? 'default'}`).join(' · '));
      if (d.authorizedKeys != null) lines.push(`${d.authorizedKeys} authorized root key${d.authorizedKeys === 1 ? '' : 's'}`);
      break;
    case 'sysctl':
      if (d.mismatched?.length) lines.push(d.mismatched.map((m) => `${m.key} = ${m.current} (want ${m.expected})`).join(', '));
      break;
    case 'firewall':
      if (d.backend) lines.push(`${d.backend}: input policy ${d.policy || 'unknown'}${d.sshdPorts?.length ? ` · sshd on ${d.sshdPorts.join(', ')}` : ''}${d.tcp?.length ? ` · allows tcp ${d.tcp.map(portLabel).join(', ')}` : ''}`);
      break;
    default:
  }
  return lines;
}

function BannedList({ item, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const banned = (item.detail?.jails || []).flatMap((j) => (j.bannedIps || []).map((ip) => ({ jail: j.name, ip })));
  if (!banned.length) return null;
  const unban = async (entry) => {
    setBusy(`${entry.jail}:${entry.ip}`);
    try { await api.post('/security/hardening/fail2ban/unban', entry); toast.success(`${entry.ip} released from ${entry.jail}`); onChanged?.(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table>
        <thead><tr><th>Banned address</th><th>Jail</th><th /></tr></thead>
        <tbody>
          {banned.map((b) => (
            <tr key={`${b.jail}:${b.ip}`}>
              <td><code>{b.ip}</code></td>
              <td>{b.jail}</td>
              <td style={{ textAlign: 'right' }}><Button size="sm" loading={busy === `${b.jail}:${b.ip}`} onClick={() => unban(b)}>Unban</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Install button for a missing daemon (Fail2ban through the stack catalogue,
// unattended-upgrades/dnf-automatic through the item's own apply).
function InstallAction({ item, onDone }) {
  const [state, setState] = useState({ jobId: null, busy: false, error: null });
  const start = async () => {
    setState({ jobId: null, busy: true, error: null });
    try {
      const { data } = item.id === 'fail2ban' ? await api.post('/security/hardening/fail2ban/install') : await api.post(`/security/hardening/${item.id}/apply`, {});
      setState({ jobId: data.job?.id ?? null, busy: false, error: null });
      if (!data.job) onDone?.();
    } catch (err) { setState({ jobId: null, busy: false, error: err }); }
  };
  return (
    <>
      {!state.jobId && <Button variant="primary" size="sm" loading={state.busy} onClick={start}>Install{item.id === 'fail2ban' ? ' Fail2ban' : ''}</Button>}
      {state.error && <ErrorBanner error={state.error} />}
      {state.jobId && <ProgressLog jobId={state.jobId} onFinished={(e) => { if (e.type === 'done') onDone?.(item.id === 'auto-updates'); }} />}
    </>
  );
}

// The default-deny baseline asks for the SSH port in words: the operator types
// the port they are connected on and ticks the sentence; the API refuses any
// port sshd is not listening on, and the agent refuses once more.
export function FirewallConfirmModal({ open, onClose, onApplied }) {
  const toast = useToast();
  const plan = useApi('/security/hardening/firewall/plan', { enabled: open });
  const [port, setPort] = useState('');
  const [agree, setAgree] = useState(false);
  const [extraTcp, setExtraTcp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setPort(''); setAgree(false); setExtraTcp(''); setError(null); } }, [open]);
  const sshPorts = plan.data?.sshPorts || [];
  const ready = agree && /^\d{1,5}$/.test(port) && sshPorts.includes(Number(port));
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const extras = extraTcp.split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
      await api.post('/security/hardening/firewall/apply', { confirmSshPort: Number(port), ...(extras.length ? { extraTcp: extras } : {}) });
      toast.success('Firewall baseline applied');
      onApplied?.();
      onClose?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Apply the firewall baseline" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!ready} loading={busy} onClick={apply}>Apply default-deny baseline</Button></>}>
      <p>The input policy becomes <strong>drop</strong>. Only loopback, established connections, ICMP and the ports below stay reachable; cPHulk and Fail2ban bans keep precedence.</p>
      <RequestError error={plan.error} onRetry={plan.refetch} />
      {plan.loading && !plan.data && <Loading />}
      {plan.data && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Port</th><th>Protocol</th><th>Why</th></tr></thead>
              <tbody>
                {plan.data.tcp.map((e) => <tr key={`tcp-${portLabel(e.port)}`}><td><code>{portLabel(e.port)}</code></td><td>tcp</td><td>{e.reasons.join(', ')}</td></tr>)}
                {plan.data.udp.map((e) => <tr key={`udp-${portLabel(e.port)}`}><td><code>{portLabel(e.port)}</code></td><td>udp</td><td>{e.reasons.join(', ')}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>sshd is listening on port {sshPorts.join(', ') || 'unknown'} ({plan.data.sshSource}). Backend: {plan.data.backend || 'none'}.</p>
          <label className="field"><span className="field-label">Extra TCP ports to keep open (optional, comma separated)</span><TextInput value={extraTcp} onChange={setExtraTcp} placeholder="8443, 3000" /></label>
          <label className="field"><span className="field-label">The SSH port you are connected on</span><TextInput value={port} onChange={setPort} inputMode="numeric" placeholder={String(sshPorts[0] ?? 22)} aria-label="SSH port" /></label>
          <Toggle checked={agree} onChange={setAgree} label={`I can still reach SSH on port ${/^\d{1,5}$/.test(port) ? port : 'N'} and I have a second session open`} description="The baseline is refused for any port sshd is not listening on. It is re-applied at every boot until you revert it." />
        </>
      )}
      <ErrorBanner error={error} />
    </Modal>
  );
}

export function HardeningRow({ item, onChanged, onFirewall }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(null);
  const canApply = item.status === 'not_applied' || item.status === 'unknown';
  const needsInstall = canApply && item.detail?.installable && (item.id === 'fail2ban' || item.id === 'auto-updates') && !item.detail?.installed;
  const canRevert = item.status === 'applied' || item.desired;
  const run = async (action) => {
    if (action === 'revert' && !(await confirm({ title: `Revert ${item.label}?`, message: 'The files the panel wrote are removed (originals restored where one was kept) and the live settings go back to what they were.', confirmLabel: 'Revert', danger: true }))) return;
    setBusy(action);
    try {
      const { data } = await api.post(`/security/hardening/${item.id}/${action}`, {});
      toast.success(data.job ? `${item.label}: installing` : `${item.label}: ${action === 'apply' ? 'applied' : 'reverted'}`);
      onChanged?.();
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  };
  return (
    <tr>
      <td style={{ width: 120 }}><ItemStatusPill status={item.status} /></td>
      <td>
        <div><strong>{item.label}</strong></div>
        <small className="muted">{item.description}</small>
        {itemDetailLines(item).map((line, i) => <div key={i} className="muted" style={{ fontSize: 12, marginTop: 2 }}>{line}</div>)}
        {item.id === 'ssh' && item.detail?.blocked && <div style={{ marginTop: 4 }}><Link className="btn btn-sm" to="/security-center/manage-roots-ssh-keys">Manage root's SSH Keys</Link></div>}
        {item.id === 'fail2ban' && <BannedList item={item} onChanged={onChanged} />}
        {item.id === 'firewall' && canApply && !item.detail?.backend && <CapabilityNotice error={{ status: 501, code: 'capability_missing', capability: 'firewall', message: item.detail?.reason || 'No supported firewall is installed' }} onRetry={onChanged} />}
      </td>
      <td style={{ width: 200, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {needsInstall && <InstallAction item={item} onDone={(reapply) => (reapply ? run('apply') : onChanged?.())} />}
        {!needsInstall && canApply && item.id !== 'firewall' && !item.detail?.blocked && <Button variant="primary" size="sm" loading={busy === 'apply'} onClick={() => run('apply')}>Apply</Button>}
        {!needsInstall && canApply && item.id === 'firewall' && item.detail?.backend && <Button variant="primary" size="sm" onClick={onFirewall}>Apply…</Button>}
        {canRevert && <Button size="sm" variant="danger" loading={busy === 'revert'} onClick={() => run('revert')} style={{ marginLeft: 6 }}>Revert</Button>}
      </td>
    </tr>
  );
}

export function HardeningCard() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/security/hardening');
  const [firewallOpen, setFirewallOpen] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const items = data?.items || [];
  const pending = items.filter((i) => SAFE_ITEMS.includes(i.id) && i.status === 'not_applied' && !i.detail?.blocked && i.detail?.installed !== false);
  const applyAll = async () => {
    setApplyingAll(true);
    let ok = 0;
    for (const item of pending) {
      try { await api.post(`/security/hardening/${item.id}/apply`, {}); ok++; } catch (err) { toast.error(err); }
    }
    setApplyingAll(false);
    if (ok) toast.success(`${ok} hardening item${ok === 1 ? '' : 's'} applied`);
    refetch();
  };
  const applied = items.filter((i) => i.status === 'applied').length;
  const applicable = items.filter((i) => i.status !== 'not_applicable').length;
  return (
    <Card title="Hardening" subtitle={data ? `${applied} of ${applicable} items applied. Each item changes one thing on this server, shows its live state and can be reverted; the firewall baseline asks for your SSH port first.` : 'One-click hardening with live state.'} padded={false}
      actions={<><Button onClick={() => refetch()}>Refresh</Button>{pending.length > 0 && <Button variant="primary" loading={applyingAll} onClick={applyAll}>Apply {pending.length} recommended</Button>}</>}>
      <div id="hardening" />
      <div style={{ padding: '0 16px' }}>
        {error && error.status === 501 ? <CapabilityNotice error={error} onRetry={refetch} /> : <RequestError error={error} onRetry={refetch} />}
      </div>
      {loading && !data && <Loading />}
      {data && (
        <div className="table-wrap">
          <table>
            <tbody>
              {items.map((item) => <HardeningRow key={item.id} item={item} onChanged={refetch} onFirewall={() => setFirewallOpen(true)} />)}
            </tbody>
          </table>
        </div>
      )}
      <FirewallConfirmModal open={firewallOpen} onClose={() => setFirewallOpen(false)} onApplied={refetch} />
    </Card>
  );
}
