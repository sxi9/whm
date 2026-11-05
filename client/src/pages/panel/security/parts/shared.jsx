import { AlertTriangle, UserX, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ErrorBanner } from '../../../../components/Form.jsx';
import { useT } from '../../../../i18n/useT.js';
import { fill } from '../../../../i18n/fill.js';
import { PANEL_PATHS } from '../../../../panel/nav.js';

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}

export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

export function isImpersonating(error) {
  return Boolean(error) && error.code === 'not_while_impersonating';
}

// Security settings belong to the person who owns the account: while an
// administrator is logged in as the account every write answers 403
// not_while_impersonating, and the page says so before they try.
export function ImpersonationNotice({ actingAs, what }) {
  const { t } = useT();
  if (!actingAs) return null;
  return (
    <div className="banner banner-info" role="status">
      <UserX size={18} />
      <div>
        <strong>{fill(t('panel.security.readonly_title', 'Read-only while logged in as {account}'), { account: actingAs.account })}</strong>
        <p>{fill(t('panel.security.readonly_text', '{what} can only be changed by the account user. Everything here is shown for reference.'), { what: what ?? t('panel.security.readonly_what', 'Security settings') })}</p>
      </div>
    </div>
  );
}

export function RequestError({ error, onRetry }) {
  const { t } = useT();
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (isImpersonating(error)) {
    return <div className="banner banner-warning" role="alert"><UserX size={18} /><div><strong>{t('panel.security.impersonating_title', 'Not available while logged in as the account')}</strong><p>{error.message}</p></div></div>;
  }
  if (error.code === 'two_factor_required') {
    return <div className="banner banner-warning" role="alert"><ShieldAlert size={18} /><div><strong>{t('panel.security.tfa_needed_title', 'Two-factor authentication needed first')}</strong><p>{error.message}</p><p className="muted"><Link to={PANEL_PATHS.twoFactor}>{t('panel.security.tfa_set_up', 'Set up two-factor authentication')}</Link>{t('panel.security.tfa_then_return', ', then come back here.')}</p></div></div>;
  }
  if (error.code === 'session_required') {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>{t('panel.security.session_required_title', 'Sign in to the panel for this')}</strong><p>{error.message}</p></div></div>;
  }
  if (error.code === 'limit_reached' || (error.status === 409 && /at most/i.test(error.message || ''))) {
    return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>{t('panel.security.limit_title', 'Limit reached')}</strong><p>{error.message}</p><p className="muted">{t('panel.security.limit_help', 'Remove one you no longer use.')}</p></div></div>;
  }
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

export function Digits({ value, onChange, id, autoFocus, disabled }) {
  return <input id={id} className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={value ?? ''} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus={autoFocus} disabled={disabled} placeholder="123456" />;
}

export const KEY_TYPE_LABELS = { 'ssh-ed25519': 'Ed25519', 'ssh-rsa': 'RSA', 'ssh-dss': 'DSA', 'ecdsa-sha2-nistp256': 'ECDSA P-256', 'ecdsa-sha2-nistp384': 'ECDSA P-384', 'ecdsa-sha2-nistp521': 'ECDSA P-521', 'sk-ssh-ed25519@openssh.com': 'Ed25519 (security key)', 'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA (security key)' };
export const keyTypeLabel = (type) => KEY_TYPE_LABELS[type] || type || '—';

export const SSH_KEY_LINE = /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{1,16384}( [^\n\r]{0,255})?$/;

// Panel token scopes (server routes/panel/index.js PANEL_SCOPES), with what each allows.
export const TOKEN_SCOPES = [
  ['panel:read', 'Read everything', 'Lists and status on every screen; cannot change anything'],
  ['panel:files', 'Files', 'Upload, edit and delete files'],
  ['panel:email', 'Email', 'Mailboxes, forwarders, autoresponders, filters'],
  ['panel:dns', 'DNS', 'Zone records'],
  ['panel:databases', 'Databases', 'Databases, users and remote hosts'],
  ['panel:backups', 'Backups', 'Generate, download, upload and restore backups'],
  ['panel:cron', 'Cron', 'Scheduled commands'],
];

// Catalogue keys for a scope: panel.security.scope.<name> / panel.security.scope.<name>_help.
export const scopeKey = (scope) => `panel.security.scope.${scope.replace(/^panel:/, '')}`;

export function scopeLabel(scope, t) {
  const row = TOKEN_SCOPES.find(([s]) => s === scope);
  if (!row) return scope;
  return t ? t(scopeKey(scope), row[1]) : row[1];
}

export function expiryState(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'never';
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return 'unknown';
  return t <= now ? 'expired' : 'active';
}

export function toIsoOrNull(local) {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
