import { useEffect, useState } from 'react';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue, CapabilityNotice } from '../../../components/Common.jsx';
import { Field, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { RequestError, ManagedFileNote } from '../../security/Shared.jsx';

export default function ApacheModUserdirTweak({ fn }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi('/security/userdir');
  const [enabled, setEnabled] = useState(false);
  const [excluded, setExcluded] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) { setEnabled(Boolean(data.enabled)); setExcluded(data.excludeUsers || []); } }, [data]);

  const save = async () => {
    setBusy(true);
    try {
      const { data: result } = await api.put('/security/userdir', { enabled, excludeUsers: excluded });
      toast.success(result.reload?.error ? `Configuration written; Apache reload failed: ${result.reload.error}` : 'mod_userdir configuration applied and Apache reloaded');
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const toggleUser = (u) => setExcluded((x) => (x.includes(u) ? x.filter((v) => v !== u) : [...x, u]));

  return (
    <>
      <PageHeader fn={fn} description="mod_userdir serves http://host/~user/ from each account's public_html. Because those URLs share the server's main domain they bypass per-domain bandwidth accounting and SSL, so WHM disables them by default." />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && !data.installed && <CapabilityNotice error={{ code: 'capability_missing', message: 'Apache is not installed on this server, so mod_userdir cannot be configured.' }} onRetry={refetch} />}
      {data && data.installed && (
        <>
          <Card title="Status">
            <KeyValue items={[
              ['~user URLs', <StatusPill key="s" status={data.enabled ? 'warning' : 'ok'}>{data.enabled ? 'Enabled' : 'Disabled'}</StatusPill>],
              ['mod_userdir module loaded', data.moduleEnabled == null ? 'unknown' : data.moduleEnabled ? 'yes' : 'no (enabled automatically when you turn this on)'],
              ['Excluded users', data.excludeUsers?.length ? data.excludeUsers.join(', ') : '—'],
            ]} />
            <ManagedFileNote path={data.path} />
          </Card>
          <Card title="Settings" subtitle="The include is validated with apachectl -t before Apache is reloaded; a rejected configuration is rolled back.">
            <Field inline><Toggle checked={enabled} onChange={setEnabled} label="Enable mod_userdir (~user URLs)" description="Users listed below stay disabled even when the feature is on." /></Field>
            {enabled && (
              <Field label="Exclude these accounts" help="Accounts with their own domain rarely need ~user access.">
                <div className="form-grid">
                  {(data.accounts || []).map((u) => <Field key={u} inline><Toggle checked={excluded.includes(u)} onChange={() => toggleUser(u)} label={u} /></Field>)}
                  {!data.accounts?.length && <p className="muted">No hosting accounts yet.</p>}
                </div>
              </Field>
            )}
            <FormActions><Button variant="primary" loading={busy} onClick={save}>Save and reload Apache</Button></FormActions>
          </Card>
        </>
      )}
    </>
  );
}
