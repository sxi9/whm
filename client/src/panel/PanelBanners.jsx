import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, Ban, KeyRound, Info } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import { PANEL_PATHS } from './nav.js';
import { panelApi, scopeBanners, usePanelMe } from './hooks/usePanel.js';

function fill(text, vars) {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v ?? '')), text);
}

// "Viewing acct as admin · ends in 42 min · Exit" (design §2.4) plus the account
// state notices. Exit ends the impersonation server-side, then returns the admin
// to the console (or closes the tab "Log in as" opened).
export function ActingAsBanner({ banner }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const exit = async () => {
    setBusy(true);
    try { await panelApi.post('/admin/logout-as', {}); } catch { /* the acting context is gone either way */ }
    if (window.opener && !window.opener.closed) window.close();
    navigate('/', { replace: true });
  };
  const text = fill(t('panel.shell.acting_as', 'Viewing {account} as {by}'), { account: banner.account, by: banner.by });
  const left = banner.minutesLeft == null ? null : fill(t('panel.shell.acting_ends_in', 'ends in {minutes} min'), { minutes: banner.minutesLeft });
  return (
    <div className="banner banner-info panel-acting-banner" role="status">
      <Eye size={18} />
      <div><strong>{text}</strong>{left && <span className="muted"> · {left}</span>}</div>
      <button className="btn btn-sm" onClick={exit} disabled={busy} style={{ marginLeft: 'auto' }}>{t('panel.shell.acting_exit', 'Exit')}</button>
    </div>
  );
}

export function PanelBanners() {
  const { me } = usePanelMe();
  const { t } = useT();
  const banners = scopeBanners(me);
  if (!banners.length) return null;
  return (
    <div className="panel-banners">
      {banners.map((b) => {
        if (b.kind === 'acting') return <ActingAsBanner key={b.kind} banner={b} />;
        if (b.kind === 'suspended') return <div key={b.kind} className="banner banner-error" role="alert"><Ban size={18} /><div><strong>{t('panel.shell.suspended_title', 'This account is suspended')}</strong><p>{t('panel.shell.suspended_text', 'Changes are refused until your hosting provider lifts the suspension.')}</p></div></div>;
        if (b.kind === 'force-password') {
          return (
            <div key={b.kind} className="banner banner-warning" role="alert"><KeyRound size={18} /><div><strong>{t('panel.shell.force_password_title', 'A new password is required')}</strong>
              {b.actionable
                ? <p>{t('panel.shell.force_password_text', 'Choose a new password before using the rest of the panel.')} <Link to={PANEL_PATHS.password}>{t('panel.shell.change_password', 'Change password')}</Link></p>
                : <p>{t('panel.shell.force_password_acting_text', 'The account owner must choose a new password at their next login; passwords cannot be changed while logged in as the account.')}</p>}
            </div></div>
          );
        }
        if (b.kind === 'demo') return <div key={b.kind} className="banner banner-warning" role="status"><Info size={18} /><div><strong>{t('panel.shell.demo_title', 'Demo mode')}</strong><p>{t('panel.shell.demo_text', 'This account is read-only: every change is refused.')}</p></div></div>;
        return null;
      })}
    </div>
  );
}
