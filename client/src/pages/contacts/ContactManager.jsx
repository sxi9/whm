import { useEffect, useState } from 'react';
import { Plus, Send, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import { api, queryString } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, StatusPill, Loading, KeyValue, CapabilityNotice, formatDate } from '../../components/Common.jsx';
import { DataTable, useTableState } from '../../components/DataTable.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { ProgressLog } from '../../components/ProgressLog.jsx';
import { ContactForm, CHANNEL_LABEL } from './ContactForm.jsx';
import { SecurityAlertsCard } from './SecurityAlerts.jsx';
import { BRAND } from '../../brand.js';

const SEVERITY_STATUS = { info: 'info', warning: 'warning', error: 'failed', critical: 'failed' };

export function ContactManager() {
  const toast = useToast();
  const confirm = useConfirm();
  const overview = useApi('/server-contacts');
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [testing, setTesting] = useState(null);
  const [logVersion, setLogVersion] = useState(0);
  const data = overview.data;

  const refreshAll = () => { overview.refetch(); setLogVersion((v) => v + 1); };

  const save = async (body) => {
    setSaving(true);
    setFormError(null);
    try {
      if (editing?.id) { await api.patch(`/server-contacts/contacts/${editing.id}`, body); toast.success('Contact updated'); } else { await api.post('/server-contacts/contacts', body); toast.success('Contact added'); }
      setEditing(null);
      overview.refetch();
    } catch (err) { setFormError(err); } finally { setSaving(false); }
  };

  const toggle = async (c) => {
    try { await api.patch(`/server-contacts/contacts/${c.id}`, { enabled: !c.enabled }); toast.success(`${c.name} ${c.enabled ? 'disabled' : 'enabled'}`); overview.refetch(); } catch (err) { toast.error(err); }
  };

  const remove = async (c) => {
    if (!(await confirm({ title: `Remove ${c.name}?`, message: `The ${CHANNEL_LABEL[c.channel] || c.channel} contact ${c.address} stops receiving notifications. Its delivery history is kept.`, confirmLabel: 'Remove', danger: true }))) return;
    try { await api.delete(`/server-contacts/contacts/${c.id}`); toast.success('Contact removed'); refreshAll(); } catch (err) { toast.error(err); }
  };

  const test = async (c) => {
    setTesting(c.id);
    try {
      const res = await api.post(`/server-contacts/contacts/${c.id}/test`);
      toast.success(`Test sent to ${c.address}${res.data.transport ? ` via ${res.data.transport}` : ''}`);
    } catch (err) { toast.error(err.status === 501 ? `${err.message}` : `Test failed: ${err.message}`, { timeout: 10_000 }); } finally { setTesting(null); refreshAll(); }
  };

  if (overview.loading && !data) return <Loading />;
  if (overview.error) return <ErrorBanner error={overview.error} onRetry={overview.refetch} />;

  const { capability, settings } = data;

  return (
    <>
      {!capability.mailTransport && (
        <CapabilityNotice capability="exim" error={{ code: 'capability_missing', message: 'Exim is not installed and no SMTP relay is configured, so email and SMS contacts cannot be reached yet. Slack, Pushover and webhook contacts work regardless. Install Exim, or enter an SMTP relay below.' }} onRetry={() => api.post('/system/capabilities/refresh').then(refreshAll).catch(toast.error)} />
      )}
      <Card title="Contacts" subtitle="Each contact picks the events it receives and a minimum severity. Other parts of the panel (backups, monitoring, security) raise these events." padded={false}
        actions={<Button variant="primary" icon={Plus} size="sm" onClick={() => { setFormError(null); setEditing({}); }}>Add contact</Button>}>
        <DataTable dense rows={data.contacts} emptyText="No contacts yet. Add one so the server can tell someone when something goes wrong."
          columns={[
            { key: 'name', label: 'Name', render: (c) => <><strong>{c.name}</strong>{!c.enabled && <> <StatusPill status="disabled">disabled</StatusPill></>}</> },
            { key: 'channel', label: 'Channel', render: (c) => CHANNEL_LABEL[c.channel]?.split(' (')[0] || c.channel },
            { key: 'address', label: 'Address', render: (c) => <code style={{ wordBreak: 'break-all' }}>{c.channel === 'pushover' ? `${c.address.slice(0, 6)}…` : c.address}</code> },
            { key: 'events', label: 'Events', render: (c) => (c.allEvents ? 'All events' : `${c.events.length} selected`) },
            { key: 'minSeverity', label: 'Min. severity', render: (c) => <StatusPill status={SEVERITY_STATUS[c.minSeverity]}>{c.minSeverity}</StatusPill> },
            { key: 'lastSentAt', label: 'Last sent', render: (c) => (c.lastError ? <span title={c.lastError}><StatusPill status="failed">failed</StatusPill> <small className="muted">{c.lastError.slice(0, 60)}</small></span> : formatDate(c.lastSentAt)) },
          ]}
          rowActions={(c) => [
            { label: testing === c.id ? 'Sending…' : 'Test', primary: true, disabled: testing != null, onClick: () => test(c) },
            { label: 'Edit', onClick: () => { setFormError(null); setEditing(c); } },
            { label: c.enabled ? 'Disable' : 'Enable', onClick: () => toggle(c) },
            { label: 'Remove', danger: true, onClick: () => remove(c) },
          ]}
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, alignItems: 'start' }}>
        <NotificationSettings settings={settings} capability={capability} smtpSecurity={data.smtpSecurity} onSaved={refreshAll} />
        <ChecksCard settings={settings} schedule={data.schedule} openAlerts={data.openAlerts} onChanged={refreshAll} />
      </div>

      <SecurityAlertsCard key={logVersion} />
      <EventCatalog events={data.events} />
      <DeliveryLog version={logVersion} events={data.events} />

      <Modal open={Boolean(editing)} title={editing?.id ? `Edit ${editing.name}` : 'Add a contact'} onClose={() => setEditing(null)} size="lg">
        {editing && <ContactForm key={editing.id || 'new'} initial={editing.id ? editing : undefined} events={data.events} channels={data.channels} severities={data.severities} saving={saving} error={formError} onSubmit={save} onCancel={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

function NotificationSettings({ settings, capability, smtpSecurity, onSaved }) {
  const toast = useToast();
  const initial = () => ({ enabled: settings.enabled, fromAddress: settings.fromAddress, retentionDays: settings.retentionDays, webhook: { allowPrivate: Boolean(settings.webhook?.allowPrivate) }, smtp: { host: settings.smtp.host, port: settings.smtp.port, security: settings.smtp.security, username: settings.smtp.username, password: '', allowSelfSigned: settings.smtp.allowSelfSigned, prefer: settings.smtp.prefer, allowPlaintextAuth: Boolean(settings.smtp.allowPlaintextAuth) } });
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  useEffect(() => { setDraft(initial()); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setSmtp = (k, v) => setDraft((d) => ({ ...d, smtp: { ...d.smtp, [k]: v } }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial());
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|::1)$/i.test(draft.smtp.host.trim());
  const plaintextAuth = Boolean(draft.smtp.username) && draft.smtp.security === 'none' && Boolean(draft.smtp.host) && !loopback;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const smtp = { ...draft.smtp };
      if (!smtp.password) delete smtp.password;
      await api.put('/server-contacts/settings', { enabled: draft.enabled, fromAddress: draft.fromAddress, retentionDays: draft.retentionDays, smtp, webhook: draft.webhook });
      toast.success('Notification settings saved');
      onSaved?.();
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.post('/server-contacts/settings/test-mail', { to: testTo.trim() });
      toast.success(`Test message handed to ${res.data.transport === 'smtp' ? 'the SMTP relay' : 'Exim'} for ${testTo.trim()}`);
    } catch (err) { toast.error(err, { timeout: 10_000 }); } finally { setTesting(false); }
  };

  return (
    <Card title="Notification settings" subtitle={`Email leaves through ${capability.mailTransport === 'exim' ? 'Exim on this server' : capability.mailTransport === 'smtp' ? `the SMTP relay ${settings.smtp.host}` : 'nothing yet: install Exim or configure a relay'}.`}>
      <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Send notifications" description="When off, events are still raised but nothing is delivered." /></Field>
      <Field label="From address" help={`Blank uses ${settings.effectiveFrom || 'whm@<hostname>'} (mail.notification_from or whm@hostname).`} error={error?.fields?.fromAddress}><TextInput value={draft.fromAddress} onChange={(v) => set('fromAddress', v)} placeholder={settings.effectiveFrom || 'whm@host.example.com'} /></Field>
      <Field label="Keep the delivery log for (days)"><NumberInput value={draft.retentionDays} onChange={(v) => set('retentionDays', v ?? 1)} min={1} max={3650} nullable={false} /></Field>
      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>SMTP relay</h3>
      <p className="muted" style={{ marginTop: 0 }}>Used when Exim is not installed, or always when "prefer the relay" is on. Leave the host blank to disable.</p>
      <div className="form-grid">
        <Field label="Host" error={error?.fields?.['smtp.host']}><TextInput value={draft.smtp.host} onChange={(v) => setSmtp('host', v)} placeholder="smtp.example.net" /></Field>
        <Field label="Port"><NumberInput value={draft.smtp.port} onChange={(v) => setSmtp('port', v ?? 587)} min={1} max={65535} nullable={false} /></Field>
        <Field label="Security"><Select value={draft.smtp.security} onChange={(v) => setSmtp('security', v)} options={smtpSecurity.map((s) => ({ value: s, label: { none: 'None (plain, port 25)', starttls: 'STARTTLS (port 587)', tls: 'Implicit TLS (port 465)' }[s] || s }))} /></Field>
        <Field label="Username" help="Blank for an unauthenticated relay."><TextInput value={draft.smtp.username} onChange={(v) => setSmtp('username', v)} autoComplete="off" /></Field>
        <Field label="Password" help={settings.smtp.password.set ? 'A password is stored. Leave blank to keep it.' : undefined}><TextInput value={draft.smtp.password} onChange={(v) => setSmtp('password', v)} type="password" autoComplete="new-password" placeholder={settings.smtp.password.set ? '•••••••••• (unchanged)' : ''} /></Field>
      </div>
      {plaintextAuth && (
        <div className={`banner ${draft.smtp.allowPlaintextAuth ? 'banner-warning' : 'banner-error'}`}>
          <AlertTriangle size={18} />
          <div>
            <strong>Credentials over an unencrypted connection</strong>
            <p>With security set to “None”, the username and password are sent to {draft.smtp.host} in cleartext. Choose STARTTLS or implicit TLS; {draft.smtp.allowPlaintextAuth ? 'plaintext authentication is currently allowed.' : 'until then the panel refuses to authenticate.'}</p>
          </div>
        </div>
      )}
      <Field inline><Toggle checked={draft.smtp.allowSelfSigned} onChange={(v) => setSmtp('allowSelfSigned', v)} label="Accept the relay's self-signed certificate" /></Field>
      <Field inline><Toggle checked={draft.smtp.allowPlaintextAuth} onChange={(v) => setSmtp('allowPlaintextAuth', v)} label="Allow plaintext authentication" description="Send the relay password over a plain connection to a non-loopback host. Only for an isolated network." /></Field>
      <Field inline><Toggle checked={draft.smtp.prefer} onChange={(v) => setSmtp('prefer', v)} label="Prefer the relay even when Exim is installed" /></Field>
      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Webhooks</h3>
      <Field inline><Toggle checked={draft.webhook.allowPrivate} onChange={(v) => setDraft((d) => ({ ...d, webhook: { ...d.webhook, allowPrivate: v } }))} label="Allow webhooks to private addresses" description="Loopback, link-local and RFC 1918 targets are refused unless this is on, so a contact cannot be pointed at internal services." /></Field>
      <ErrorBanner error={error} />
      <FormActions>
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
        <Button disabled={!dirty || saving} onClick={() => setDraft(initial())}>Reset</Button>
      </FormActions>
      <h3 style={{ margin: '14px 0 6px', fontSize: 14 }}>Send a test message</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}><TextInput value={testTo} onChange={setTestTo} placeholder="you@example.com" type="email" /></div>
        <Button icon={Send} loading={testing} disabled={!testTo.trim() || dirty} onClick={sendTest} title={dirty ? 'Save the settings first' : undefined}>Send</Button>
      </div>
    </Card>
  );
}

function ChecksCard({ settings, schedule, openAlerts, onChanged }) {
  const toast = useToast();
  const check = settings.check;
  const [draft, setDraft] = useState(check);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  useEffect(() => { setDraft(check); }, [check]);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = ['enabled', 'diskThresholdPercent', 'cooldownMinutes', 'sslDays'].some((k) => draft[k] !== check[k]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/server-contacts/settings', { check: { enabled: draft.enabled, diskThresholdPercent: draft.diskThresholdPercent, cooldownMinutes: draft.cooldownMinutes, sslDays: draft.sslDays } });
      toast.success('Monitoring settings saved');
      onChanged?.();
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  // The check is a background job (service probes plus one delivery per
  // contact can take a while). The stream shows its log; the result is
  // polled so a job that finished before the stream opened is not missed.
  const runNow = async () => {
    setRunning(true);
    setResult(null);
    let id;
    try {
      const res = await api.post('/server-contacts/check');
      id = res.data.job.id;
      setJobId(id);
    } catch (err) { toast.error(err); setRunning(false); return; }
    try {
      let job;
      for (;;) {
        job = (await api.get(`/system/jobs/${id}`)).data;
        if (!['queued', 'running'].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (job.status === 'done' && job.result) {
        setResult(job.result);
        const n = job.result.notifications?.length || 0;
        toast[n ? 'warning' : 'success'](n ? `${n} notification(s) raised` : 'All monitored services are up, disks are below the threshold and no certificate is about to expire');
      } else toast.error(job.error || `The check ${job.status}`);
    } catch (err) { toast.error(err); } finally { setRunning(false); onChanged?.(); }
  };

  const last = check.lastResult;
  return (
    <Card title="Monitoring checks" subtitle={`Every 10 minutes (Configure ${BRAND.product} Cron Jobs → server-contacts-check) the panel raises service.down, service.restored, disk.space.low and ssl.expiring.`} actions={<StatusPill status={check.enabled && schedule?.enabled ? 'enabled' : 'disabled'}>{check.enabled && schedule?.enabled ? 'Enabled' : 'Disabled'}</StatusPill>}>
      <KeyValue items={[
        ['Last run', check.lastRunAt ? formatDate(check.lastRunAt) : 'never'],
        ['Last result', last ? `${last.services?.checked ?? 0} service(s), ${last.disks?.checked ?? 0} filesystem(s)${last.services?.down?.length ? `, down: ${last.services.down.join(', ')}` : ''}${last.disks?.low?.length ? `, low: ${last.disks.low.map((d) => `${d.mountpoint} ${d.usedPercent}%`).join(', ')}` : ''}${last.ssl?.expiring?.length ? `, ${last.ssl.expiring.length} certificate(s) expiring` : ''}` : '—'],
        ['Next scheduled run', schedule?.enabled && check.enabled ? formatDate(schedule.nextRunAt) : '—'],
        ['Open alerts', openAlerts.length ? openAlerts.map((a) => <div key={a.key}><code>{a.key}</code> <span className="muted">since {formatDate(a.since)}</span></div>) : 'none'],
      ]} />
      <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Run the scheduled checks" /></Field>
      <div className="form-grid">
        <Field label="Disk usage threshold (%)"><NumberInput value={draft.diskThresholdPercent} onChange={(v) => set('diskThresholdPercent', v ?? 90)} min={50} max={99} nullable={false} /></Field>
        <Field label="Repeat an open alert after (minutes)"><NumberInput value={draft.cooldownMinutes} onChange={(v) => set('cooldownMinutes', v ?? 360)} min={10} max={10080} nullable={false} /></Field>
        <Field label="Warn about certificates expiring within (days)"><NumberInput value={draft.sslDays} onChange={(v) => set('sslDays', v ?? 14)} min={1} max={90} nullable={false} /></Field>
      </div>
      <FormActions>
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
        <Button icon={Play} loading={running} onClick={runNow}>Run checks now</Button>
      </FormActions>
      {jobId && running && <ProgressLog jobId={jobId} />}
      {result && (
        <div className="banner banner-info" style={{ marginTop: 12 }}>
          <div>
            <strong>Checked {result.services.checked} service(s) and {result.disks.checked} filesystem(s)</strong>
            <p style={{ margin: '4px 0' }}>{result.services.down.length ? `Down: ${result.services.down.join(', ')}. ` : 'All monitored services are active. '}{result.disks.low.length ? `Low disk: ${result.disks.low.map((d) => `${d.mountpoint} (${d.usedPercent}%)`).join(', ')}. ` : ''}{result.ssl.expiring.length ? `Expiring certificates: ${result.ssl.expiring.map((c) => (c.kind === 'service' ? `${c.domain} (service)` : c.domain)).join(', ')}.` : ''}</p>
            {result.notifications.length > 0 && <ul>{result.notifications.map((n, i) => <li key={i}>{n.event}: {n.subject} — {n.sent} sent{n.failed ? `, ${n.failed} failed` : ''}</li>)}</ul>}
            {[result.services.error, result.disks.error, result.ssl.error].filter(Boolean).map((e) => <small key={e}>{e}</small>)}
          </div>
        </div>
      )}
    </Card>
  );
}

function EventCatalog({ events }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Event catalog" subtitle="What the panel can notify about, with the default severity each event carries. Events marked “not raised yet” are reserved for modules still being wired up." actions={<Button size="sm" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</Button>} padded={false}>
      {open && (
        <DataTable dense rows={events} rowKey={(e) => e.key} columns={[
          { key: 'group', label: 'Area' },
          { key: 'key', label: 'Event', render: (e) => <code>{e.key}</code> },
          { key: 'label', label: 'Description' },
          { key: 'severity', label: 'Severity', render: (e) => <StatusPill status={SEVERITY_STATUS[e.severity]}>{e.severity}</StatusPill> },
          { key: 'wired', label: 'Raised by', render: (e) => (e.wired === false ? <StatusPill status="pending">not raised yet</StatusPill> : <StatusPill status="ok">active</StatusPill>) },
        ]} />
      )}
    </Card>
  );
}

function DeliveryLog({ version, events }) {
  const table = useTableState({ pageSize: 25 });
  const [status, setStatus] = useState('');
  const [event, setEvent] = useState('');
  const path = `/server-contacts/deliveries${queryString({ ...table.state, status, event })}`;
  const { data, meta, loading, error, refetch } = useApi(path);
  useEffect(() => { refetch(); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card title="Delivery log" subtitle="Every notification attempt, including tests and the copies mailed to root." padded={false} actions={<Button size="sm" icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <DataTable dense rows={data || []} loading={loading} error={error} total={meta?.total} page={table.state.page} pageSize={table.state.pageSize} onPageChange={table.setPage}
        sort={table.state.sort} dir={table.state.dir} onSortChange={table.setSort} searchable q={table.state.q} onSearch={table.setSearch} searchPlaceholder="Search subject, address, error…"
        toolbar={(
          <>
            <Select value={status} onChange={(v) => { setStatus(v); table.setPage(1); }} options={[{ value: 'sent', label: 'Sent' }, { value: 'failed', label: 'Failed' }]} placeholder="Any status" />
            <Select value={event} onChange={(v) => { setEvent(v); table.setPage(1); }} options={events.map((e) => ({ value: e.key, label: e.key }))} placeholder="Any event" />
          </>
        )}
        emptyText="Nothing has been sent yet."
        columns={[
          { key: 'ts', label: 'When', sortable: true, render: (d) => formatDate(d.ts) },
          { key: 'event', label: 'Event', sortable: true, render: (d) => <><code>{d.event}</code>{d.test ? <> <StatusPill status="info">test</StatusPill></> : null}</> },
          { key: 'severity', label: 'Severity', sortable: true, render: (d) => <StatusPill status={SEVERITY_STATUS[d.severity]}>{d.severity}</StatusPill> },
          { key: 'address', label: 'Contact', sortable: true, render: (d) => <>{d.contact_name || d.address} <small className="muted">{d.channel}{d.transport && d.transport !== d.channel ? ` via ${d.transport}` : ''}</small></> },
          { key: 'subject', label: 'Subject' },
          { key: 'status', label: 'Result', sortable: true, render: (d) => (d.status === 'sent' ? <StatusPill status="ok">sent</StatusPill> : <span title={d.error}><StatusPill status="failed">failed</StatusPill> <small className="muted">{d.error?.slice(0, 80)}</small></span>) },
        ]}
      />
    </Card>
  );
}
