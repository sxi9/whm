import { useState } from 'react';
import { RefreshCw, LogOut, MonitorSmartphone } from 'lucide-react';
import { Card, KeyValue, StatusPill, formatDate } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { api } from '../../../api/client.js';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi, minutesLeft } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isImpersonating } from './parts/shared.jsx';

export function remainingText(expiresAt, now = Date.now()) {
  const m = minutesLeft(expiresAt, now);
  if (m == null) return '—';
  if (m === 0) return 'expiring';
  if (m < 60) return `${m} min`;
  if (m < 60 * 48) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

export default function Sessions({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/sessions');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const actingAs = me?.actingAs;
  const rows = data || [];

  const endAll = async () => {
    const ok = await confirm({ title: 'Sign out everywhere else?', message: `Every other browser signed in as ${me?.user?.username || me?.account?.username || 'this login'} is signed out now; this one stays signed in.`, confirmLabel: 'Sign out other sessions', danger: true });
    if (!ok) return;
    setBusy(true); setActionError(null);
    try {
      const { data: res } = await panelApi.delete('/security/sessions');
      if (res?.csrfToken) api.setCsrfToken(res.csrfToken);
      toast.success('Other sessions signed out');
      refetch();
    } catch (err) { setActionError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <ImpersonationNotice actingAs={actingAs} what="Sessions" />
      <div className="grid-2">
        <Card title="This sign-in" subtitle="The browser you are using now.">
          <KeyValue items={[
            ['Login', <code key="u">{me?.user?.username || '—'}</code>],
            ['Account', me?.account?.username],
            ['Server', me?.hostname],
            ['Two-factor', me?.user?.totpEnabled ? <StatusPill key="t" status="enabled" /> : <StatusPill key="t" status="warning">not enabled</StatusPill>],
            actingAs && ['Logged in as', `${actingAs.account} by ${actingAs.by}, ends in ${remainingText(actingAs.expiresAt)}`],
          ]} />
        </Card>
        <Card title="Sign out everywhere else" subtitle="Lost a laptop, or used a shared computer? End every other session of this login.">
          <PanelCapabilityState error={actionError} />
          <RequestError error={actionError} />
          <p className="muted">Open browsers are signed out immediately and have to sign in again, with the second factor if it is enabled. API tokens are not affected; revoke them under API tokens.</p>
          <FormActions><Button variant="danger" icon={LogOut} loading={busy} disabled={busy || Boolean(actingAs)} onClick={endAll}>Sign out other sessions</Button></FormActions>
        </Card>
      </div>

      <Card title="Active sessions" subtitle={rows.length ? `${rows.length} session${rows.length === 1 ? '' : 's'} signed in as this login` : undefined} padded={false}>
        {isCapabilityError(error) && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'id', label: 'Session', render: (r) => <code className="small">{r.id}</code> },
            { key: 'expiresAt', label: 'Expires', render: (r) => formatDate(r.expiresAt) },
            { key: 'remaining', label: 'Time left', align: 'right', render: (r) => remainingText(r.expiresAt) },
            { key: 'status', label: 'Status', render: (r) => <StatusPill status={minutesLeft(r.expiresAt) === 0 ? 'warning' : 'active'}>{minutesLeft(r.expiresAt) === 0 ? 'expiring' : 'signed in'}</StatusPill> },
          ]}
          rows={rows} loading={loading} error={isCapabilityError(error) || isImpersonating(error) ? null : error} rowKey={(r) => r.id} dense
          emptyText={actingAs || isImpersonating(error) ? 'Sessions of the account user are listed when they sign in themselves; an administrator viewing the account never sees them.' : 'No sessions found. Your own sign-in appears here with the time it expires.'}
        />
      </Card>
      <p className="muted small"><MonitorSmartphone size={12} /> Sessions expire on their own after the time shown; signing out, changing the password or disabling two-factor authentication ends them earlier.</p>
    </PanelPage>
  );
}
