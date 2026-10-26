import { useState } from 'react';
import { formatBytes } from '../../components/Common.jsx';
import { periodLabel } from './Shared.jsx';

const W = 720;
const H = 220;
const PAD = { top: 18, right: 16, bottom: 28, left: 56 };

// Monthly transfer for one account as thin rounded bars with the limit as a
// dashed rule. Over-limit months are also named in the table beside the chart,
// so colour is never the only signal. No chart library: plain SVG.
export function BandwidthChart({ months = [], limitMb }) {
  const [hover, setHover] = useState(null);
  if (!months.length) return <p className="muted">No bandwidth has been recorded yet.</p>;
  const limitBytes = limitMb > 0 ? limitMb * 1048576 : 0;
  const maxValue = Math.max(1, ...months.map((m) => m.bytes), limitBytes) * 1.1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / months.length;
  const barW = Math.max(6, Math.min(36, slot - 2));
  const y = (v) => PAD.top + plotH - (v / maxValue) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => maxValue * f / 1.1);
  const maxIndex = months.reduce((best, m, i) => (m.bytes > months[best].bytes ? i : best), 0);

  const bar = (m, i) => {
    const x = PAD.left + i * slot + (slot - barW) / 2;
    const top = y(m.bytes);
    const bottom = PAD.top + plotH;
    const h = Math.max(0, bottom - top);
    const r = Math.min(4, barW / 2, h);
    const over = limitBytes > 0 && m.bytes >= limitBytes;
    const path = h === 0 ? null : `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z`;
    const label = i === months.length - 1 || i === maxIndex;
    return (
      <g key={m.period} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
        <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" />
        {path && <path d={path} fill={over ? 'var(--bad)' : 'var(--primary)'} opacity={hover == null || hover === i ? 1 : 0.55} />}
        {h === 0 && <rect x={x} y={bottom - 1} width={barW} height={1} fill="var(--border-strong)" />}
        {label && m.bytes > 0 && <text x={x + barW / 2} y={top - 5} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{formatBytes(m.bytes)}</text>}
        <text x={PAD.left + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{months.length > 14 ? m.period.slice(5) : periodLabel(m.period).replace(/ \d{4}$/, '')}</text>
      </g>
    );
  };

  const hovered = hover == null ? null : months[hover];
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Monthly bandwidth usage" style={{ display: 'block', maxHeight: 280 }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-faint)">{formatBytes(v)}</text>
          </g>
        ))}
        {limitBytes > 0 && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(limitBytes)} y2={y(limitBytes)} stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="5 4" />
            <text x={W - PAD.right} y={y(limitBytes) - 5} textAnchor="end" fontSize="11" fill="var(--text-muted)">Limit {formatBytes(limitBytes)}</text>
          </g>
        )}
        {months.map(bar)}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--border-strong)" strokeWidth="1" />
      </svg>
      {hovered && (
        <div className="card" style={{ position: 'absolute', top: 4, left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%`, transform: 'translateX(-50%)', padding: '6px 10px', fontSize: 12, pointerEvents: 'none', boxShadow: 'var(--shadow)' }}>
          <strong>{periodLabel(hovered.period)}</strong><br />
          {formatBytes(hovered.bytes)}{limitMb > 0 && <span className="muted"> · {hovered.percent}% of limit</span>}
          {limitBytes > 0 && hovered.bytes >= limitBytes && <><br /><span style={{ color: 'var(--bad)' }}>Over limit</span></>}
        </div>
      )}
    </div>
  );
}
