import { Link } from 'react-router-dom';
import { PowerOff, UserX, ShieldAlert } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useBranding } from '../pages/cpanel/branding.js';
import { BrandMark } from '../components/Brand.jsx';
import { EmptyState } from '../components/Common.jsx';
import { useT } from '../i18n/useT.js';

// Full-page states that replace the shell: panel.enabled=false (403 panel_disabled),
// a login with no linked account (403 no_account), an admin without "Log in as"
// (403 panel_scope_required) and anything else the /me call refuses.
export function PanelDisabledPage({ error, onRetry }) {
  const { user, logout } = useAuth();
  const branding = useBranding();
  const { t } = useT();
  const code = error?.code || 'panel_disabled';
  const admin = user && user.role !== 'user';
  const copy = {
    panel_disabled: { icon: PowerOff, title: t('panel.shell.disabled_title', 'The account panel is switched off'), text: t('panel.shell.disabled_text', 'Your hosting provider has disabled the account panel on this server. Sign in again later or contact them for help.') },
    no_account: { icon: UserX, title: t('panel.shell.no_account_title', 'No hosting account is linked to this login'), text: t('panel.shell.no_account_text', 'Ask your hosting provider to link this login to an account.') },
    panel_scope_required: { icon: ShieldAlert, title: t('panel.shell.scope_required_title', 'Choose an account to view'), text: t('panel.shell.scope_required_text', 'Administrators open the account panel through "Log in as" on an account in the console.') },
    login_as_ended: { icon: ShieldAlert, title: t('panel.shell.login_as_ended_title', 'The "Log in as" session has ended'), text: t('panel.shell.login_as_ended_text', 'Start it again from the console to keep viewing this account.') },
  }[code] || { icon: ShieldAlert, title: t('panel.shell.unavailable_title', 'The account panel is not available right now'), text: error?.message || '' };
  const Icon = copy.icon;
  return (
    <div className="login-page panel-disabled" data-code={code}>
      <div className="login-card">
        <div className="login-brand"><BrandMark size={56} /><span>{branding.companyName} · {branding.tagline}</span></div>
        <EmptyState icon={Icon} title={copy.title}>
          <p>{copy.text}</p>
          <p className="row-actions" style={{ justifyContent: 'center', gap: 8 }}>
            {admin && <Link className="btn btn-primary" to="/">{t('panel.shell.back_to_console', 'Back to the console')}</Link>}
            {onRetry && <button className="btn" onClick={onRetry}>{t('common.retry', 'Retry')}</button>}
            {user && <button className="btn btn-ghost" onClick={() => logout().then(() => { window.location.assign('/login'); })}>{t('panel.shell.sign_out', 'Sign out')}</button>}
          </p>
        </EmptyState>
      </div>
    </div>
  );
}
