import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { PageHeader, Card, KeyValue, StatusPill, formatMb, Loading } from '../../components/Common.jsx';
import { Field, TextInput, NumberInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../components/Form.jsx';
import { useToast } from '../../components/Toast.jsx';
import { AccountPicker, useSelectedAccount } from './AccountPicker.jsx';

const SHELLS = [{ value: '/usr/sbin/nologin', label: 'Disabled (no shell)' }, { value: '/bin/bash', label: 'Normal shell (/bin/bash)' }, { value: '/bin/sh', label: '/bin/sh' }, { value: '/usr/local/bin/jailshell', label: 'Jailed shell' }];

export default function ModifyAccount({ fn }) {
  const toast = useToast();
  const { user } = useAuth();
  const [username, setUsername] = useState('');
  const { account, loading, refetch } = useSelectedAccount(username);
  const { data: packages } = useApi('/packages?pageSize=500');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setForm({ contactEmail: account.contact_email || '', package: account.package_name || '', shell: account.shell, diskQuotaMb: account.disk_quota_mb, bandwidthLimitMb: account.bandwidth_limit_mb, demoMode: account.demo_mode, forcePasswordChange: account.force_password_change, ip: account.ip || '', owner: account.owner });
  }, [account]);

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { contactEmail: form.contactEmail || null, shell: form.shell, diskQuotaMb: form.diskQuotaMb, bandwidthLimitMb: form.bandwidthLimitMb, demoMode: form.demoMode, forcePasswordChange: form.forcePasswordChange, ip: form.ip || null };
      if (form.package && form.package !== account.package_name) body.package = form.package;
      if (user.role === 'root' && form.owner && form.owner !== account.owner) body.owner = form.owner;
      await api.patch(`/accounts/${username}`, body);
      toast.success(`Account ${username} updated`);
      refetch();
    } catch (err) { setError(err); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <Card title="Select an account"><AccountPicker value={username} onChange={setUsername} /></Card>
      {username && loading && !account && <Loading />}
      {account && form && (
        <form onSubmit={save}>
          <Card title={`${account.domain} (${account.username})`} subtitle={`Owner ${account.owner} · created ${account.created_at}`}>
            <KeyValue items={[['Status', <StatusPill key="s" status={account.suspended ? 'suspended' : 'active'}>{account.suspended ? 'Suspended' : 'Active'}</StatusPill>], ['Home', <code key="h">{account.home_dir}</code>], ['Disk used', `${formatMb(account.disk_used_mb)} of ${formatMb(account.disk_quota_mb)}`], ['Bandwidth used', `${formatMb(account.bandwidth_used_mb)} of ${formatMb(account.bandwidth_limit_mb)}`]]} />
          </Card>
          <Card title="Basic information">
            <ErrorBanner error={error} />
            <div className="form-grid">
              <Field label="Contact email" error={error?.fields?.contactEmail}><TextInput type="email" value={form.contactEmail} onChange={set('contactEmail')} /></Field>
              <Field label="Package" error={error?.fields?.package} help="Changing the package re-applies its limits">
                <Select value={form.package} onChange={set('package')} options={(packages || []).map((p) => ({ value: p.name, label: p.name }))} placeholder="Keep current" />
              </Field>
              <Field label="IP address" error={error?.fields?.ip}><TextInput value={form.ip} onChange={set('ip')} placeholder="Shared IP" /></Field>
              {user.role === 'root' && <Field label="Owner" error={error?.fields?.owner}><TextInput value={form.owner} onChange={set('owner')} /></Field>}
            </div>
          </Card>
          <Card title="Resource limits">
            <div className="form-grid">
              <Field label="Disk quota (MB)" help="Blank = unlimited" error={error?.fields?.diskQuotaMb}><NumberInput value={form.diskQuotaMb} onChange={set('diskQuotaMb')} min={0} /></Field>
              <Field label="Monthly bandwidth limit (MB)" help="Blank = unlimited" error={error?.fields?.bandwidthLimitMb}><NumberInput value={form.bandwidthLimitMb} onChange={set('bandwidthLimitMb')} min={0} /></Field>
              <Field label="Shell access" error={error?.fields?.shell}><Select value={form.shell} onChange={set('shell')} options={SHELLS} /></Field>
            </div>
          </Card>
          <Card title="Privileges">
            <Field inline><Toggle checked={form.demoMode} onChange={set('demoMode')} label="Demo mode" description="Read-only account for demonstrations" /></Field>
            <Field inline><Toggle checked={form.forcePasswordChange} onChange={set('forcePasswordChange')} label="Force password change" description="User must set a new password at next login" /></Field>
          </Card>
          <FormActions><Button type="submit" variant="primary" loading={saving}>Save</Button></FormActions>
        </form>
      )}
    </>
  );
}
