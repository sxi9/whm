import { useEffect, useMemo, useState } from 'react';
import { Send, Plus, X } from 'lucide-react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { Card, Loading, KeyValue, CapabilityNotice, StatusPill } from '../../components/Common.jsx';
import { DataTable } from '../../components/DataTable.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

const TARGET_RE = /^([a-z][a-z0-9_-]{0,31}|[A-Za-z0-9_][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,63})$/;

function TargetList({ label, help, value, onChange }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const add = (e) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    if (!TARGET_RE.test(t)) { toast.error('Enter a local account name or a full email address'); return; }
    if (!value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <Field label={label} help={help}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {value.length === 0 && <span className="muted">Not forwarded (local mailbox)</span>}
        {value.map((t) => (
          <span key={t} className="pill pill-info" style={{ textTransform: 'none', height: 26, gap: 6 }}>
            {t}
            <button type="button" className="icon-button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} style={{ padding: 0 }}><X size={12} /></button>
          </span>
        ))}
      </div>
      <form onSubmit={add} style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><TextInput value={draft} onChange={setDraft} placeholder="admin@example.com or a local user" /></div>
        <Button type="submit" icon={Plus} disabled={!draft.trim() || value.length >= 20}>Add</Button>
      </form>
    </Field>
  );
}

export function MailPreferences() {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/server-contacts/mail-preferences');
  const [forwardTo, setForwardTo] = useState([]);
  const [nobodyTo, setNobodyTo] = useState([]);
  const [events, setEvents] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [testing, setTesting] = useState(false);

  const savedNobody = data?.users?.nobody || [];
  useEffect(() => { if (data) { setForwardTo(data.forwardTo); setNobodyTo(data.users?.nobody || []); setEvents(data.rootMailEvents); } }, [data]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const dirty = data && (!same(forwardTo, data.forwardTo) || !same(nobodyTo, savedNobody) || !same([...events].sort(), [...data.rootMailEvents].sort()));
  const groups = useMemo(() => {
    const out = new Map();
    for (const e of data?.events || []) { if (!out.has(e.group)) out.set(e.group, []); out.get(e.group).push(e); }
    return [...out.entries()];
  }, [data]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {};
      if (!same(forwardTo, data.forwardTo)) body.forwardTo = forwardTo;
      if (!same(nobodyTo, savedNobody)) body.users = { nobody: nobodyTo };
      if (!same([...events].sort(), [...data.rootMailEvents].sort())) body.rootMailEvents = events;
      const res = await api.put('/server-contacts/mail-preferences', body);
      const rebuild = res.data.rebuild;
      const changed = [body.forwardTo && `root mail ${forwardTo.length ? `forwards to ${forwardTo.join(', ')}` : 'stays in the local mailbox'}`, body.users && `mail for nobody ${nobodyTo.length ? `forwards to ${nobodyTo.join(', ')}` : 'stays in the local mailbox'}`].filter(Boolean);
      toast.success(changed.length ? `${changed.join('; ')}${rebuild?.ran ? ' (alias database rebuilt)' : ''}` : 'System mail preferences saved');
      refetch();
    } catch (err) { setSaveError(err); toast.error(err); } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.post('/server-contacts/mail-preferences/test');
      toast.success(`Test message for root handed to ${res.data.transport === 'smtp' ? `the SMTP relay for ${res.data.to.join(', ')}` : `Exim as ${res.data.address}`}`);
    } catch (err) { toast.error(err, { timeout: 10_000 }); } finally { setTesting(false); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBanner error={error} onRetry={refetch} />;

  const aliasesUnavailable = data.aliasError && ['capability_missing', 'binary_not_found', 'path_not_allowed'].includes(data.aliasError.code);

  return (
    <>
      {aliasesUnavailable && <CapabilityNotice error={{ code: 'capability_missing', message: `The agent could not read ${data.aliases?.path || '/etc/aliases'} (${data.aliasError.message}). The forwarding list below is the last one saved from this panel.` }} onRetry={refetch} />}
      {data.aliasError && !aliasesUnavailable && <ErrorBanner error={{ message: `Could not read /etc/aliases: ${data.aliasError.message}` }} onRetry={refetch} />}
      {!data.capability.mailTransport && <CapabilityNotice capability="exim" error={{ code: 'capability_missing', message: 'Exim is not installed and no SMTP relay is configured in Contact Manager, so copies of events cannot be mailed to root yet. Forwarding in /etc/aliases is still saved for when the mail server is installed.' }} onRetry={refetch} />}
      {data.capability.mailTransport === 'smtp' && (
        <div className={`banner ${data.rootDelivery?.error ? 'banner-warning' : 'banner-info'}`}><div>
          <strong>Root mail goes through the SMTP relay</strong>
          <p>
            The relay configured in Contact Manager does not read /etc/aliases, so the events below are sent straight to the forwarding addresses above
            {data.rootDelivery?.to?.length ? <> (currently {data.rootDelivery.to.join(', ')})</> : null}.
            {data.rootDelivery?.skipped?.length ? <> Local account name{data.rootDelivery.skipped.length > 1 ? 's' : ''} {data.rootDelivery.skipped.join(', ')} cannot be reached that way and {data.rootDelivery.skipped.length > 1 ? 'are' : 'is'} skipped.</> : null}
            {data.rootDelivery?.error ? <> <strong>Nothing can be delivered right now:</strong> {data.rootDelivery.error}</> : null}
          </p>
        </div></div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 18, alignItems: 'start' }}>
        <Card title="Where root's mail goes" subtitle={`System mail for root (cron output, daemon reports, the events below) is addressed to ${data.rootAddress} and delivered according to /etc/aliases.`}>
          <KeyValue items={[
            ['Alias file', data.aliases ? <><code>{data.aliases.path}</code> {data.aliases.exists ? '' : <StatusPill status="warning">will be created</StatusPill>}</> : <span className="muted">unavailable</span>],
            ['Rebuild after saving', data.aliases?.rebuildTool === 'newaliases' ? 'newaliases (Postfix/Sendmail database)' : data.aliases?.rebuildTool === 'exim' ? 'not needed: Exim reads the file directly' : <span className="muted">no mail server detected</span>],
            ['Mail transport', data.capability.mailTransport === 'exim' ? 'Exim on this server' : data.capability.mailTransport === 'smtp' ? 'SMTP relay (Contact Manager)' : <span className="muted">none</span>],
          ]} />
          <TargetList label="Forward root's mail to" value={forwardTo} onChange={setForwardTo} help={data.capability.mailTransport === 'smtp' ? 'Full email addresses receive the events below through the SMTP relay; local account names only apply once a mail server runs on this host.' : 'Local account names or full email addresses. An empty list keeps root\'s mail in the local mailbox.'} />
          <TargetList label="Forward mail for nobody to" value={nobodyTo} onChange={setNobodyTo} help="The web server user: cron output and PHP mail() from sites without a sender land here. Forward it to root or an address so it is read; an empty list keeps it in the local mailbox." />
          <FormActions>
            <Button icon={Send} loading={testing} disabled={!data.capability.mailTransport || dirty || Boolean(data.rootDelivery?.error)} onClick={sendTest} title={dirty ? 'Save first' : data.rootDelivery?.error || undefined}>Send a test message to root</Button>
          </FormActions>
        </Card>

        <Card title="Events that also mail root" subtitle="Independently of the contacts in Contact Manager, these events are mailed to root (and therefore to the forwarding addresses above).">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {groups.map(([group, list]) => (
              <div key={group}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{group}</div>
                {list.map((e) => (
                  <label key={e.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
                    <input type="checkbox" checked={events.includes(e.key)} onChange={() => setEvents(events.includes(e.key) ? events.filter((k) => k !== e.key) : [...events, e.key])} />
                    <span>{e.label} <small className="muted">({e.severity})</small></span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <FormActions>
            <Button size="sm" onClick={() => setEvents(data.events.map((e) => e.key))}>Select all</Button>
            <Button size="sm" onClick={() => setEvents([])}>Select none</Button>
          </FormActions>
        </Card>
      </div>

      {data.aliases?.entries?.length > 0 && (
        <Card title="Other aliases on this server" subtitle="Read from /etc/aliases. Only the root and nobody entries are managed by the panel; edit the rest on the server." padded={false}>
          <DataTable dense rows={data.aliases.entries.filter((e) => !(data.managedUsers || ['root']).includes(e.name))} rowKey={(e) => e.name} emptyText="Only the managed aliases exist."
            columns={[{ key: 'name', label: 'Alias', render: (e) => <code>{e.name}</code> }, { key: 'targets', label: 'Delivers to', render: (e) => e.targets.join(', ') }]} />
        </Card>
      )}

      <div className="sticky-actions">
        <ErrorBanner error={saveError} />
        <FormActions>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
          <Button disabled={!dirty || saving} onClick={() => { setForwardTo(data.forwardTo); setNobodyTo(savedNobody); setEvents(data.rootMailEvents); }}>Reset</Button>
        </FormActions>
      </div>
    </>
  );
}
