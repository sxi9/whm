import { useEffect, useMemo, useState } from 'react';
import { Loading } from '../../../../components/Common.jsx';
import { Button } from '../../../../components/Form.jsx';
import { Modal } from '../../../../components/Modal.jsx';
import { useT } from '../../../../i18n/useT.js';
import { fill } from '../../../../i18n/fill.js';
import { PanelCapabilityState } from '../../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../../panel/hooks/usePanel.js';
import { PRIVILEGES, PG_PRIVILEGES, RequestError, joinCodes } from './shared.jsx';

// Pure: the grant list the editor holds as { database: Set(privileges) }, the
// account's databases first (none → no access), then databases only the server
// still knows about.
export function buildMatrix(grants, databases) {
  const map = new Map();
  for (const d of databases || []) map.set(d, new Set());
  for (const g of grants || []) map.set(g.database, new Set(g.privileges || []));
  return map;
}

export function togglePrivilege(set, privilege, all) {
  const next = new Set(set);
  if (privilege === 'ALL PRIVILEGES') return next.has('ALL PRIVILEGES') ? new Set() : new Set(['ALL PRIVILEGES']);
  next.delete('ALL PRIVILEGES');
  if (next.has(privilege)) next.delete(privilege); else next.add(privilege);
  if (all.every((p) => p === 'ALL PRIVILEGES' || next.has(p))) return new Set(['ALL PRIVILEGES']);
  return next;
}

export function toPayload(matrix) {
  return [...matrix.entries()].filter(([, set]) => set.size > 0).map(([database, set]) => ({ database, privileges: [...set] }));
}

// Checkbox grid: one column per database, one row per privilege; the first row
// grants everything on that database and greys out the rest.
export function PrivilegeGrid({ matrix, privileges, onChange, disabled }) {
  const { t } = useT();
  const databases = [...matrix.keys()];
  if (!databases.length) return <p className="muted">{t('panel.databases.grid_no_databases', 'This account has no databases yet, so there is nothing to grant. Create one under Databases first.')}</p>;
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead>
          <tr>
            <th>{t('panel.databases.col_privilege', 'Privilege')}</th>
            {databases.map((d) => <th key={d} className="align-right"><code>{d}</code></th>)}
          </tr>
        </thead>
        <tbody>
          {privileges.map((p) => (
            <tr key={p}>
              <td>{p === 'ALL PRIVILEGES' ? <strong>{t('panel.databases.all_privileges', 'All privileges')}</strong> : p}</td>
              {databases.map((d) => {
                const set = matrix.get(d);
                const all = set.has('ALL PRIVILEGES');
                const checked = all || set.has(p);
                return (
                  <td key={d} className="align-right">
                    <input type="checkbox" aria-label={fill(t('panel.databases.privilege_on', '{privilege} on {database}'), { privilege: p, database: d })} checked={checked} disabled={disabled || (all && p !== 'ALL PRIVILEGES')} onChange={() => onChange(d, togglePrivilege(set, p, privileges))} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GrantsModal({ user, databases, engine, onClose, onSaved }) {
  const { t } = useT();
  const path = user ? `/databases/users/${encodeURIComponent(user.name)}/grants` : null;
  const { data: current, loading, error } = usePanelApi(path, { enabled: Boolean(user) });
  const [matrix, setMatrix] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => { if (current) setMatrix(buildMatrix(current.grants, databases)); }, [current, databases]);
  const privileges = useMemo(() => current?.privileges || (engine === 'postgres' ? PG_PRIVILEGES : PRIVILEGES), [current, engine]);
  const change = (database, set) => setMatrix((m) => { const next = new Map(m); next.set(database, set); return next; });
  const clearAll = () => setMatrix((m) => new Map([...m.keys()].map((d) => [d, new Set()])));

  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      const { data } = await panelApi.put(path, { grants: toPayload(matrix) });
      onSaved?.(data);
      onClose();
    } catch (err) { setSaveError(err); } finally { setBusy(false); }
  };

  return (
    <Modal open={Boolean(user)} title={user ? fill(t('panel.databases.privileges_of', 'Privileges of {name}'), { name: user.name }) : ''} onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>{t('common.cancel', 'Cancel')}</Button><Button variant="ghost" onClick={clearAll} disabled={loading || busy}>{t('panel.databases.remove_all_access', 'Remove all access')}</Button><Button variant="primary" loading={busy} onClick={save} disabled={loading || Boolean(error)}>{t('panel.databases.save_privileges', 'Save privileges')}</Button></>}>
      {loading && !current && <Loading text={t('panel.databases.loading_privileges', 'Loading privileges…')} />}
      <PanelCapabilityState error={error} />
      <RequestError error={error} />
      <PanelCapabilityState error={saveError} />
      <RequestError error={saveError} />
      {current && (
        <>
          <p className="muted">{t('panel.databases.grid_help_before', 'Tick what')} <code>{user.name}</code> {t('panel.databases.grid_help_after', 'may do on each database. A database with nothing ticked is not accessible to this user.')}{current.hosts?.length > 0 && <> {t('panel.databases.applied_at', 'Applied at')} {joinCodes(current.hosts)}.</>}</p>
          <PrivilegeGrid matrix={matrix} privileges={privileges} onChange={change} disabled={busy} />
        </>
      )}
    </Modal>
  );
}
