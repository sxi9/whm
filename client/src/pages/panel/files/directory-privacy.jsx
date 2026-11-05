import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw, Lock, UserPlus, KeyRound } from 'lucide-react';
import { Card, KeyValue, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, PasswordInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { useT, translate } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { RequestError } from './parts/common.jsx';
import { managerHref, isCapabilityError, isFeatureDisabled } from './parts/paths.js';
import { FolderPicker, folderFromParams } from './parts/FolderPicker.jsx';

export const REALM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()'-]{0,63}$/;
export const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export function userProblem(user, password) {
  if (!USER_RE.test(String(user || ''))) return { user: [translate('panel.files.dp_user_rule', 'Letters, digits and . _ @ -; up to 64 characters')] };
  if (String(password || '').length < 8) return { password: [translate('panel.files.dp_password_rule', 'At least 8 characters')] };
  return null;
}

export default function DirectoryPrivacy({ fn }) {
  const { t } = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const folder = folderFromParams(params);
  const { data, error, loading, refetch } = usePanelApi(`/files/privacy?path=${encodeURIComponent(folder)}`);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [newUser, setNewUser] = useState({ user: '', password: '' });
  const [adding, setAdding] = useState(false);
  const [userError, setUserError] = useState(null);
  const [probe, setProbe] = useState(null);
  useEffect(() => { setDraft(null); setSaveError(null); }, [data]);
  const capability = isCapabilityError(error);
  const state = draft ?? { enabled: Boolean(data?.protected), realm: data?.realm || t('panel.files.dp_default_realm', 'Restricted area') };
  const dirty = data && (state.enabled !== Boolean(data.protected) || (state.enabled && state.realm !== data.realm));
  const realmBad = state.enabled && !REALM_RE.test(state.realm);
  const users = (data?.users || []).map((user) => ({ user }));

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const { data: res } = await panelApi.put('/files/privacy', { path: folder, enabled: state.enabled, ...(state.enabled ? { realm: state.realm.trim() } : {}) });
      setProbe(res.probe);
      toast.success(res.protected ? fill(t('panel.files.dp_now_protected', '~/{folder} now asks for a password'), { folder }) : fill(t('panel.files.dp_now_open', '~/{folder} is open again'), { folder }));
      refetch();
    } catch (err) { setSaveError(err); } finally { setSaving(false); }
  };

  const addUser = async (e) => {
    e.preventDefault();
    const problem = userProblem(newUser.user, newUser.password);
    if (problem) { setUserError({ message: t('panel.files.dp_check_user', 'Check the user'), fields: problem }); return; }
    setAdding(true); setUserError(null);
    try {
      const { data: res } = await panelApi.post('/files/privacy/users', { path: folder, user: newUser.user, password: newUser.password });
      toast.success(res.replaced ? fill(t('panel.files.dp_password_replaced', 'Password of {user} replaced'), { user: res.user }) : fill(t('panel.files.dp_user_added', '{user} can now sign in'), { user: res.user }));
      setNewUser({ user: '', password: '' });
      refetch();
    } catch (err) { setUserError(err); } finally { setAdding(false); }
  };

  const removeUser = async (row) => {
    const ok = await confirm({ title: fill(t('panel.files.dp_remove_user_title', 'Remove {user}?'), { user: row.user }), message: t('panel.files.dp_remove_user_help', 'They can no longer open the protected folder.'), confirmLabel: t('panel.files.dp_remove_user', 'Remove user'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/files/privacy/users?${new URLSearchParams({ path: folder, user: row.user })}`); toast.success(fill(t('panel.files.dp_user_removed', '{user} removed'), { user: row.user })); refetch(); } catch (err) { toast.error(err); }
  };

  const probeText = probe && (probe.status
    ? `${fill(t('panel.files.probe_answered', 'Checked: the folder answered {status}'), { status: probe.status })}${probe.status === 401 ? ` ${t('panel.files.probe_signin_prompt', '(sign-in prompt)')}` : ''}`
    : `${t('panel.files.probe_failed', 'The folder could not be probed')}${probe.error ? ` (${probe.error})` : ''}`);

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>{t('panel.files.refresh', 'Refresh')}</Button>}>
      <Card title={t('panel.files.folder', 'Folder')} subtitle={t('panel.files.dp_folder_help', 'Protection covers the folder and everything below it.')}>
        <FolderPicker value={folder} onChange={(p) => setParams({ path: p })} />
        {data && (
          <KeyValue items={[
            [t('panel.files.folder', 'Folder'), <code key="f">~/{data.path}</code>],
            [t('panel.files.served_as', 'Served as'), data.domain],
            [t('panel.files.status', 'Status'), <StatusPill key="s" status={data.protected ? 'ok' : 'unknown'}>{data.protected ? t('panel.files.dp_password_required', 'Password required') : t('panel.files.dp_open_to_everyone', 'Open to everyone')}</StatusPill>],
          ]} />
        )}
      </Card>

      {capability && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}
      {!capability && error && <Card><RequestError error={error} onRetry={refetch} />{error.status === 422 && <p className="muted">{t('panel.files.choose_folder_inside', 'Choose a folder inside')} <code>public_html</code> {t('panel.files.or_addon_folders', 'or one of your addon or subdomain folders.')}</p>}</Card>}

      {!error && (
        <div className="grid-2">
          <Card title={t('panel.files.dp_protection', 'Protection')} subtitle={t('panel.files.dp_protection_help', 'Browsers show the name you give here in their sign-in prompt.')}>
            <Toggle checked={state.enabled} onChange={(v) => setDraft({ ...state, enabled: v })} label={t('panel.files.dp_ask_for_password', 'Ask for a username and password')} description={state.enabled && !users.length ? t('panel.files.dp_add_user_first', 'Add at least one user below or nobody can get in.') : undefined} disabled={!data} />
            <Field label={t('panel.files.dp_realm', 'Name shown in the prompt')} error={realmBad ? [t('panel.files.dp_realm_rule', 'Letters, digits, spaces and . _ ( ) \' -; up to 64 characters')] : undefined} htmlFor="dp-realm">
              <TextInput id="dp-realm" value={state.realm} onChange={(v) => setDraft({ ...state, realm: v })} disabled={!data || !state.enabled} maxLength={64} />
            </Field>
            {saveError && <RequestError error={saveError} />}
            <FormActions>
              <Button variant="primary" icon={Lock} loading={saving} disabled={!dirty || realmBad || loading} onClick={save}>{t('panel.files.save', 'Save')}</Button>
              <Button disabled={!dirty || saving} onClick={() => setDraft(null)}>{t('panel.files.reset', 'Reset')}</Button>
              {probe && <span className="muted small">{probeText}</span>}
            </FormActions>
          </Card>
          <form onSubmit={addUser}>
            <Card title={t('panel.files.dp_add_user_title', 'Add a user')} subtitle={t('panel.files.dp_add_user_help', 'Users belong to this folder; an existing name gets the new password.')}>
              <RequestError error={userError} />
              <Field label={t('panel.files.username', 'Username')} required error={userError?.fields?.user} htmlFor="dp-user">
                <TextInput id="dp-user" value={newUser.user} onChange={(v) => setNewUser({ ...newUser, user: v })} autoComplete="off" spellCheck={false} disabled={!data} />
              </Field>
              <Field label={t('panel.files.password', 'Password')} required error={userError?.fields?.password} htmlFor="dp-password">
                <PasswordInput id="dp-password" value={newUser.password} onChange={(v) => setNewUser({ ...newUser, password: v })} autoComplete="new-password" disabled={!data} />
              </Field>
              <FormActions>
                <Button type="submit" variant="primary" icon={UserPlus} loading={adding} disabled={adding || !data || !newUser.user || !newUser.password}>{t('panel.files.dp_add_user', 'Add user')}</Button>
              </FormActions>
            </Card>
          </form>
        </div>
      )}

      {!error && (
        <Card title={t('panel.files.dp_users', 'Users')} subtitle={users.length ? fill(t('panel.files.dp_users_count', '{count} of {max} users'), { count: users.length, max: data?.max || 200 }) : undefined} padded={false}>
          <DataTable
            columns={[{ key: 'user', label: t('panel.files.username', 'Username'), render: (r) => <code>{r.user}</code> }]}
            rows={users} loading={loading} error={null} rowKey={(r) => r.user} dense
            rowActions={(r) => [{ label: t('panel.files.remove', 'Remove'), danger: true, primary: true, onClick: () => removeUser(r) }]}
            emptyText={t('panel.files.dp_no_users', 'No users yet. Add one above; passwords are stored hashed outside the website folder.')}
          />
        </Card>
      )}
      <p className="muted small"><KeyRound size={12} /> {t('panel.files.dp_rules_in', 'Rules go in')} <code>~/{folder}/.htaccess</code> {t('panel.files.dp_between_markers', 'between the panel\'s markers; passwords in')} <code>~/.keel/htpasswd/</code>{t('panel.files.dp_never_inside', ', never inside the website. See the folder in the')} <Link to={managerHref(folder)}>{t('panel.files.file_manager_link', 'file manager')}</Link>.</p>
    </PanelPage>
  );
}
