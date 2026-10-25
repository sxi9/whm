import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, TextInput, Select, NumberInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PublishBadge } from '../../dns/ZonePicker.jsx';

const EMPTY = { domain: '', ip: '', template: 'standard', account: '', ttl: null };

export default function AddDnsZone({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const { data: templates } = useApi(user.role === 'root' ? '/dns/templates' : null, { enabled: user.role === 'root' });
  const { data: accounts } = useApi('/accounts?pageSize=500&sort=username');
  const [form, setForm] = useState(EMPTY);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v != null));
      const { data } = await api.post('/dns/zones', body);
      setResult(data);
      toast.success(data.applied === false ? `Zone ${data.domain} saved (BIND is not installed, so it is not served yet)` : `Zone ${data.domain} created and loaded into BIND`);
    } catch (err) { setError(err); } finally { setLoading(false); }
  };

  if (result) {
    return (
      <>
        <PageHeader fn={fn} />
        <Card title={`Zone ${result.domain} created`} actions={<Button onClick={() => { setResult(null); setForm(EMPTY); }}>Add another</Button>}>
          <KeyValue items={[['Domain', result.domain], ['Account', result.account || 'none'], ['Serial', <code key="s">{result.serial}</code>], ['TTL', `${result.ttl}s`], ['Records', result.records.length], ['Status', <PublishBadge key="p" result={result} />]]} />
          <pre className="log" style={{ marginTop: 12 }}>{result.records.map((r) => `${(r.name === '@' ? result.domain : `${r.name}.${result.domain}`).padEnd(32)} ${r.type.padEnd(6)} ${r.priority != null ? `${r.priority} ` : ''}${r.value}`).join('\n')}</pre>
          <p style={{ marginTop: 14 }}><Link to={`/dns-functions/dns-zone-manager?domain=${result.domain}`}>Open in DNS Zone Manager</Link></p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader fn={fn} description="Creates a zone from a template (SOA, NS, A, MX, www, mail, SPF), validates it with named-checkzone, writes it to BIND and reloads." />
      <form onSubmit={submit}>
        <Card title="Zone">
          <CapabilityNotice error={error} />
          <ErrorBanner error={error && !error.fields && error.code !== 'capability_missing' ? error : null} />
          <div className="form-grid">
            <Field label="Domain" required error={error?.fields?.domain} help="Fully-qualified domain, e.g. example.com"><TextInput value={form.domain} onChange={(v) => set('domain')(v.toLowerCase())} placeholder="example.com" autoFocus /></Field>
            <Field label="IP address" error={error?.fields?.ip} help="Blank uses the account's IP or the server's main IP"><TextInput value={form.ip} onChange={set('ip')} placeholder="203.0.113.10" /></Field>
            <Field label="Account" error={error?.fields?.account} help="Owner of the zone; auto-detected from the domain when blank">
              <Select value={form.account} onChange={set('account')} options={(accounts || []).map((a) => ({ value: a.username, label: `${a.username} — ${a.domain}` }))} placeholder="Auto-detect from domain" />
            </Field>
            {user.role === 'root' && <Field label="Template" error={error?.fields?.template}><Select value={form.template} onChange={set('template')} options={(templates || [{ name: 'standard' }]).map((t) => t.name)} /></Field>}
            <Field label="Default TTL" error={error?.fields?.ttl} help="Blank = server default"><NumberInput value={form.ttl} onChange={set('ttl')} min={0} placeholder="14400" /></Field>
          </div>
        </Card>
        <FormActions><Button type="submit" variant="primary" loading={loading}>Add zone</Button></FormActions>
      </form>
    </>
  );
}
