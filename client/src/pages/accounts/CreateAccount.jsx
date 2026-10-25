import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, StatusPill } from '../../components/Common.jsx';
import { Field, TextInput, PasswordInput, Select, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';

function suggestUsername(domain) {
  return domain.toLowerCase().replace(/^www\./, '').split('.')[0].replace(/[^a-z0-9]/g, '').replace(/^[^a-z]+/, '').slice(0, 16);
}

export default function CreateAccount({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const { data: packages } = useApi('/packages?pageSize=500');
  const [form, setForm] = useState({ domain: '', username: '', password: '', contactEmail: '', package: '', ip: '', owner: '' });
  const [auto, setAuto] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { if (auto) setForm((f) => ({ ...f, username: suggestUsername(f.domain) })); }, [form.domain, auto]);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
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
    return (
      <>
        <PageHeader fn={fn} />
        <Card title="Account created" actions={<button className="btn" onClick={() => { setResult(null); setForm({ domain: '', username: '', password: '', contactEmail: '', package: '', ip: '', owner: '' }); }}>Create another</button>}>
          <KeyValue items={[
            ['Domain', result.domain], ['Username', <code key="u">{result.username}</code>], ['Package', result.package_name], ['Home directory', <code key="h">{result.home_dir}</code>],
            ['Linux user', <StatusPill key="s" status={result.provisioning?.systemUser ? 'ok' : 'warning'}>{result.provisioning?.systemUser ? 'created' : 'not created (development mode)'}</StatusPill>],
            ['Web vhost', <StatusPill key="w" status="pending">{result.provisioning?.web}</StatusPill>], ['DNS zone', <StatusPill key="d" status="pending">{result.provisioning?.dns}</StatusPill>], ['Mail', <StatusPill key="m" status="pending">{result.provisioning?.mail}</StatusPill>],
          ]} />
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
        <FormActions><Button type="submit" variant="primary" loading={loading}>Create</Button></FormActions>
      </form>
    </>
  );
}
