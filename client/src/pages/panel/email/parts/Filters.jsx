import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card, StatusPill, EmptyState } from '../../../../components/Common.jsx';
import { DataTable } from '../../../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, Textarea } from '../../../../components/Form.jsx';
import { Modal, useConfirm } from '../../../../components/Modal.jsx';
import { useToast } from '../../../../components/Toast.jsx';
import { PanelPage } from '../../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, InfoNote, fieldError, isFeatureDisabled, useEmailT, tr } from './Shared.jsx';

// Mail filters, shared by the per-mailbox and the account-wide page: the list
// of a scope with its order, the rule builder and the "Test" compile. The API
// renders the Sieve script; the pages only ever send structured rules.

export const HEADER_OPTIONS = [
  { value: 'from', label: 'From' }, { value: 'to', label: 'To' }, { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Body' }, { value: 'any_header', label: 'Any header' }, { value: 'custom', label: 'Other header…' },
];
export const OP_OPTIONS = [
  { value: 'contains', label: 'contains' }, { value: 'not_contains', label: 'does not contain' },
  { value: 'is', label: 'is exactly' }, { value: 'matches', label: 'matches (* and ? wildcards)' },
];
export const ACTION_OPTIONS = [
  { value: 'fileinto', label: 'Deliver to folder' }, { value: 'redirect', label: 'Redirect to address' },
  { value: 'discard', label: 'Discard the message' }, { value: 'stop', label: 'Stop processing further filters' },
];
const localized = (options, prefix) => options.map((o) => ({ ...o, label: tr(`panel.email.filters.${prefix}_${o.value}`, o.label) }));
const label = (options, prefix, value) => { const o = options.find((x) => x.value === value); return o ? tr(`panel.email.filters.${prefix}_${o.value}`, o.label) : value; };

export function describeMatch(m) {
  const field = m.header === 'custom' ? (m.name || tr('panel.email.filters.header_fallback', 'header')) : label(HEADER_OPTIONS, 'header', m.header);
  return `${field} ${label(OP_OPTIONS, 'op', m.op)} "${m.value}"`;
}

export function describeAction(a) {
  if (a.type === 'fileinto') return tr('panel.email.filters.describe_fileinto', 'deliver to {folder}', { folder: a.folder });
  if (a.type === 'redirect') return tr('panel.email.filters.describe_redirect', 'redirect to {address}', { address: a.address });
  if (a.type === 'discard') return tr('panel.email.filters.describe_discard', 'discard');
  return tr('panel.email.filters.describe_stop', 'stop');
}

export function describeFilter(rules) {
  const match = (rules?.match || []).map(describeMatch).join(rules?.matchAll === false ? ` ${tr('panel.email.common.or', 'or')} ` : ` ${tr('panel.email.common.and', 'and')} `);
  const actions = (rules?.actions || []).map(describeAction).join(', ');
  return `${match || tr('panel.email.filters.every_message', 'every message')} → ${actions || tr('panel.email.filters.nothing', 'nothing')}`;
}

const emptyMatch = () => ({ header: 'subject', op: 'contains', value: '' });
const emptyAction = (folder = 'Junk') => ({ type: 'fileinto', folder });

// What the form sends: only the fields each entry needs.
export function rulesFromForm({ matchAll, match, actions }) {
  return {
    matchAll,
    match: match.map((m) => ({ header: m.header, op: m.op, value: m.value.trim(), ...(m.header === 'custom' ? { name: (m.name || '').trim() } : {}) })),
    actions: actions.map((a) => ({ type: a.type, ...(a.type === 'fileinto' ? { folder: (a.folder || '').trim() } : {}), ...(a.type === 'redirect' ? { address: (a.address || '').trim() } : {}) })),
  };
}

export function formComplete({ match, actions }) {
  return match.length > 0 && actions.length > 0
    && match.every((m) => m.value.trim() && (m.header !== 'custom' || (m.name || '').trim()))
    && actions.every((a) => (a.type !== 'fileinto' || (a.folder || '').trim()) && (a.type !== 'redirect' || (a.address || '').trim()));
}

export function FilterForm({ existing, folders = [], onSubmit, onTest, onCancel, busy, error, testResult }) {
  const { t } = useEmailT();
  const [name, setName] = useState(existing?.name || '');
  const [matchAll, setMatchAll] = useState(existing ? existing.rules.matchAll !== false : true);
  const [match, setMatch] = useState(existing?.rules.match?.length ? existing.rules.match.map((m) => ({ ...m })) : [emptyMatch()]);
  const [actions, setActions] = useState(existing?.rules.actions?.length ? existing.rules.actions.map((a) => ({ ...a })) : [emptyAction(folders[1] || 'Junk')]);
  const [enabled, setEnabled] = useState(existing ? existing.enabled : true);
  const patchMatch = (i, patch) => setMatch((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const patchAction = (i, patch) => setActions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const payload = () => ({ name: name.trim(), rules: rulesFromForm({ matchAll, match, actions }), enabled });
  const complete = name.trim() && formComplete({ match, actions });
  const submit = (e) => { e.preventDefault(); onSubmit(payload()); };
  const folderOptions = folders.map((f) => ({ value: f, label: f }));
  return (
    <form onSubmit={submit}>
      <MutationError error={error} />
      <Field label={t('panel.email.filters.name', 'Name')} required error={fieldError(error, 'name')} help={t('panel.email.filters.name_help', 'Shown in the list; it does not affect matching.')}>
        <TextInput value={name} onChange={setName} placeholder={t('panel.email.filters.name_placeholder', 'Newsletters to Archive')} maxLength={80} autoFocus aria-label={t('panel.email.filters.filter_name', 'Filter name')} />
      </Field>
      <Field label={t('panel.email.filters.conditions', 'Conditions')} error={fieldError(error, 'rules')} help={match.length > 1 ? t('panel.email.filters.conditions_help', 'Which conditions must hold for the actions to run.') : undefined}>
        {match.length > 1 && (
          <Select value={matchAll ? 'all' : 'any'} onChange={(v) => setMatchAll(v === 'all')} options={[{ value: 'all', label: t('panel.email.filters.match_all', 'All conditions must match') }, { value: 'any', label: t('panel.email.filters.match_any', 'Any condition may match') }]} aria-label={t('panel.email.filters.condition_mode', 'Condition mode')} />
        )}
        {match.map((m, i) => (
          <div className="input-group" key={i} style={{ marginTop: 6 }}>
            <Select value={m.header} onChange={(v) => patchMatch(i, { header: v })} options={localized(HEADER_OPTIONS, 'header')} aria-label={t('panel.email.filters.field', 'Field')} />
            {m.header === 'custom' && <TextInput value={m.name || ''} onChange={(v) => patchMatch(i, { name: v })} placeholder="X-Priority" maxLength={64} aria-label={t('panel.email.filters.header_name', 'Header name')} />}
            <Select value={m.op} onChange={(v) => patchMatch(i, { op: v })} options={localized(OP_OPTIONS, 'op')} aria-label={t('panel.email.filters.operator', 'Operator')} />
            <TextInput value={m.value} onChange={(v) => patchMatch(i, { value: v })} placeholder={t('panel.email.filters.value_placeholder', 'text to look for')} maxLength={998} aria-label={t('panel.email.filters.value', 'Value')} />
            <Button icon={Trash2} aria-label={t('panel.email.filters.remove_condition', 'Remove condition')} onClick={() => setMatch((rows) => rows.filter((_, j) => j !== i))} disabled={match.length <= 1} />
          </div>
        ))}
        <div style={{ marginTop: 6 }}><Button size="sm" icon={Plus} onClick={() => setMatch((rows) => [...rows, emptyMatch()])} disabled={match.length >= 10}>{t('panel.email.filters.add_condition', 'Add condition')}</Button></div>
      </Field>
      <Field label={t('panel.email.filters.actions', 'Actions')} help={t('panel.email.filters.actions_help', 'Run in order. Delivery to a folder creates the folder when it is missing.')}>
        {actions.map((a, i) => (
          <div className="input-group" key={i} style={{ marginTop: 6 }}>
            <Select value={a.type} onChange={(v) => patchAction(i, { type: v })} options={localized(ACTION_OPTIONS, 'action')} aria-label={t('panel.email.filters.action', 'Action')} />
            {a.type === 'fileinto' && (
              folderOptions.some((o) => o.value === a.folder) || !a.folder
                ? <Select value={a.folder || ''} onChange={(v) => patchAction(i, { folder: v === '__other' ? 'Folder' : v })} options={[...folderOptions, { value: '__other', label: t('panel.email.filters.another_folder', 'Another folder…') }]} aria-label={t('panel.email.usage.folder', 'Folder')} placeholder={t('panel.email.filters.choose_folder', 'Choose a folder')} />
                : <TextInput value={a.folder} onChange={(v) => patchAction(i, { folder: v })} placeholder={t('panel.email.filters.folder_name', 'Folder name')} maxLength={200} aria-label={t('panel.email.filters.folder_name', 'Folder name')} />
            )}
            {a.type === 'redirect' && <TextInput value={a.address || ''} onChange={(v) => patchAction(i, { address: v })} placeholder="someone@example.com" maxLength={254} aria-label={t('panel.email.filters.redirect_address', 'Redirect address')} />}
            <Button icon={Trash2} aria-label={t('panel.email.filters.remove_action', 'Remove action')} onClick={() => setActions((rows) => rows.filter((_, j) => j !== i))} disabled={actions.length <= 1} />
          </div>
        ))}
        <div style={{ marginTop: 6 }}><Button size="sm" icon={Plus} onClick={() => setActions((rows) => [...rows, { type: 'stop' }])} disabled={actions.length >= 5}>{t('panel.email.filters.add_action', 'Add action')}</Button></div>
      </Field>
      <Toggle checked={enabled} onChange={setEnabled} label={t('panel.email.common.enabled', 'Enabled')} description={t('panel.email.filters.enabled_help', 'Switch off to keep the rule without applying it.')} />
      {testResult && (
        <div className={`banner ${testResult.ok ? 'banner-info' : 'banner-warning'}`} role="status">
          <div>
            <strong>{testResult.ok ? t('panel.email.filters.compiles', 'The filter compiles') : t('panel.email.filters.not_compiles', 'The filter does not compile')}</strong>
            {testResult.errors?.map((e, i) => <p key={i}>{e.line ? `${t('panel.email.filters.line', 'Line {line}', { line: e.line })}: ` : ''}{e.message}</p>)}
            {testResult.script && <Textarea value={testResult.script} onChange={() => {}} readOnly rows={6} mono aria-label={t('panel.email.filters.sieve_script', 'Sieve script')} />}
          </div>
        </div>
      )}
      <FormActions align="right">
        <Button onClick={onCancel}>{t('panel.email.common.cancel', 'Cancel')}</Button>
        {onTest && <Button onClick={() => onTest(payload())} disabled={!complete || busy}>{t('panel.email.filters.test', 'Test')}</Button>}
        <Button type="submit" variant="primary" loading={busy} disabled={!complete}>{existing ? t('panel.email.common.save_changes', 'Save changes') : t('panel.email.filters.create', 'Create filter')}</Button>
      </FormActions>
    </form>
  );
}

// `base` is '/email/filters' or '/email/global-filters'; `qs` carries the
// mailbox for the per-mailbox scope ('?mailbox=3') and is empty otherwise.
export function FiltersPanel({ fn, base, qs = '', intro = null, children }) {
  const { t } = useEmailT();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, meta, error, loading, refetch } = usePanelApi(`${base}${qs}`);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [showScript, setShowScript] = useState(false);
  const close = () => { setDialog(null); setMutationError(null); setTestResult(null); };
  const rows = data || [];

  const save = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      if (dialog.row) await panelApi.put(`${base}/${dialog.row.id}`, body); else await panelApi.post(`${base}${qs}`, body);
      toast.success(dialog.row ? t('panel.email.filters.toast_saved', 'Filter "{name}" saved', { name: body.name }) : t('panel.email.filters.toast_created', 'Filter "{name}" created', { name: body.name }));
      close(); refetch();
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const test = async (body) => {
    setBusy(true); setMutationError(null); setTestResult(null);
    try { const res = await panelApi.post(`${base}/test${qs}`, { name: body.name || undefined, rules: body.rules }); setTestResult(res.data); } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };

  const toggle = async (row) => {
    try { await panelApi.put(`${base}/${row.id}`, { enabled: !row.enabled }); toast.success(row.enabled ? t('panel.email.filters.toast_disabled', '{name} disabled', { name: row.name }) : t('panel.email.filters.toast_enabled', '{name} enabled', { name: row.name })); refetch(); } catch (err) { toast.error(err); }
  };

  const remove = async (row) => {
    if (!(await confirm({ title: t('panel.email.filters.delete_title', 'Delete the filter "{name}"?', { name: row.name }), message: t('panel.email.filters.delete_text', 'Mail that matched it is delivered normally from now on.'), confirmLabel: t('panel.email.common.delete', 'Delete'), danger: true }))) return;
    try { await panelApi.delete(`${base}/${row.id}`); toast.success(t('panel.email.filters.toast_deleted', 'Filter deleted')); refetch(); } catch (err) { toast.error(err); }
  };

  const move = async (row, delta) => {
    const ids = rows.map((r) => r.id);
    const i = ids.indexOf(row.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await panelApi.post(`${base}/reorder${qs}`, { ids }); refetch(); } catch (err) { toast.error(err); }
  };

  const featureOff = isFeatureDisabled(error);
  const atMax = meta?.max != null && rows.length >= meta.max;
  return (
    <PanelPage fn={fn} actions={!featureOff && !error && <Button variant="primary" icon={Plus} onClick={() => { setMutationError(null); setTestResult(null); setDialog({ row: null }); }} disabled={atMax || loading}>{t('panel.email.filters.create', 'Create filter')}</Button>}>
      {children}
      {featureOff ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          {intro}
          {meta?.sieve && meta.sieve.available === false && <InfoNote>{t('panel.email.filters.no_sieve_1', 'Filters are saved but cannot be applied on this server yet: the mail server lacks Sieve support')} (<code>dovecot-sieve</code>). {t('panel.email.common.ask_your_hosting_provider', 'Ask your hosting provider.')}</InfoNote>}
          <Card padded={false}>
            <PanelRequestError error={error} fn={fn} onRetry={refetch} />
            {!error && (
              <DataTable
                columns={[
                  { key: 'position', label: '#', width: 48, render: (r) => rows.indexOf(r) + 1 },
                  { key: 'name', label: t('panel.email.filters.filter', 'Filter'), render: (r) => <><div>{r.name}</div><div className="muted">{describeFilter(r.rules)}</div></> },
                  { key: 'enabled', label: t('panel.email.common.status', 'Status'), render: (r) => <StatusPill status={r.enabled ? 'ok' : 'disabled'}>{r.enabled ? t('panel.email.common.enabled', 'Enabled') : t('panel.email.common.disabled', 'Disabled')}</StatusPill> },
                ]}
                rows={rows} loading={loading}
                emptyText={t('panel.email.filters.empty', 'No filters yet. A filter looks at the sender, subject, headers or body of every incoming message and files, forwards or discards it; filters run in the order listed.')}
                rowActions={(r) => [
                  { label: t('panel.email.common.edit', 'Edit'), primary: true, onClick: () => { setMutationError(null); setTestResult(null); setDialog({ row: r }); } },
                  { label: r.enabled ? t('panel.email.common.disable', 'Disable') : t('panel.email.common.enable', 'Enable'), onClick: () => toggle(r) },
                  { label: t('panel.email.filters.move_up', 'Move up'), onClick: () => move(r, -1), disabled: rows.indexOf(r) === 0 },
                  { label: t('panel.email.filters.move_down', 'Move down'), onClick: () => move(r, 1), disabled: rows.indexOf(r) === rows.length - 1 },
                  { label: t('panel.email.common.delete', 'Delete'), danger: true, onClick: () => remove(r) },
                ]}
              />
            )}
          </Card>
          {!error && rows.length > 0 && (
            <Card title={t('panel.email.filters.script_title', 'Generated script')} subtitle={t('panel.email.filters.script_subtitle', 'The Sieve script the mail server runs for this scope.')} actions={<Button size="sm" onClick={() => setShowScript((v) => !v)}>{showScript ? t('panel.email.common.hide', 'Hide') : t('panel.email.common.show', 'Show')}</Button>}>
              {showScript ? <Textarea value={meta?.script || ''} onChange={() => {}} readOnly rows={10} mono aria-label={t('panel.email.filters.sieve_script', 'Sieve script')} /> : <p className="muted">{t('panel.email.filters.enabled_count', '{enabled} of {total} filters enabled', { enabled: rows.filter((r) => r.enabled).length, total: rows.length })}{meta?.max != null ? `, ${t('panel.email.filters.allowed_count', '{max} allowed', { max: meta.max })}` : ''}.</p>}
            </Card>
          )}
          {!error && !loading && rows.length === 0 && meta?.scope === 'account' && (
            <EmptyState title={t('panel.email.global_filters.empty_title', "Account-wide filters run before each mailbox's own filters")}>{t('panel.email.global_filters.empty_text', "Use them for rules every address on this account shares, such as discarding mail from a sender or filing a project's messages.")}</EmptyState>
          )}
        </>
      )}
      <Modal open={Boolean(dialog)} title={dialog?.row ? t('panel.email.filters.edit_title', 'Edit filter "{name}"', { name: dialog.row.name }) : t('panel.email.filters.create', 'Create filter')} onClose={close} size="lg">
        {dialog && <FilterForm existing={dialog.row} folders={meta?.folders || []} onSubmit={save} onTest={test} onCancel={close} busy={busy} error={mutationError} testResult={testResult} />}
      </Modal>
    </PanelPage>
  );
}
