import { useMemo, useState } from 'react';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';

export const CHANNEL_LABEL = { email: 'Email', sms: 'SMS (email-to-SMS gateway)', slack: 'Slack incoming webhook', pushover: 'Pushover', webhook: 'Webhook (HTTP POST)' };
export const SEVERITY_LABEL = { info: 'Info and above (everything)', warning: 'Warning and above', error: 'Error and above', critical: 'Critical only' };

const ADDRESS_FIELD = {
  email: { label: 'Email address', placeholder: 'ops@example.com', help: 'Delivered through Exim, or the SMTP relay configured below when Exim is not installed.' },
  sms: { label: 'Gateway address', placeholder: '5551234567@txt.example.net', help: 'Your carrier\'s email-to-SMS address for the phone. Messages are kept under 300 characters.' },
  slack: { label: 'Incoming webhook URL', placeholder: 'https://hooks.slack.com/services/T000/B000/XXXX', help: 'Create one under Slack → Apps → Incoming Webhooks. The URL is a credential: it is stored encrypted and only shown masked.' },
  pushover: { label: 'User or group key', placeholder: '30-character key from pushover.net', help: 'The application token goes in the field below and is stored encrypted.' },
  webhook: { label: 'URL', placeholder: 'https://example.com/whm/notify', help: 'Receives a JSON POST { event, severity, subject, body, data, hostname }. With a secret, X-WHM-Signature carries an HMAC-SHA256 of the body. A URL with a query string is stored encrypted and shown masked.' },
};

export function emptyContact() {
  return { name: '', channel: 'email', address: '', events: [], allEvents: true, minSeverity: 'info', enabled: true, config: {} };
}

// Create/edit form; onSubmit receives the API body (secrets only when typed).
export function ContactForm({ initial, events, channels, severities, onSubmit, onCancel, saving, error }) {
  const [draft, setDraft] = useState(() => ({ ...emptyContact(), ...initial, config: {} }));
  const [secrets, setSecrets] = useState({ token: '', secret: '', channelName: initial?.config?.channelName || '' });
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const field = ADDRESS_FIELD[draft.channel] || ADDRESS_FIELD.email;
  const groups = useMemo(() => {
    const out = new Map();
    for (const e of events.filter((x) => x.key !== 'test')) { if (!out.has(e.group)) out.set(e.group, []); out.get(e.group).push(e); }
    return [...out.entries()];
  }, [events]);
  const toggleEvent = (key) => set('events', draft.events.includes(key) ? draft.events.filter((k) => k !== key) : [...draft.events, key]);
  const toggleGroup = (keys) => { const all = keys.every((k) => draft.events.includes(k)); set('events', all ? draft.events.filter((k) => !keys.includes(k)) : [...new Set([...draft.events, ...keys])]); };

  const submit = (e) => {
    e.preventDefault();
    const config = {};
    if (draft.channel === 'pushover' && secrets.token) config.token = secrets.token;
    if (draft.channel === 'webhook' && secrets.secret !== '') config.secret = secrets.secret;
    if (draft.channel === 'slack') config.channelName = secrets.channelName || null;
    onSubmit({ name: draft.name.trim(), channel: draft.channel, address: draft.address.trim(), events: draft.allEvents ? [] : draft.events, minSeverity: draft.minSeverity, enabled: draft.enabled, ...(Object.keys(config).length ? { config } : {}) });
  };

  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label="Name" help="How this contact appears in the delivery log."><TextInput value={draft.name} onChange={(v) => set('name', v)} placeholder="e.g. On-call pager" maxLength={80} /></Field>
        <Field label="Channel" required><Select value={draft.channel} onChange={(v) => set('channel', v)} options={channels.map((c) => ({ value: c, label: CHANNEL_LABEL[c] || c }))} /></Field>
      </div>
      <Field label={field.label} help={initial?.config?.url?.set && draft.address === initial.address ? 'The stored URL is shown masked; leave it as is to keep it, or paste a new URL to replace it.' : field.help} required error={error?.fields?.address}><TextInput value={draft.address} onChange={(v) => set('address', v)} placeholder={field.placeholder} maxLength={500} /></Field>
      {draft.channel === 'pushover' && (
        <Field label="Application token" help={initial?.config?.token?.set ? 'A token is stored. Leave blank to keep it.' : 'Register an application at pushover.net to get a token.'} required={!initial?.config?.token?.set} error={error?.fields?.config}>
          <TextInput value={secrets.token} onChange={(v) => setSecrets((s) => ({ ...s, token: v }))} type="password" autoComplete="off" placeholder={initial?.config?.token?.set ? '•••••••••• (unchanged)' : ''} />
        </Field>
      )}
      {draft.channel === 'webhook' && (
        <Field label="Signing secret" help={initial?.config?.secret?.set ? 'A secret is stored. Leave blank to keep it; type a space and clear it to remove it.' : 'Optional. The receiver verifies X-WHM-Signature with it.'}>
          <TextInput value={secrets.secret} onChange={(v) => setSecrets((s) => ({ ...s, secret: v }))} type="password" autoComplete="off" placeholder={initial?.config?.secret?.set ? '•••••••••• (unchanged)' : ''} />
        </Field>
      )}
      {draft.channel === 'slack' && (
        <Field label="Channel override" help="Optional, e.g. #alerts. Most webhooks are bound to a channel already.">
          <TextInput value={secrets.channelName} onChange={(v) => setSecrets((s) => ({ ...s, channelName: v }))} placeholder="#alerts" />
        </Field>
      )}
      <div className="form-grid">
        <Field label="Minimum severity" help="Events below this severity are not sent to this contact."><Select value={draft.minSeverity} onChange={(v) => set('minSeverity', v)} options={severities.map((s) => ({ value: s, label: SEVERITY_LABEL[s] || s }))} /></Field>
        <Field inline><Toggle checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Enabled" description="Disabled contacts receive nothing but keep their configuration." /></Field>
      </div>
      <Field inline><Toggle checked={draft.allEvents} onChange={(v) => set('allEvents', v)} label="Receive every event" description="Turn off to pick individual events." /></Field>
      {!draft.allEvents && (
        <div className="event-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
          {groups.map(([group, list]) => {
            const keys = list.map((e) => e.key);
            const checked = keys.filter((k) => draft.events.includes(k)).length;
            return (
              <div key={group} className="card" style={{ padding: 10, marginBottom: 0 }}>
                <label className="checkbox" style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 600, marginBottom: 6 }}>
                  <input type="checkbox" checked={checked === keys.length} ref={(el) => { if (el) el.indeterminate = checked > 0 && checked < keys.length; }} onChange={() => toggleGroup(keys)} />
                  {group}
                </label>
                {list.map((e) => (
                  <label key={e.key} className="checkbox" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0 2px 22px' }}>
                    <input type="checkbox" checked={draft.events.includes(e.key)} onChange={() => toggleEvent(e.key)} />
                    <span>{e.label} <small className="muted">({e.severity})</small></span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {error?.fields?._ && <ErrorBanner error={{ message: error.fields._.join(', ') }} />}
      {error && !error.fields && <ErrorBanner error={error} />}
      <FormActions>
        <Button type="submit" variant="primary" loading={saving} disabled={!draft.address.trim()}>{initial?.id ? 'Save changes' : 'Add contact'}</Button>
        <Button onClick={onCancel} disabled={saving}>Cancel</Button>
      </FormActions>
    </form>
  );
}
