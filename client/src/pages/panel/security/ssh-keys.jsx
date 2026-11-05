import { useState } from 'react';
import { RefreshCw, KeyRound, Plus, Terminal } from 'lucide-react';
import { Card, KeyValue, EmptyState } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, Textarea, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { ImpersonationNotice, RequestError, isCapabilityError, isFeatureDisabled, keyTypeLabel, SSH_KEY_LINE } from './parts/shared.jsx';

export function normalizeKey(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

export function keyProblem(key, t = untranslated) {
  if (!key) return null;
  if (/PRIVATE KEY/.test(key)) return t('panel.security.key_private', 'That is a private key. Paste the public key (the .pub file) instead and keep the private one to yourself.');
  if (!SSH_KEY_LINE.test(key)) return t('panel.security.key_shape', 'Expected one line like "ssh-ed25519 AAAA… comment" (ssh-rsa and ecdsa-sha2-nistp* work too).');
  return null;
}

export default function SshKeys({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, error, loading, refetch } = usePanelApi('/security/ssh-keys');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const actingAs = me?.actingAs;
  const capability = isCapabilityError(error);
  const noHome = error?.code === 'no_home';
  const cleaned = normalizeKey(key);
  const problem = keyProblem(cleaned, t);
  const shellEnabled = me?.account?.shell && !/nologin|false$/.test(me.account.shell);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const add = async (e) => {
    e.preventDefault();
    if (problem) { setFormError({ message: t('panel.security.key_check', 'Check the key'), fields: { key: [problem] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/security/ssh-keys', { key: cleaned });
      toast.success(fill(t('panel.security.key_authorised', 'Key {fingerprint} authorised'), { fingerprint: res.fingerprint }));
      setKey('');
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const ok = await confirm({ title: fill(t('panel.security.key_remove_title', 'Remove {name}?'), { name: row.comment || row.fingerprint }), message: t('panel.security.key_remove_message', 'Whoever holds the matching private key can no longer open a shell on this account.'), confirmLabel: t('panel.security.key_remove_confirm', 'Remove key'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/security/ssh-keys/${row.id}`); toast.success(t('panel.security.key_removed', 'Key removed')); refetch(); } catch (err) { toast.error(err); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('common.refresh', 'Refresh')}</Button>}>
      <ImpersonationNotice actingAs={actingAs} what={t('panel.security.keys_what', 'Authorised keys')} />
      <div className="grid-2">
        <form onSubmit={add}>
          <Card title={t('panel.security.key_add_title', 'Authorise a public key')} subtitle={t('panel.security.key_add_subtitle', 'Paste the public half of a key pair; its owner can then sign in over SSH without a password.')}>
            <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
            <RequestError error={formError} />
            <Field label={t('panel.security.key_label', 'Public key')} required error={formError?.fields?.key} help={cleaned && !problem ? t('panel.security.key_looks_valid', 'Looks like a valid OpenSSH public key') : t('panel.security.key_help', 'The contents of id_ed25519.pub or id_rsa.pub, one line')} htmlFor="ssh-key">
              <Textarea id="ssh-key" rows={4} mono value={key} onChange={setKey} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop" spellCheck={false} disabled={Boolean(actingAs) || capability} />
            </Field>
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !cleaned || Boolean(problem) || Boolean(actingAs) || capability}>{t('panel.security.key_add_button', 'Authorise key')}</Button>
            </FormActions>
          </Card>
        </form>
        <Card title={t('panel.security.connecting', 'Connecting')}>
          <KeyValue items={[
            [t('panel.security.col_host', 'Host'), <code key="h">{me?.hostname || me?.account?.domain || '—'}</code>],
            [t('panel.security.col_user', 'User'), <code key="u">{me?.account?.username || '—'}</code>],
            [t('panel.security.shell_access', 'Shell access'), shellEnabled ? t('common.enabled', 'Enabled') : t('panel.security.shell_not_enabled', 'Not enabled on this account')],
            [t('panel.security.command', 'Command'), <code key="c" className="small">ssh {me?.account?.username || 'user'}@{me?.hostname || me?.account?.domain || 'server'}</code>],
            [t('panel.security.make_key_pair', 'Make a key pair'), <code key="g" className="small">ssh-keygen -t ed25519 -C "you@laptop"</code>],
          ]} />
          <p className="muted small" style={{ marginTop: 10 }}>{t('panel.security.keys_kept_before', 'Keys are kept in')} <code>~/.ssh/authorized_keys</code>{t('panel.security.keys_kept_after', '; lines you added by hand there are preserved.')}</p>
        </Card>
      </div>

      <Card title={t('panel.security.keys_title', 'Authorised keys')} subtitle={data?.length ? plural(t, 'panel.security.keys_count', data.length, '{count} key can open a shell', '{count} keys can open a shell') : undefined} padded={false}>
        {capability && <div className="card-body"><PanelCapabilityState error={error} onRetry={refetch} /></div>}
        {noHome && <div className="card-body"><EmptyState icon={Terminal} title={t('panel.security.no_home_title', 'No home directory yet')}><p>{error.message}</p><p className="muted">{t('panel.security.keys_no_home', 'Keys can be added once the account has been set up on the server.')}</p></EmptyState></div>}
        {!capability && !noHome && <div className="card-body" style={{ paddingBottom: 0 }}><RequestError error={error} onRetry={refetch} /></div>}
        <DataTable
          columns={[
            { key: 'comment', label: t('panel.security.col_name', 'Name'), render: (r) => (r.comment ? r.comment : <span className="muted">{t('panel.security.key_no_comment', 'no comment')}</span>) },
            { key: 'type', label: t('panel.security.col_type', 'Type'), render: (r) => `${keyTypeLabel(r.type)}${r.bits ? ` · ${fill(t('panel.security.key_bits', '{count} bits'), { count: r.bits })}` : ''}` },
            { key: 'fingerprint', label: t('panel.security.col_fingerprint', 'Fingerprint'), render: (r) => <code className="small">{r.fingerprint}</code> },
            { key: 'options', label: t('panel.security.col_options', 'Options'), render: (r) => (r.options ? <code className="small">{r.options}</code> : <span className="muted">—</span>) },
          ]}
          rows={data || []} loading={loading} error={null} rowKey={(r) => r.id} dense
          rowActions={(r) => [{ label: t('panel.security.remove', 'Remove'), danger: true, primary: true, disabled: Boolean(actingAs), onClick: () => remove(r) }]}
          emptyText={capability ? t('panel.security.keys_empty_capability', 'Keys appear here once shell access is enabled for this account.') : noHome ? t('panel.security.keys_empty_no_home', 'Keys appear here once the account exists on the server.') : t('panel.security.keys_empty', 'No keys authorised yet. Paste a public key above; it appears here with its type and fingerprint and can be removed at any time.')}
        />
      </Card>
      <p className="muted small"><KeyRound size={12} /> {t('panel.security.keys_note', 'Only key lines are listed; comments and other lines in the file stay untouched.')}</p>
    </PanelPage>
  );
}
