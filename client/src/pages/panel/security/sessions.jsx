import { useState } from 'react';
import { RefreshCw, LogOut, MonitorSmartphone } from 'lucide-react';
import { Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { api } from '../../../api/client.js';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi, minutesLeft } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isImpersonating } from './parts/shared.jsx';

export function remainingText(expiresAt, now = Date.now(), t = untranslated) {
  const m = minutesLeft(expiresAt, now);
  if (m == null) return '—';
  if (m === 0) return t('panel.security.session_expiring', 'expiring');
  if (m < 60) return fill(t('panel.security.left_min', '{count} min'), { count: m });
  if (m < 60 * 48) return fill(t('panel.security.left_hours', '{count} h'), { count: Math.round(m / 60) });
  return fill(t('panel.security.left_days', '{count} d'), { count: Math.round(m / 1440) });
}

export default function Sessions({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/sessions');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const actingAs = me?.actingAs;
  const rows = data || [];

  const endAll = async () => {
    const ok = await confirm({ title: t('panel.security.signout_title', 'Sign out everywhere else?'), message: fill(t('panel.security.signout_message', 'Every other browser signed in as {login} is signed out now; this one stays signed in.'), { login: me?.user?.username || me?.account?.username || t('panel.security.this_login', 'this login') }), confirmLabel: t('panel.security.signout_button', 'Sign out other sessions'), danger: true });
    if (!ok) return;
    setBusy(true); setActionError(null);
    try {
      const { data: res } = await panelApi.delete('/security/sessions');
      if (res?.csrfToken) api.setCsrfToken(res.csrfToken);
      toast.success(t('panel.security.signout_done', 'Other sessions signed out'));
      refetch();
    } catch (err) { setActionError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <ImpersonationNotice actingAs={actingAs} what={t('panel.security.sessions_what', 'Sessions')} />
      <div className="grid-2">
        <Card title={t('panel.security.this_signin_title', 'This sign-in')} subtitle={t('panel.security.this_signin_subtitle', 'The browser you are using now.')}>
          <KeyValue items={[
            [t('panel.security.col_login', 'Login'), <code key="u">{me?.user?.username || '—'}</code>],
            [t('panel.security.account', 'Account'), me?.account?.username],
            [t('panel.security.server', 'Server'), me?.hostname],
            [t('panel.security.two_factor', 'Two-factor'), me?.user?.totpEnabled ? <StatusPill key="t" status="enabled" /> : <StatusPill key="t" status="warning">{t('panel.security.not_enabled', 'not enabled')}</StatusPill>],
            actingAs && [t('panel.security.logged_in_as', 'Logged in as'), fill(t('panel.security.logged_in_as_value', '{account} by {by}, ends in {left}'), { account: actingAs.account, by: actingAs.by, left: remainingText(actingAs.expiresAt, Date.now(), t) })],
          ]} />
        </Card>
        <Card title={t('panel.security.signout_card_title', 'Sign out everywhere else')} subtitle={t('panel.security.signout_card_subtitle', 'Lost a laptop, or used a shared computer? End every other session of this login.')}>
          <PanelCapabilityState error={actionError} />
          <RequestError error={actionError} />
          <p className="muted">{t('panel.security.signout_help', 'Open browsers are signed out immediately and have to sign in again, with the second factor if it is enabled. API tokens are not affected; revoke them under API tokens.')}</p>
          <FormActions><Button variant="danger" icon={LogOut} loading={busy} disabled={busy || Boolean(actingAs)} onClick={endAll}>{t('panel.security.signout_button', 'Sign out other sessions')}</Button></FormActions>
        </Card>
      </div>

      <Card title={t('panel.security.sessions_title', 'Active sessions')} subtitle={rows.length ? plural(t, 'panel.security.sessions_count', rows.length, '{count} session signed in as this login', '{count} sessions signed in as this login') : undefined} padded={false}>
        {isCapabilityError(error) && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'id', label: t('panel.security.col_session', 'Session'), render: (r) => <code className="small">{r.id}</code> },
            { key: 'expiresAt', label: t('panel.security.col_expires', 'Expires'), render: (r) => formatDate(r.expiresAt) },
            { key: 'remaining', label: t('panel.security.col_time_left', 'Time left'), align: 'right', render: (r) => remainingText(r.expiresAt, Date.now(), t) },
            { key: 'status', label: t('panel.security.col_status', 'Status'), render: (r) => <StatusPill status={minutesLeft(r.expiresAt) === 0 ? 'warning' : 'active'}>{minutesLeft(r.expiresAt) === 0 ? t('panel.security.session_expiring', 'expiring') : t('panel.security.session_signed_in', 'signed in')}</StatusPill> },
          ]}
          rows={rows} loading={loading} error={isCapabilityError(error) || isImpersonating(error) ? null : error} rowKey={(r) => r.id} dense
          emptyText={actingAs || isImpersonating(error) ? t('panel.security.sessions_empty_acting', 'Sessions of the account user are listed when they sign in themselves; an administrator viewing the account never sees them.') : t('panel.security.sessions_empty', 'No sessions found. Your own sign-in appears here with the time it expires.')}
        />
      </Card>
      <p className="muted small"><MonitorSmartphone size={12} /> {t('panel.security.sessions_note', 'Sessions expire on their own after the time shown; signing out, changing the password or disabling two-factor authentication ends them earlier.')}</p>
    </PanelPage>
  );
}
