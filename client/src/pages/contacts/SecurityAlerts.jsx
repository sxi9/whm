import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Megaphone, RefreshCw, Play } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, EmptyState, formatDate } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, Textarea, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { BRAND } from '../../brand.js';

export const SEVERITY_STATUS = { info: 'info', warning: 'warning', error: 'failed', critical: 'failed' };
export const STATE_STATUS = { pending: 'pending', held: 'pending', sent: 'ok', skipped: 'disabled', failed: 'failed' };
export const SEVERITY_OPTIONS = [
  { value: 'info', label: 'Info and above (everything)' },
  { value: 'warning', label: 'Warning and above (security updates pending, critical findings)' },
  { value: 'error', label: 'Error and above' },
  { value: 'critical', label: 'Critical only (critical findings, emergency updates, security releases)' },
];

// One line per alert: who was told and how it went.
export function deliveryLabel(alert) {
  if (!alert) return '';
  switch (alert.state) {
    case 'skipped': return 'not sent: below the minimum severity';
    case 'pending': return alert.admin?.skipped === 'no_recipients' ? 'waiting: no administrator can receive it yet (add a contact or route root mail)' : 'queued for delivery';
    case 'held': return 'held for the next digest';
    case 'failed': return `administrators: failed${alert.admin?.error ? ` (${alert.admin.error})` : ''}`;
    default: break;
  }
  const parts = [];
  const admin = alert.admin || {};
  parts.push(admin.skipped ? `administrators: skipped (${admin.skipped})` : `administrators: ${admin.sent ?? 0} of ${admin.matched ?? 0} contact${admin.matched === 1 ? '' : 's'} sent${admin.failed ? `, ${admin.failed} failed` : ''}`);
  const acc = alert.accounts;
  if (!acc) parts.push('accounts: —');
  else if (acc.skipped === 'notify_accounts_off') parts.push('accounts: off');
  else if (acc.skipped === 'admins_only') parts.push('accounts: administrators only');
  else if (acc.skippedReason === 'no_mail_transport') parts.push('accounts: no mail transport');
  else parts.push(`accounts: ${acc.sent ?? 0} mail${acc.sent === 1 ? '' : 's'} sent${acc.failed ? `, ${acc.failed} failed` : ''}`);
  return parts.join(' · ');
}

export function AlertRows({ alerts, dense = true }) {
  return (
    <DataTable dense={dense} rows={alerts} emptyText="No security alert has been raised yet." columns={[
      { key: 'createdAt', label: 'When', render: (a) => formatDate(a.createdAt) },
      { key: 'severity', label: 'Severity', render: (a) => <StatusPill status={SEVERITY_STATUS[a.severity]}>{a.severity}</StatusPill> },
      { key: 'title', label: 'Alert', render: (a) => <><div>{a.title}</div><small className="muted">{a.kindLabel}{a.source ? ` · ${a.source}` : ''}</small></> },
      { key: 'state', label: 'Delivery', render: (a) => <><StatusPill status={STATE_STATUS[a.state] || 'unknown'}>{a.state}</StatusPill> <small className="muted">{deliveryLabel(a)}</small></> },
    ]} />
  );
}

// The compact list the Security Advisor shows under its findings.
export function AlertsPanel({ limit = 8 }) {
  const { data, loading, error, refetch } = useApi(`/server-contacts/security-alerts/alerts?limit=${limit}`);
  return (
    <Card title="Alerts" subtitle="What this server has told administrators and hosting accounts about: critical findings, pending and applied security updates, panel security releases." padded={false}
      actions={<><Link className="btn btn-sm" to="/server-contacts/contact-manager">Security notifications</Link><Button size="sm" icon={RefreshCw} onClick={() => refetch()}>Refresh</Button></>}>
      {error && <div style={{ padding: 14 }}><ErrorBanner error={error} onRetry={refetch} /></div>}
      {loading && !data && <Loading />}
      {data && (data.length ? <AlertRows alerts={data} /> : <EmptyState title="No security alerts yet">Critical findings of a scan, security updates found or applied by the panel and security releases of the panel itself show up here with their delivery state.</EmptyState>)}
    </Card>
  );
}

