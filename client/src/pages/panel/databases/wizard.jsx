import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Plus, RotateCcw } from 'lucide-react';
import { Card, KeyValue } from '../../../components/Common.jsx';
import { Field, Select, PasswordInput, Button, FormActions, passwordStrength } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useT } from '../../../i18n/useT.js';
import { fill, plural } from '../../../i18n/fill.js';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { NameField, RequestError, InfoNote, PRIVILEGES, PG_PRIVILEGES, isCapabilityError, isFeatureDisabled } from './parts/shared.jsx';
import { PrivilegeGrid, toPayload } from './parts/GrantsEditor.jsx';
import { quotaOf } from './databases.jsx';

const MIN_STRENGTH = 65;
export const STEPS = ['database', 'user', 'grants'];

// 'done' | 'current' | 'pending' for the step indicator; the finished page (step
// index = STEPS.length) marks every step done.
export function stepState(step, index) {
  if (index < step) return 'done';
  return index === step ? 'current' : 'pending';
}

// The matrix the grid edits on step 3: the one database of this run, with all
// privileges ticked by default (what the users page grants on creation).
export function initialMatrix(database) {
  return new Map([[database, new Set(['ALL PRIVILEGES'])]]);
}

export function summarizePrivileges(set, t) {
  const list = [...(set || [])];
  if (!list.length) return t('panel.databases.wizard_no_access', 'no access');
  if (list.includes('ALL PRIVILEGES')) return t('panel.databases.all_privileges_lower', 'all privileges');
  return list.map((p) => p.toLowerCase()).join(', ');
}

function StepList({ step }) {
  const { t } = useT();
  const labels = [t('panel.databases.wizard_step_database', 'Database'), t('panel.databases.wizard_step_user', 'User'), t('panel.databases.wizard_step_grants', 'Privileges')];
  const tone = { done: 'pill-ok', current: 'pill-info', pending: 'pill-muted' };
  return (
    <ol className="list-plain" aria-label={t('panel.databases.wizard_steps', 'Steps')} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: 0 }}>
      {labels.map((label, i) => {
        const state = stepState(step, i);
        return (
          <li key={label} aria-current={state === 'current' ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`pill ${tone[state]}`}>{state === 'done' ? <Check size={12} /> : i + 1} {label}</span>
            {i < labels.length - 1 && <ChevronRight size={14} className="muted" />}
          </li>
        );
      })}
    </ol>
  );
}

