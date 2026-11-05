import { useMemo } from 'react';
import { encodeQr, qrPath } from '../lib/qr.js';

// An inline SVG QR code (lib/qr.js, no network, no canvas). `value` is the
// text to encode; a value the encoder cannot fit (> ~210 bytes) renders the
// fallback instead of throwing from the page.
export function QrCode({ value, size = 176, label = 'QR code', margin = 4, fallback = null }) {
  const code = useMemo(() => {
    if (!value) return null;
    try { return encodeQr(value, { level: 'M' }); } catch { return null; }
  }, [value]);
  if (!code) return fallback;
  const total = code.size + margin * 2;
  return (
    <svg className="qr-code" viewBox={`0 0 ${total} ${total}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label={label} data-version={code.version}>
      <rect width={total} height={total} fill="#fff" />
      <path d={qrPath(code.modules, margin)} fill="#000" />
    </svg>
  );
}