// Contact Manager card: the settings, a test, an administrator notice and the
// last alerts raised.
export function SecurityAlertsCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const overview = useApi('/server-contacts/security-alerts');
  const data = overview.data;
  const initial = () => ({ enabled: Boolean(data?.settings.enabled), notifyAccounts: Boolean(data?.settings.notifyAccounts), minSeverity: data?.settings.minSeverity || 'critical', digestMinutes: data?.settings.digestMinutes ?? 60 });
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => { setDraft(initial()); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  if (overview.loading && !data) return <Card title="Security notifications"><Loading /></Card>;
  if (overview.error) return <Card title="Security notifications"><ErrorBanner error={overview.error} onRetry={overview.refetch} /></Card>;

  const { settings, capability, stats, digest } = data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.put('/server-contacts/security-alerts/settings', draft);
      toast.success('Security notification settings saved');
      overview.refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  const followJob = async (id) => {
    for (;;) {
      const job = (await api.get(`/system/jobs/${id}`)).data;
      if (!['queued', 'running'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 800));
    }
  };

  const sendTest = async (includeAccounts) => {
    if (includeAccounts && !(await confirm({ title: 'Mail every hosting account?', message: `A test notice goes to the contact address of ${capability.accountRecipients} hosting account${capability.accountRecipients === 1 ? '' : 's'} as well as to the administrators. Use this once, to check what customers will receive.`, confirmLabel: 'Send the test to everyone', danger: true }))) return;
    setBusy('test');
    try {
      const res = await api.post('/server-contacts/security-alerts/test', { includeAccounts: Boolean(includeAccounts) });
      const job = await followJob(res.data.job.id);
      if (job.status !== 'done') throw new Error(job.error || `The test ${job.status}`);
      const r = job.result;
      toast[r.admins?.failed || r.accounts?.failed ? 'warning' : 'success'](`Test alert delivered: administrators ${r.admins?.sent ?? 0} sent${r.admins?.failed ? `, ${r.admins.failed} failed` : ''}${r.accounts ? `; accounts ${r.accounts.sent ?? 0} sent${r.accounts.failed ? `, ${r.accounts.failed} failed` : ''}${r.accounts.skippedReason ? ` (${r.accounts.skippedReason.replace(/_/g, ' ')})` : ''}` : ''}`, { timeout: 10_000 });
    } catch (err) { toast.error(err, { timeout: 10_000 }); } finally { setBusy(null); overview.refetch(); }
  };

  const deliverNow = async () => {
    setBusy('deliver');
    try {
      const res = await api.post('/server-contacts/security-alerts/deliver');
      const job = await followJob(res.data.job.id);
      if (job.status !== 'done') throw new Error(job.error || `Delivery ${job.status}`);
      toast.success(`${job.result.delivered} pending alert${job.result.delivered === 1 ? '' : 's'} delivered`);
    } catch (err) { toast.error(err); } finally { setBusy(null); overview.refetch(); }
  };

  const sendNotice = async () => {
    const toAccounts = Boolean(notice.notifyAccounts);
    if (!(await confirm({ title: toAccounts ? `Send this notice to ${capability.accountRecipients} hosting account${capability.accountRecipients === 1 ? '' : 's'}?` : 'Send this notice to the administrators?', message: `"${notice.title}" is mailed ${toAccounts ? 'to the contact address of every active hosting account and ' : ''}to every contact subscribed to security.alert. It cannot be recalled.`, confirmLabel: 'Send', danger: toAccounts }))) return;
    setBusy('notice');
    try {
      const res = await api.post('/server-contacts/security-alerts/raise', { title: notice.title.trim(), body: notice.body.trim(), severity: notice.severity, notifyAccounts: toAccounts });
      const job = await followJob(res.data.job.id);
      if (job.status !== 'done') throw new Error(job.error || `Delivery ${job.status}`);
      toast.success(`Notice sent: administrators ${job.result.admins?.sent ?? 0}${job.result.accounts ? `, accounts ${job.result.accounts.sent ?? 0}` : ''}`);
      setNotice(null);
    } catch (err) { toast.error(err, { timeout: 10_000 }); } finally { setBusy(null); overview.refetch(); }
  };

  const transportLabel = capability.mailTransport === 'exim' ? 'Exim on this server' : capability.mailTransport === 'smtp' ? 'the SMTP relay' : null;
  return (
    <Card title="Security notifications" subtitle={`Critical Security Advisor findings, security updates found or applied, PHP advisories and panel security releases are raised as alerts. Administrators receive them as the contacts event security.alert; hosting accounts can be mailed an "emergency update applied" notice at their contact address, signed ${BRAND.product}.`}
      actions={<StatusPill status={settings.enabled ? 'enabled' : 'disabled'}>{settings.enabled ? 'Enabled' : 'Disabled'}</StatusPill>}>
      {settings.enabled && capability.contactsSubscribed === 0 && !capability.rootMail && (
        <div className="banner banner-warning"><div><strong>No administrator receives security alerts yet</strong><p style={{ margin: '4px 0 0' }}>Add a contact above subscribed to <code>security.alert</code> (or to all events), or select the event under Edit System Mail Preferences so root is mailed. Alerts raised meanwhile wait and go out as soon as somebody can receive them.</p></div></div>
      )}
      {draft.notifyAccounts && !transportLabel && (
        <div className="banner banner-warning"><div><strong>Hosting accounts cannot be mailed yet</strong><p style={{ margin: '4px 0 0' }}>Install Exim or configure an SMTP relay in the notification settings; alerts for accounts are recorded as skipped until then.</p></div></div>
      )}
      <KeyValue items={[
        ['Administrators', `${capability.contactsSubscribed} contact${capability.contactsSubscribed === 1 ? '' : 's'} subscribed${capability.rootMail ? ' + root mail' : ''}`],
        ['Hosting accounts', `${capability.accountRecipients} active account${capability.accountRecipients === 1 ? '' : 's'} with a contact address${transportLabel ? ` via ${transportLabel}` : ' (no mail transport)'}`],
        ['Alerts', `${stats.total} total, ${stats.last24h} in the last 24 h${stats.pending ? `, ${stats.pending} waiting` : ''}`],
        ['Last delivery', settings.lastDeliveryAt ? `${formatDate(settings.lastDeliveryAt)}${!digest.due ? ` · digest window open for ${Math.ceil(digest.windowRemainingMs / 60_000)} min` : ''}` : 'never'],
      ]} />
      <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Raise security alerts" description="When off nothing is recorded or sent." /></Field>
      <Field inline><Toggle checked={draft.notifyAccounts} onChange={(v) => set('notifyAccounts', v)} label="Mail hosting accounts about emergency updates" description="Every active account's contact address gets the account-facing notice (never finding details) once per alert, in chunks." /></Field>
      <div className="form-grid">
        <Field label="Minimum severity" help="Alerts below this are recorded but not delivered."><Select value={draft.minSeverity} onChange={(v) => set('minSeverity', v)} options={SEVERITY_OPTIONS} /></Field>
        <Field label="Digest window (minutes)" help="After a delivery, alerts raised within this window are held and sent together. 0 sends each alert at once."><NumberInput value={draft.digestMinutes} onChange={(v) => set('digestMinutes', v ?? 0)} min={0} max={1440} nullable={false} /></Field>
      </div>
      <ErrorBanner error={error} />
      <FormActions>
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => setDraft(initial())}>Reset</Button>
        <Button icon={Send} loading={busy === 'test'} disabled={!settings.enabled || dirty || busy} onClick={() => sendTest(false)} title={dirty ? 'Save the settings first' : undefined}>Send a test alert</Button>
        <Button loading={busy === 'test'} disabled={!settings.enabled || dirty || busy || !capability.accountRecipients || !transportLabel} onClick={() => sendTest(true)}>Test with accounts too</Button>
        {stats.pending > 0 && <Button icon={Play} loading={busy === 'deliver'} disabled={!settings.enabled || busy} onClick={deliverNow}>Deliver {stats.pending} waiting now</Button>}
        <Button icon={Megaphone} disabled={!settings.enabled || busy} onClick={() => setNotice(notice ? null : { title: '', body: '', severity: 'critical', notifyAccounts: settings.notifyAccounts })}>{notice ? 'Cancel notice' : 'Send a notice'}</Button>
      </FormActions>
      {notice && (
        <div className="banner banner-info" style={{ display: 'block', marginTop: 12 }}>
          <strong>Notice to administrators{notice.notifyAccounts ? ' and every hosting account' : ''}</strong>
          <p className="muted" style={{ margin: '4px 0 10px' }}>Tell people what was done, for example "an emergency update was pushed tonight". Accounts receive your text as written, with the {BRAND.product} header and a link to the panel; never include passwords or details that help an attacker.</p>
          <Field label="Subject"><TextInput value={notice.title} onChange={(v) => setNotice((n) => ({ ...n, title: v }))} placeholder="Emergency security update applied" maxLength={200} /></Field>
          <Field label="Message"><Textarea rows={5} value={notice.body} onChange={(v) => setNotice((n) => ({ ...n, body: v }))} placeholder="We applied an emergency security update to this server tonight. Your sites and mail keep working; nothing is required from you." /></Field>
          <div className="form-grid">
            <Field label="Severity"><Select value={notice.severity} onChange={(v) => setNotice((n) => ({ ...n, severity: v }))} options={['info', 'warning', 'error', 'critical'].map((s) => ({ value: s, label: s }))} /></Field>
            <Field inline><Toggle checked={Boolean(notice.notifyAccounts)} onChange={(v) => setNotice((n) => ({ ...n, notifyAccounts: v }))} label={`Mail the ${capability.accountRecipients} hosting account${capability.accountRecipients === 1 ? '' : 's'} too`} disabled={!transportLabel} /></Field>
          </div>
          <FormActions>
            <Button variant="primary" icon={Megaphone} loading={busy === 'notice'} disabled={!notice.title.trim() || !notice.body.trim() || busy} onClick={sendNotice}>Send notice</Button>
          </FormActions>
        </div>
      )}
      <h3 style={{ margin: '16px 0 6px', fontSize: 14 }}>Last alerts</h3>
      <div className="table-wrap">
        <AlertRows alerts={data.alerts || []} />
      </div>
    </Card>
  );
}
