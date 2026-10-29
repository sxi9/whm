import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '../lib/qr.js';

// Inline SVG QR code for an authenticator enrolment URI. Rendered locally:
// the otpauth secret never leaves the page as an image request.
export function QrCode({ value, size = 184, label = 'QR code', quiet = 4 }) {
  const symbol = useMemo(() => {
    try { return encodeQr(value); } catch { return null; }
  }, [value]);
  if (!symbol) return null;
  const extent = symbol.size + quiet * 2;
  return (
    <svg className="qr-code" width={size} height={size} viewBox={`0 0 ${extent} ${extent}`} role="img" aria-label={label} shapeRendering="crispEdges" data-qr-version={symbol.version}>
      <rect width={extent} height={extent} fill="#fff" />
      <path d={qrSvgPath(symbol.modules, quiet)} fill="#000" />
    </svg>
  );
}

// The enrolment block every portal shares: QR + secret + URI.
export function TotpEnrolment({ secret, uri, account }) {
  return (
    <div className="totp-enrolment" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <QrCode value={uri} label={`Authenticator QR code for ${account || 'this account'}`} />
      <div style={{ flex: 1, minWidth: 220 }}>
        <p style={{ marginTop: 0 }}>Scan the code with an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator…) or type the secret by hand, then confirm with the current 6-digit code.</p>
        <pre className="code-block">{secret}</pre>
        <p className="muted small" style={{ wordBreak: 'break-all' }}><code className="small">{uri}</code></p>
      </div>
    </div>
  );
}
