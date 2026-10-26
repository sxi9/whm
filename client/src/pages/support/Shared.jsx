import { useEffect, useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';
import { StatusPill } from '../../components/Common.jsx';
import { Button } from '../../components/Form.jsx';

export { RequestError, isCapabilityError } from '../security/Shared.jsx';

const SEVERITY_TONE = { low: 'unknown', normal: 'queued', high: 'warning', critical: 'failed' };
export function SeverityPill({ severity }) { return <StatusPill status={SEVERITY_TONE[severity] || 'unknown'}>{severity}</StatusPill>; }

const DELIVERY_TONE = { sent: 'ok', failed: 'failed', not_sent: 'inactive' };
export function DeliveryPill({ delivery }) {
  const status = delivery?.status || 'not_sent';
  return <StatusPill status={DELIVERY_TONE[status] || 'unknown'}>{status === 'not_sent' ? 'not sent' : status}</StatusPill>;
}

export function formatRemaining(seconds) {
  if (seconds == null) return '—';
  if (seconds <= 0) return 'expired';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Live countdown for an active grant, ticking once a minute from the server's figure.
export function Remaining({ seconds, at }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const left = seconds == null ? null : seconds - Math.round((now - at) / 1000);
  return <span className={left != null && left <= 0 ? 'muted' : ''}>{formatRemaining(left)}</span>;
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CopyButton({ text, label = 'Copy', size = 'sm' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
  };
  return <Button size={size} icon={done ? Check : Copy} onClick={copy}>{done ? 'Copied' : label}</Button>;
}

// A one-time secret (private key, token) with copy and download; the page that
// shows it is the only place it ever exists in the clear.
export function SecretBlock({ label, value, filename, help, mono = true }) {
  return (
    <div className="field">
      <div className="field-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>{label}</span>
        <span className="row-actions">
          <CopyButton text={value} />
          {filename && <Button size="sm" icon={Download} onClick={() => downloadText(filename, value)}>Download</Button>}
        </span>
      </div>
      <pre className="log" style={{ maxHeight: 220, fontFamily: mono ? undefined : 'inherit' }}>{value}</pre>
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}
