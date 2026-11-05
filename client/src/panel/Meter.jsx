import { useT } from '../i18n/useT.js';
import { fill } from '../i18n/fill.js';
import { meterTone } from './hooks/usePanel.js';

// The usage bar every panel meter renders (home tiles, Usage, mailbox quotas):
// a progressbar for assistive technology with the percentage as its value and
// the human text ("512 MB of 1.00 GB") as its value text. A bar without a
// percentage (unlimited, or the object is not in the plan) stays decorative.
export function Meter({ percent, label, text, name, tone, style }) {
  const { t } = useT();
  const known = percent != null && Number.isFinite(percent);
  const a11y = known
    ? { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.max(0, Math.min(100, Math.round(percent))), 'aria-valuetext': text || undefined, 'aria-label': label ? (text ? fill(t('panel.shell.meter_value', '{label}: {text}'), { label, text }) : label) : undefined }
    : { role: 'progressbar', 'aria-hidden': true };
  return (
    <div className={`meter ${tone ?? meterTone(known ? percent : null)}`} data-meter={name} style={style} {...a11y}>
      <span style={{ width: `${known ? Math.max(0, Math.min(100, percent)) : 0}%` }} />
    </div>
  );
}

// https when a certificate is installed and still valid on the domain, http otherwise.
// `ssl` is the per-domain shape of GET /api/panel/domains (`rows[].ssl`).
export function sslLive(ssl) {
  if (!ssl || !ssl.installed || ssl.state === 'stored' || ssl.expired) return false;
  return ssl.daysRemaining == null || ssl.daysRemaining > 0;
}

export function siteUrl(domain, ssl) {
  return `${sslLive(ssl) ? 'https' : 'http'}://${domain}`;
}
