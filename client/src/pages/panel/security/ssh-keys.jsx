import { useState } from 'react';
import { RefreshCw, KeyRound, Plus, Terminal } from 'lucide-react';
import { Card, KeyValue, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Textarea, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isFeatureDisabled, keyTypeLabel, SSH_KEY_LINE } from './parts/shared.jsx';

export function normalizeKey(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

export function keyProblem(key) {
  if (!key) return null;
  if (/PRIVATE KEY/.test(key)) return 'That is a private key. Paste the public key (the .pub file) instead and keep the private one to yourself.';
  if (!SSH_KEY_LINE.test(key)) return 'Expected one line like "ssh-ed25519 AAAA… comment" (ssh-rsa and ecdsa-sha2-nistp* work too).';
  return null;
}

export default function SshKeys({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/ssh-keys');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const actingAs = me?.actingAs;
  const capability = isCapabilityError(error);
  const noHome = error?.code === 'no_home';
  const cleaned = normalizeKey(key);
  const problem = keyProblem(cleaned);
  const shellEnabled = me?.account?.shell && !/nologin|false$/.test(me.account.shell);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const add = async (e) => {
    e.preventDefault();
    if (problem) { setFormError({ message: 'Check the key', fields: { key: [problem] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/security/ssh-keys', { key: cleaned });
      toast.success(`Key ${res.fingerprint} authorised`);
      setKey('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: `Remove ${row.comment || row.fingerprint}?`, message: 'Whoever holds the matching private key can no longer open a shell on this account.', confirmLabel: 'Remove key', danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/security/ssh-keys/${row.id}`); toast.success('Key removed'); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      <ImpersonationNotice actingAs={actingAs} what="Authorised keys" />
      <div className="grid-2">
        <form onSubmit={add}>
          <Card title="Authorise a public key" subtitle="Paste the public half of a key pair; its owner can then sign in over SSH without a password.">
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            <Field label="Public key" required error={formError?.fields?.key} help={cleaned && !problem ? 'Looks like a valid OpenSSH public key' : 'The contents of id_ed25519.pub or id_rsa.pub, one line'} htmlFor="ssh-key">
              <Textarea id="ssh-key" rows={4} mono value={key} onChange={setKey} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop" spellCheck={false} disabled={Boolean(actingAs) || capability} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !cleaned || Boolean(problem) || Boolean(actingAs) || capability}>Authorise key</Button>
            </FormActions>
          </Card>
        </form>
        <Card title="Connecting">
          <KeyValue items={[
            ['Host', <code key="h">{me?.hostname || me?.account?.domain || '—'}</code>],
            ['User', <code key="u">{me?.account?.username || '—'}</code>],
            ['Shell access', shellEnabled ? 'Enabled' : 'Not enabled on this account'],
            ['Command', <code key="c" className="small">ssh {me?.account?.username || 'user'}@{me?.hostname || me?.account?.domain || 'server'}</code>],
            ['Make a key pair', <code key="g" className="small">ssh-keygen -t ed25519 -C "you@laptop"</code>],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>Keys are kept in <code>~/.ssh/authorized_keys</code>; lines you added by hand there are preserved.</p>
        </Card>
      </div>

      <Card title="Authorised keys" subtitle={data?.length ? `${data.length} key${data.length === 1 ? '' : 's'} can open a shell` : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {noHome && <div className="card-body"><EmptyState icon={Terminal} title="No home directory yet"><p>{error.message}</p><p className="muted">Keys can be added once the account has been set up on the server.</p></EmptyState></div>}
        {!capability && !noHome && <div className="card-body" style={{ paddingBottom: 0 }}><RequestError error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'comment', label: 'Name', render: (r) => (r.comment ? r.comment : <span className="muted">no comment</span>) },
            { key: 'type', label: 'Type', render: (r) => `${keyTypeLabel(r.type)}${r.bits ? ` · ${r.bits} bits` : ''}` },
            { key: 'fingerprint', label: 'Fingerprint', render: (r) => <code className="small">{r.fingerprint}</code> },
            { key: 'options', label: 'Options', render: (r) => (r.options ? <code className="small">{r.options}</code> : <span className="muted">—</span>) },
          ]}
          rows={data || []} loading={loading} error={null} rowKey={(r) => r.id} dense
          rowActions={(r) => [{ label: 'Remove', danger: true, primary: true, disabled: Boolean(actingAs), onClick: () => remove(r) }]}
          emptyText={capability ? 'Keys appear here once shell access is enabled for this account.' : noHome ? 'Keys appear here once the account exists on the server.' : 'No keys authorised yet. Paste a public key above; it appears here with its type and fingerprint and can be removed at any time.'}
        />
      </Card>
      <p className="muted small"><KeyRound size={12} /> Only key lines are listed; comments and other lines in the file stay untouched.</p>
    </PanelPage>
  );
}
