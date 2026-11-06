import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus } from 'lucide-react';
import { Card, StatusPill } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural, untranslated } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { NameField, RequestError, InfoNote, isCapabilityError, isFeatureDisabled, joinCodes } from './parts/shared.jsx';
import { GrantsModal } from './parts/GrantsEditor.jsx';

const MIN_STRENGTH = 65;

export function summarizeGrants(grants, t = untranslated) {
  if (!grants?.length) return null;
  return grants.map((g) => ({ database: g.database, text: g.privileges?.includes('ALL PRIVILEGES') ? t('panel.databases.all_privileges_lower', 'all privileges') : (g.privileges || []).map((p) => p.toLowerCase()).join(', ') }));
}

export function filterUsers(rows, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.grants || []).some((g) => g.database.toLowerCase().includes(needle)));
}

export default function DatabaseUsers({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const { me } = usePanelMe();
  const { data, meta, loading, error, refetch } = usePanelApi('/databases/users');
  const dbs = usePanelApi('/databases');
  const [form, setForm] = useState({ name: '', password: '', databases: [] });
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [grantsFor, setGrantsFor] = useState(null);
  const [pwFor, setPwFor] = useState(null);
  const [pw, setPw] = useState('');
  const [pwError, setPwError] = useState(null);
  const username = me?.account?.username || '';
  const prefix = meta?.prefix || `${username}_`;
  const engine = meta?.engine || 'mysql';
  const isPg = engine === 'postgres';
  const databases = useMemo(() => (dbs.data || []).map((d) => d.name), [dbs.data]);
  const rows = useMemo(() => filterUsers(data || [], q), [data, q]);
  const capability = isCapabilityError(error);
  // Nothing can be created while the database server is missing: the state is
  // said once at the top and the form below it is disabled.
  const blocked = capability || isCapabilityError(dbs.error);
  const weak = () => ({ message: fill(t('panel.databases.password_weak', 'Choose a stronger password (minimum strength {min})'), { min: MIN_STRENGTH }), fields: { password: [t('panel.databases.password_too_weak', 'Too weak')] } });

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const toggleDb = (name) => setForm((f) => ({ ...f, databases: f.databases.includes(name) ? f.databases.filter((d) => d !== name) : [...f.databases, name] }));

  const create = async (e) => {
    e.preventDefault();
    if (passwordStrength(form.password) < MIN_STRENGTH) { setFormError(weak()); return; }
    setBusy(true); setFormError(null);
    try {
      const body = { name: form.name.trim(), password: form.password };
      if (form.databases.length) body.databases = form.databases;
      const { data: res } = await panelApi.post('/databases/users', body);
      toast.success(fill(t('panel.databases.user_created', 'User {name} created'), { name: res.name }) + (res.grants?.length ? ` ${plural(t, 'panel.databases.user_created_access', res.grants.length, 'with access to {count} database', 'with access to {count} databases')}` : ''));
      setForm({ name: '', password: '', databases: [] });
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const drop = async (row) => {
    const ok = await confirm({ title: fill(t('panel.databases.user_delete_title', 'Delete user {name}?'), { name: row.name }), message: t('panel.databases.user_delete_message', 'The user and its privileges are removed. Websites and scripts that sign in with it will lose their database connection.'), confirmLabel: t('panel.databases.user_delete_confirm', 'Delete user'), danger: true });
    if (!ok) return;
    try { await panelApi.delete(`/databases/users/${encodeURIComponent(row.name)}`); toast.success(fill(t('panel.databases.deleted', '{name} deleted'), { name: row.name })); refetch(); } catch (err) { toast.error(err); }
  };

  const changePassword = async () => {
    if (passwordStrength(pw) < MIN_STRENGTH) { setPwError({ message: weak().message }); return; }
    setBusy(true); setPwError(null);
    try { await panelApi.put(`/databases/users/${encodeURIComponent(pwFor.name)}/password`, { password: pw }); toast.success(fill(t('panel.databases.password_changed', 'Password changed for {name}'), { name: pwFor.name })); setPwFor(null); setPw(''); } catch (err) { setPwError(err); } finally { setBusy(false); }
  };

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => { refetch(); dbs.refetch(); }}>{t('common.refresh', 'Refresh')}</Button>}>
      {blocked && <Card><PanelCapabilityState error={capability ? error : dbs.error} onRetry={() => { refetch(); dbs.refetch(); }} /></Card>}
      <form onSubmit={create}>
        <Card title={t('panel.databases.user_create_title', 'Create a database user')} subtitle={t('panel.databases.user_create_subtitle', 'Sites connect with a user, not with your account password.')}>
          <PanelCapabilityState error={isCapabilityError(formError) ? formError : null} />
          <RequestError error={formError} />
          <div className="form-grid">
            <NameField id="dbu-name" label={t('panel.databases.user_name', 'User name')} prefix={prefix} value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="app" maxLength={22} error={formError?.fields?.name} disabled={blocked} />
            <Field label={t('panel.databases.password', 'Password')} required error={formError?.fields?.password} help={t('panel.databases.password_help', 'Use the generator; the password is shown only now')} htmlFor="dbu-password">
              <PasswordInput id="dbu-password" value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} minStrength={MIN_STRENGTH} disabled={blocked} />
            </Field>
          </div>
          <Field label={t('panel.databases.give_access', 'Give access to')} help={databases.length ? t('panel.databases.give_access_help', 'All privileges on the ticked databases; fine-tune them afterwards with "Privileges"') : isCapabilityError(dbs.error) ? t('panel.databases.give_access_unavailable', 'The list of databases is unavailable while the database server is missing') : t('panel.databases.give_access_later', 'No databases yet; the user can be given access later')} error={formError?.fields?.databases}>
            {databases.length > 0 ? (
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px 20px' }}>
                {databases.map((d) => <label key={d} className="radio"><input type="checkbox" checked={form.databases.includes(d)} onChange={() => toggleDb(d)} /><span><strong><code>{d}</code></strong></span></label>)}
              </div>
            ) : <Link to="/panel/databases/databases">{t('panel.databases.create_title', 'Create a database')}</Link>}
          </Field>
          <FormActions><Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={blocked || !form.name || !form.password}>{t('panel.databases.user_create_button', 'Create user')}</Button></FormActions>
        </Card>
      </form>

      {!capability && <Card title={t('panel.databases.users_title', 'Database users')} subtitle={data?.length ? fill(t('panel.databases.count_on_account', '{count} on this account'), { count: data.length }) : undefined} padded={false}>
        <DataTable
          columns={[
            { key: 'name', label: t('panel.databases.col_user', 'User'), render: (r) => <code>{r.name}</code> },
            isPg ? null : { key: 'hosts', label: t('panel.databases.col_allowed_from', 'Allowed from'), render: (r) => joinCodes(r.hosts, 'localhost') },
            { key: 'grants', label: t('panel.databases.col_access', 'Access'), render: (r) => {
              const s = summarizeGrants(r.grants, t);
              return s ? s.map((g) => <div key={g.database}><code>{g.database}</code> <span className="muted">{g.text}</span></div>) : <StatusPill status="warning">{t('panel.databases.no_database_yet', 'no database yet')}</StatusPill>;
            } },
          ].filter(Boolean)}
          rows={rows} loading={loading} error={error} rowKey={(r) => r.name}
          searchable={Boolean(data?.length)} q={q} onSearch={setQ} searchPlaceholder={t('panel.databases.users_search', 'Search users or databases')}
          rowActions={(r) => [
            { label: t('panel.databases.privileges', 'Privileges'), primary: true, onClick: () => setGrantsFor(r) },
            { label: t('panel.databases.change_password', 'Change password'), onClick: () => { setPwFor(r); setPw(''); setPwError(null); } },
            { label: t('common.delete', 'Delete'), danger: true, onClick: () => drop(r) },
          ]}
          emptyText={q ? t('panel.databases.users_empty_search', 'No user matches the search.') : t('panel.databases.users_empty', 'No database users yet. Create one above and give it access to a database; it appears here with its privileges.')}
        />
      </Card>}

      {!capability && !isPg && <InfoNote>{t('panel.databases.users_localhost_before', 'Users connect from this server')} (<code>localhost</code>). {t('panel.databases.users_localhost_after', 'To connect from another computer, allow its address under')} <Link to="/panel/databases/remote-hosts">{t('panel.databases/remote-hosts.label', 'Remote hosts')}</Link>.</InfoNote>}

      <GrantsModal user={grantsFor} databases={databases} engine={engine} onClose={() => setGrantsFor(null)} onSaved={(res) => { toast.success(fill(t('panel.databases.privileges_saved', 'Privileges saved for {name}'), { name: res.name }) + (res.changes?.length ? ` (${plural(t, 'panel.databases.changes', res.changes.length, '{count} change', '{count} changes')})` : '')); refetch(); }} />

      <Modal open={Boolean(pwFor)} title={fill(t('panel.databases.change_password_of', 'Change password of {name}'), { name: pwFor?.name })} onClose={() => setPwFor(null)} size="sm" footer={<><Button onClick={() => setPwFor(null)}>{t('common.cancel', 'Cancel')}</Button><Button variant="primary" loading={busy} onClick={changePassword} disabled={!pw}>{t('panel.databases.change_password', 'Change password')}</Button></>}>
        <PanelCapabilityState error={pwError} />
        <RequestError error={pwError} />
        <Field label={t('panel.databases.new_password', 'New password')} required htmlFor="dbu-newpw"><PasswordInput id="dbu-newpw" value={pw} onChange={setPw} minStrength={MIN_STRENGTH} /></Field>
        <p className="muted">{t('panel.databases.password_after', 'Update the configuration of every site that signs in with this user afterwards.')}</p>
      </Modal>
    </PanelPage>
  );
}