export default function DatabaseWizard({ fn }) {
  const toast = useToast();
  const { t } = useT();
  const { me } = usePanelMe();
  const { meta, error, refetch } = usePanelApi('/databases');
  const [step, setStep] = useState(0);
  const [db, setDb] = useState({ name: '', charset: '' });
  const [user, setUser] = useState({ name: '', password: '' });
  const [created, setCreated] = useState({ database: null, user: null, grants: null });
  const [matrix, setMatrix] = useState(() => new Map());
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const username = me?.account?.username || '';
  const prefix = meta?.prefix || `${username}_`;
  const engine = meta?.engine || 'mysql';
  const isPg = engine === 'postgres';
  const quota = quotaOf(meta, me);
  const notIncluded = quota.max === 0;
  const limitReached = quota.max != null && quota.used >= quota.max;
  // The server is missing: the state gets its own surface and step 1 stays visible but inert.
  const missing = isCapabilityError(error);
  const privileges = useMemo(() => (isPg ? PG_PRIVILEGES : PRIVILEGES), [isPg]);
  const charsets = [{ value: '', label: t('panel.databases.charset_default', 'Server default') }, { value: 'utf8mb4', label: t('panel.databases.charset_utf8mb4', 'utf8mb4 (recommended)') }, { value: 'utf8mb3', label: 'utf8mb3' }, { value: 'latin1', label: 'latin1' }];

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const createDatabase = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const body = { name: db.name.trim() };
      if (!isPg && db.charset) body.charset = db.charset;
      const { data: res } = await panelApi.post('/databases', body);
      toast.success(fill(t('panel.databases.created', 'Database {name} created'), { name: res.name }));
      setCreated((c) => ({ ...c, database: res.name }));
      setMatrix(initialMatrix(res.name));
      setUser((u) => ({ ...u, name: u.name || db.name.trim() }));
      setStep(1);
      refetch();
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const createUser = async (e) => {
    e.preventDefault();
    if (passwordStrength(user.password) < MIN_STRENGTH) { setFormError({ message: fill(t('panel.databases.password_weak', 'Choose a stronger password (minimum strength {min})'), { min: MIN_STRENGTH }), fields: { password: [t('panel.databases.password_too_weak', 'Too weak')] } }); return; }
    setBusy(true); setFormError(null);
    try {
      const { data: res } = await panelApi.post('/databases/users', { name: user.name.trim(), password: user.password });
      toast.success(fill(t('panel.databases.user_created', 'User {name} created'), { name: res.name }));
      setCreated((c) => ({ ...c, user: res.name }));
      setUser((u) => ({ ...u, password: '' }));
      setStep(2);
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const saveGrants = async (e) => {
    e.preventDefault();
    setBusy(true); setFormError(null);
    try {
      const grants = toPayload(matrix);
      const { data: res } = await panelApi.put(`/databases/users/${encodeURIComponent(created.user)}/grants`, { grants });
      toast.success(fill(t('panel.databases.privileges_saved', 'Privileges saved for {name}'), { name: res.name }) + (res.changes?.length ? ` (${plural(t, 'panel.databases.changes', res.changes.length, '{count} change', '{count} changes')})` : ''));
      setCreated((c) => ({ ...c, grants: grants[0]?.privileges || [] }));
      setStep(STEPS.length);
    } catch (err) { setFormError(err); } finally { setBusy(false); }
  };

  const restart = () => {
    setStep(0); setDb({ name: '', charset: '' }); setUser({ name: '', password: '' }); setCreated({ database: null, user: null, grants: null }); setMatrix(new Map()); setFormError(null);
  };

  const change = (database, set) => setMatrix((m) => { const next = new Map(m); next.set(database, set); return next; });
  const grantSet = created.database ? matrix.get(created.database) : null;

  return (
    <PanelPage fn={fn} actions={step > 0 && <Button icon={RotateCcw} onClick={restart}>{t('panel.databases.wizard_start_over', 'Start over')}</Button>}>
      <Card>
        <StepList step={step} />
        <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>{t('panel.databases.wizard_intro', 'Three steps: the database, a user that signs in to it, and what that user may do. Each step is saved as you go, so you can leave after any of them.')}</p>
      </Card>

      {missing && <Card><PanelCapabilityState error={error} onRetry={refetch} /></Card>}
      {isCapabilityError(formError) && <Card><PanelCapabilityState error={formError} /></Card>}
      <RequestError error={formError} />

      {step === 0 && (
        <form onSubmit={createDatabase}>
          <Card title={t('panel.databases.wizard_database_title', 'Step 1: Create a database')} subtitle={t('panel.databases.create_subtitle', 'Choose a short name; the prefix is added for you.')}>
            {limitReached && <InfoNote>{notIncluded ? t('panel.databases.plan_none', 'Your plan does not include databases. Ask your hosting provider about a plan that includes them.') : plural(t, 'panel.databases.plan_full', quota.max, 'Your plan allows {count} database and all of them are in use. Delete one you no longer need or ask your hosting provider about a larger plan.', 'Your plan allows {count} databases and all of them are in use. Delete one you no longer need or ask your hosting provider about a larger plan.')}</InfoNote>}
            <div className="form-grid">
              <NameField id="wiz-db-name" label={t('panel.databases.name', 'Database name')} prefix={prefix} value={db.name} onChange={(v) => setDb((f) => ({ ...f, name: v }))} placeholder="shop" maxLength={54} error={formError?.fields?.name} disabled={limitReached || missing} />
              {!isPg && (
                <Field label={t('panel.databases.charset', 'Character set')} help={t('panel.databases.charset_help', 'Leave the default unless your application asks for a specific one')} error={formError?.fields?.charset} htmlFor="wiz-db-charset">
                  <Select id="wiz-db-charset" value={db.charset} onChange={(v) => setDb((f) => ({ ...f, charset: v }))} options={charsets} disabled={limitReached || missing} />
                </Field>
              )}
            </div>
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !db.name || limitReached || missing}>{t('panel.databases.wizard_next_step', 'Next step')}</Button>
              {db.name && <span className="muted small">{t('panel.databases.creates', 'Creates')} <code>{prefix}{db.name}</code></span>}
            </FormActions>
          </Card>
        </form>
      )}

      {step === 1 && (
        <form onSubmit={createUser}>
          <Card title={t('panel.databases.wizard_user_title', 'Step 2: Create a database user')} subtitle={t('panel.databases.user_create_subtitle', 'Sites connect with a user, not with your account password.')}>
            <InfoNote>{t('panel.databases.wizard_database_ready', 'Database')} <code>{created.database}</code> {t('panel.databases.wizard_database_ready_after', 'is ready. The user you create here gets its privileges in the next step.')}</InfoNote>
            <div className="form-grid">
              <NameField id="wiz-user-name" label={t('panel.databases.user_name', 'User name')} prefix={prefix} value={user.name} onChange={(v) => setUser((f) => ({ ...f, name: v }))} placeholder="app" maxLength={22} error={formError?.fields?.name} />
              <Field label={t('panel.databases.password', 'Password')} required error={formError?.fields?.password} help={t('panel.databases.password_help', 'Use the generator; the password is shown only now')} htmlFor="wiz-user-password">
                <PasswordInput id="wiz-user-password" value={user.password} onChange={(v) => setUser((f) => ({ ...f, password: v }))} minStrength={MIN_STRENGTH} />
              </Field>
            </div>
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={busy || !user.name || !user.password}>{t('panel.databases.wizard_next_step', 'Next step')}</Button>
              <Link to="/panel/databases/users" className="muted small">{t('panel.databases.wizard_skip_user', 'Skip: use an existing user instead')}</Link>
            </FormActions>
          </Card>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={saveGrants}>
          <Card title={t('panel.databases.wizard_grants_title', 'Step 3: Privileges')} subtitle={fill(t('panel.databases.wizard_grants_subtitle', 'What {user} may do on {database}. All privileges is the usual choice for a site that owns its database.'), { user: created.user, database: created.database })}>
            <PrivilegeGrid matrix={matrix} privileges={privileges} onChange={change} disabled={busy} />
            <FormActions>
              <Button type="submit" variant="primary" icon={Check} loading={busy} disabled={busy}>{grantSet?.size ? t('panel.databases.wizard_finish', 'Save privileges and finish') : t('panel.databases.wizard_finish_none', 'Finish without access')}</Button>
            </FormActions>
          </Card>
        </form>
      )}

      {step >= STEPS.length && (
        <Card title={t('panel.databases.wizard_done_title', 'All set')} subtitle={t('panel.databases.wizard_done_subtitle', 'Use these details in the configuration of your site.')}>
          <KeyValue items={[
            [t('panel.databases.col_database', 'Database'), <code>{created.database}</code>],
            [t('panel.databases.col_user', 'User'), <code>{created.user}</code>],
            [t('panel.databases.wizard_host', 'Host'), <code>localhost</code>],
            [t('panel.databases.col_access', 'Access'), summarizePrivileges(new Set(created.grants || []), t)],
          ]} />
          <p className="muted">{t('panel.databases.wizard_password_note', 'The password is the one you chose in step 2; it is not shown again. Change it under Database users if you lose it.')}</p>
          <FormActions>
            <Button variant="primary" icon={RotateCcw} onClick={restart}>{t('panel.databases.wizard_another', 'Create another')}</Button>
            <Link to="/panel/databases/databases">{t('panel.databases/databases.label', 'Databases')}</Link>
            <Link to="/panel/databases/users">{t('panel.databases/users.label', 'Database users')}</Link>
          </FormActions>
        </Card>
      )}
    </PanelPage>
  );
}
