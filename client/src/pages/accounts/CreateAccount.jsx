import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, StatusPill } from '../../components/Common.jsx';
import { AccountManager } from './AccountDetails.jsx';
import { Field, TextInput, PasswordInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

const EMPTY_FORM = { domain: '', username: '', password: '', contactEmail: '', package: '', ip: '', owner: '', manager: '' };

function suggestUsername(domain) {
  return domain.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '').replace(/^[^a-z]+/, '').slice(0, 16);
}

export default function CreateAccount({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const { data: packages } = useApi('/packages?pageSize=500');
  const { data: managers } = useApi('/accounts/managers');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [provision, setProvision] = useState({ web: true, dns: true, mail: true });
  const [auto, setAuto] = useState(true);
  // The manager follows the owner until it is picked by hand.
  const [managerTouched, setManagerTouched] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { if (auto) setForm((f) => ({ ...f, username: suggestUsername(f.domain) })); }, [form.domain, auto]);
  useEffect(() => {
    if (managerTouched || user.role !== 'root') return;
    const follows = form.owner && (managers || []).some((m) => m.username === form.owner) ? form.owner : '';
    setForm((f) => (f.manager === follows ? f : { ...f, manager: follows }));
  }, [form.owner, managers, managerTouched, user.role]);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body = { ...Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '')), provision };
      const { data } = await api.post('/accounts', body);
      setResult(data);
      toast.success(`Account ${data.username} created`);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  if (result) {
    const steps = result.provisioning?.steps || {};
    const tone = { applied: 'ok', pending: 'pending', failed: 'failed', skipped: 'muted' };
    const step = (key, label) => [label, <span key={key}><StatusPill status={tone[steps[key]?.status] || 'muted'}>{steps[key]?.status || result.provisioning?.[key] || 'unknown'}</StatusPill>{steps[key]?.detail && <span className="muted" style={{ marginLeft: 8 }}>{steps[key].detail}</span>}</span>];
    return (
      <>
        <PageHeader fn={fn} />
        <Card title="Account created" actions={<button className="btn" onClick={() => { setResult(null); setForm({ ...EMPTY_FORM }); setManagerTouched(false); }}>Create another</button>}>
          <KeyValue items={[
            ['Domain', result.domain], ['Username', <code key="u">{result.username}</code>], ['Package', result.package_name], ['IP address', result.ip || 'shared'], ['Home directory', <code key="h">{result.home_dir}</code>],
            ['Account manager', <AccountManager key="m" account={result} />],
            ['Linux user', <StatusPill key="s" status={result.provisioning?.systemUser ? 'ok' : 'warning'}>{result.provisioning?.systemUser ? 'created' : 'not created (development mode)'}</StatusPill>],
            step('web', 'Web vhost'), step('dns', 'DNS zone'), step('mail', 'Mail routing'), step('database', 'Databases'),
          ]} />
          <p className="muted" style={{ marginTop: 10 }}>Pending steps are applied automatically once the missing service is installed and the account is synced; failed steps keep the account and are listed in the audit log.</p>
          <p style={{ marginTop: 14 }}><Link to="/account-information/list-accounts">Go to List Accounts</Link></p>
        </Card>
      </>
    );
  }

  const fieldErr = (k) => error?.fields?.[k];
  return (
    <>
      <PageHeader fn={fn} />
      <form onSubmit={submit}>
        <Card title="Domain information">
          <ErrorBanner error={error && !error.fields ? error : null} />
          <div className="form-grid">
            <Field label="Domain" required error={fieldErr('domain')} help="The account's primary domain, e.g. example.com"><TextInput value={form.domain} onChange={set('domain')} placeholder="example.com" autoFocus /></Field>
            <Field label="Username" required error={fieldErr('username')} help="Lowercase letters, digits, _ or -; starts with a letter; max 32">
              <TextInput value={form.username} onChange={(v) => { setAuto(false); set('username')(v.toLowerCase()); }} />
            </Field>
            <Field label="Password" error={fieldErr('password')} help="Leave blank to set one later via Password Modification"><PasswordInput value={form.password} onChange={set('password')} /></Field>
            <Field label="Contact email" error={fieldErr('contactEmail')}><TextInput type="email" value={form.contactEmail} onChange={set('contactEmail')} placeholder="owner@example.com" /></Field>
          </div>
        </Card>
        <Card title="Package">
          <div className="form-grid">
            <Field label="Package" error={fieldErr('package')} help="Defines disk, bandwidth, domain, database and mail limits">
              <Select value={form.package} onChange={set('package')} options={(packages || []).map((p) => ({ value: p.name, label: p.name }))} placeholder="Server default package" />
            </Field>
            <Field label="Dedicated IP address" error={fieldErr('ip')} help="Leave blank to use the shared IP"><TextInput value={form.ip} onChange={set('ip')} placeholder="203.0.113.10" /></Field>
            {user.role === 'root' && <Field label="Owner" error={fieldErr('owner')} help="Reseller username that will own this account (default: root)"><TextInput value={form.owner} onChange={set('owner')} placeholder="root" /></Field>}
          </div>
        </Card>
        <Card title="Account manager" subtitle="Who the account turns to for support. The manager is shown to the account and shares its conversation under Support › Account Conversations.">
          <div className="form-grid">
            <Field label="Managed by" error={fieldErr('manager')} help={user.role === 'root' ? 'Any root or reseller user; follows the owner until you choose one' : 'Yourself or a root user'}>
              <Select value={form.manager} onChange={(v) => { setManagerTouched(true); set('manager')(v); }} options={(managers || []).map((m) => ({ value: m.username, label: `${m.username} (${m.role}${m.email ? `, ${m.email}` : ''})` }))} placeholder={`Default: you (${user.username})`} />
            </Field>
          </div>
        </Card>
        <Card title="Provisioning" subtitle="Each step runs through its own category when that service exists on this server; a missing daemon leaves the step pending until it is installed.">
          <Field inline><Toggle checked={provision.web} onChange={(v) => setProvision((p) => ({ ...p, web: v }))} label="Web server virtual host" description="Apache vhost with the account's PHP-FPM pool and per-domain logs" /></Field>
          <Field inline><Toggle checked={provision.dns} onChange={(v) => setProvision((p) => ({ ...p, dns: v }))} label="DNS zone" description="Zone from the standard template (A, MX, SPF) pointing at the account's IP" /></Field>
          <Field inline><Toggle checked={provision.mail} onChange={(v) => setProvision((p) => ({ ...p, mail: v }))} label="Local mail routing" description="Adds the domain to Exim's local domains" /></Field>
        </Card>
        <FormActions><Button type="submit" variant="primary" loading={loading}>Create</Button></FormActions>
      </form>
    </>
  );
}
