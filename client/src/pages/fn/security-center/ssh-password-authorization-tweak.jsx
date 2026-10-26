import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { useApi } from '../../../hooks/useApi.js';
import { PageHeader, Card, StatusPill, Loading, KeyValue } from '../../../components/Common.jsx';
import { Field, Select, NumberInput, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { RequestError, ManagedFileNote } from '../../security/Shared.jsx';

const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
const ROOT_LOGIN = [{ value: 'yes', label: 'Yes (password or key)' }, { value: 'prohibit-password', label: 'Key only (prohibit-password)' }, { value: 'forced-commands-only', label: 'Forced commands only' }, { value: 'no', label: 'No' }];

export default function SshPasswordAuthorizationTweak({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, refetch } = useApi('/security/ssh/config');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const e = data.effective || {};
    setDraft({ PasswordAuthentication: e.passwordauthentication || 'yes', PermitRootLogin: e.permitrootlogin || 'yes', PubkeyAuthentication: e.pubkeyauthentication || 'yes', PermitEmptyPasswords: e.permitemptypasswords || 'no', MaxAuthTries: Number(e.maxauthtries) || 6, Port: Number(e.port) || 22 });
  }, [data]);

  const save = async () => {
    // The API refuses this combination unless force is sent; the confirm here
    // is what grants it.
    let force = false;
    if (draft.PasswordAuthentication === 'no' && data.authorizedKeyCount === 0) {
      const ok = await confirm({ title: 'No root SSH keys are authorized', message: 'Disabling password authentication without an authorized key will lock root out of SSH. Continue anyway?', confirmLabel: 'Disable passwords', danger: true, typeToConfirm: 'LOCKOUT' });
      if (!ok) return;
      force = true;
    }
    setBusy(true);
    try {
      const { data: result } = await api.put('/security/ssh/config', { settings: draft, ...(force ? { force: true } : {}) });
      toast.success(result.reloaded ? `sshd configuration validated and ${result.unit} reloaded` : 'sshd configuration written (reload it from Service Manager)');
      if (result.shadowed?.length) toast.error(`${result.shadowed.length} setting${result.shadowed.length === 1 ? ' is' : 's are'} overridden by another sshd configuration file; see the warning above`);
      refetch();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader fn={fn} />
      <RequestError error={error} onRetry={refetch} />
      {loading && !data && <Loading />}
      {data && draft && (
        <>
          <Card title="Effective configuration" subtitle={`Read from ${data.source}`}>
            <KeyValue items={[
              ['Password authentication', <StatusPill key="p" status={draft.PasswordAuthentication === 'no' ? 'ok' : 'warning'}>{data.effective.passwordauthentication || 'yes (default)'}</StatusPill>],
              ['Root login', <StatusPill key="r" status={(data.effective.permitrootlogin || 'yes') === 'yes' ? 'warning' : 'ok'}>{data.effective.permitrootlogin || 'yes (default)'}</StatusPill>],
              ['Authorized root keys', <Link key="k" to="/security-center/manage-roots-ssh-keys">{data.authorizedKeyCount} key{data.authorizedKeyCount === 1 ? '' : 's'}</Link>],
              ['Drop-in include active', data.includeActive ? 'yes' : 'no — it is added automatically on save'],
            ]} />
            <ManagedFileNote path={data.managedPath} />
            {data.legacyPath && <p className="muted">The older drop-in <code>{data.legacyPath}</code> is still in place; it is moved to <code>{data.managedPath}</code> on the next save so it sorts before distribution files.</p>}
            {data.shadowed?.length > 0 && (
              <div className="banner banner-warning" style={{ marginTop: 10 }}>
                <div>
                  <strong>Some panel settings are not in effect.</strong> sshd keeps the first value it reads, and another file sets these before the panel drop-in:
                  <ul style={{ margin: '6px 0 0 18px' }}>
                    {data.shadowed.map((s) => <li key={s.key}><code>{s.key} {s.managed}</code> is overridden by <code>{s.effective}</code>{s.by ? <> from <code>{s.by}</code></> : null}</li>)}
                  </ul>
                  Remove or change the directive in that file (and keep the Include line at the top of <code>/etc/ssh/sshd_config</code>), then save again.
                </div>
              </div>
            )}
          </Card>
          <Card title="Settings" subtitle="Written to the panel's drop-in, validated with sshd -t and rolled back if sshd rejects them.">
            <div className="form-grid">
              <Field label="Password authentication" help="Turn off once a key is authorized so brute-force attempts cannot succeed."><Select value={draft.PasswordAuthentication} onChange={(v) => setDraft({ ...draft, PasswordAuthentication: v })} options={YES_NO} /></Field>
              <Field label="Permit root login"><Select value={draft.PermitRootLogin} onChange={(v) => setDraft({ ...draft, PermitRootLogin: v })} options={ROOT_LOGIN} /></Field>
              <Field label="Public key authentication"><Select value={draft.PubkeyAuthentication} onChange={(v) => setDraft({ ...draft, PubkeyAuthentication: v })} options={YES_NO} /></Field>
              <Field label="Permit empty passwords"><Select value={draft.PermitEmptyPasswords} onChange={(v) => setDraft({ ...draft, PermitEmptyPasswords: v })} options={YES_NO} /></Field>
              <Field label="Max authentication tries"><NumberInput value={draft.MaxAuthTries} onChange={(v) => setDraft({ ...draft, MaxAuthTries: v })} min={1} max={100} nullable={false} /></Field>
              <Field label="Port" help="Changing the port disconnects nothing now, but update your firewall before reconnecting."><NumberInput value={draft.Port} onChange={(v) => setDraft({ ...draft, Port: v })} min={1} max={65535} nullable={false} /></Field>
            </div>
            <FormActions><Button variant="primary" loading={busy} onClick={save}>Save and reload sshd</Button></FormActions>
          </Card>
        </>
      )}
    </>
  );
}
