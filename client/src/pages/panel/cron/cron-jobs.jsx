import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Plus, Trash2, Mail, Clock, AlertTriangle, Info } from 'lucide-react';
import { Card, KeyValue } from '../../../components/Common.jsx';
import { DataTable } from '../../../components/DataTable.jsx';
import { Field, TextInput, Select, Toggle, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { useConfirm, Modal } from '../../../components/Modal.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, usePanelMe, panelApi } from '../../../panel/hooks/usePanel.js';
import { PANEL_FUNCTIONS } from '../../../panel/nav.js';

const USAGE_PATH = PANEL_FUNCTIONS.find((f) => f.key.startsWith('panel:usage/'))?.path || '/panel';

export const PRESETS = [
  { value: '* * * * *', label: 'Every minute' },
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '*/30 * * * *', label: 'Every 30 minutes' },
  { value: '0 * * * *', label: 'Once an hour' },
  { value: '0 0,12 * * *', label: 'Twice a day (00:00 and 12:00)' },
  { value: '0 0 * * *', label: 'Once a day (00:00)' },
  { value: '0 0 * * 0', label: 'Once a week (Sunday 00:00)' },
  { value: '0 0 1 * *', label: 'Once a month (1st, 00:00)' },
  { value: '0 0 1 1 *', label: 'Once a year (1 January, 00:00)' },
  { value: '@reboot', label: 'When the server starts' },
  { value: 'custom', label: 'Custom…' },
];
const ALIASES = { '@reboot': 'When the server starts', '@yearly': 'Once a year', '@annually': 'Once a year', '@monthly': 'Once a month', '@weekly': 'Once a week', '@daily': 'Once a day', '@midnight': 'Once a day', '@hourly': 'Once an hour' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FIELD_NAMES = ['minute', 'hour', 'day', 'month', 'weekday'];
const SCHEDULE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const pad = (n) => String(n).padStart(2, '0');

export function isCapabilityError(error) {
  return Boolean(error) && (error.status === 501 || error.code === 'capability_missing' || error.code === 'binary_not_found');
}
export function isFeatureDisabled(error) {
  return Boolean(error) && error.status === 403 && error.code === 'feature_disabled';
}

export function splitSchedule(s) {
  const m = String(s ?? '').trim().replace(/\s+/g, ' ').match(SCHEDULE_RE);
  return m ? m.slice(1) : null;
}

// A readable sentence for the common shapes; anything else is shown raw.
export function describeSchedule(s) {
  const raw = String(s ?? '').trim();
  if (ALIASES[raw]) return ALIASES[raw];
  const f = splitSchedule(raw);
  if (!f) return 'Custom schedule';
  const [min, hour, dom, mon, dow] = f;
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
  const every = (v) => v.match(/^\*\/(\d+)$/)?.[1];
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (every(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${every(min)} minutes`;
  if (num(min) != null && every(hour) && dom === '*' && mon === '*' && dow === '*') return `Every ${every(hour)} hours at minute ${num(min)}`;
  if (num(min) != null && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at minute ${num(min)}`;
  const hours = hour.split(',').map(num);
  if (num(min) != null && hours.every((h) => h != null)) {
    const times = hours.map((h) => `${pad(h)}:${pad(num(min))}`).join(' and ');
    if (dom === '*' && mon === '*' && dow === '*') return `Every day at ${times}`;
    if (dom === '*' && mon === '*' && /^\d$/.test(dow)) return `Every ${DAYS[Number(dow)]} at ${times}`;
    if (dom === '*' && mon === '*' && /^\d-\d$/.test(dow)) return `${DAYS[Number(dow[0])]} to ${DAYS[Number(dow[2])]} at ${times}`;
    if (num(dom) != null && mon === '*' && dow === '*') return `Day ${num(dom)} of every month at ${times}`;
    if (num(dom) != null && num(mon) != null && MONTHS[num(mon)] && dow === '*') return `Every ${num(dom)} ${MONTHS[num(mon)]} at ${times}`;
  }
  return 'Custom schedule';
}

export function presetFor(schedule) {
  const norm = String(schedule ?? '').trim().replace(/\s+/g, ' ');
  return PRESETS.some((p) => p.value === norm) ? norm : 'custom';
}

export function mailtoOf(env) {
  const e = (env || []).find((x) => x.key === 'MAILTO');
  return e ? e.value.replace(/^"(.*)"$/, '$1') : null;
}

// MAILTO is kept as the first entry so cron applies it to every job below it.
export function withMailto(env, value) {
  const rest = (env || []).filter((x) => x.key !== 'MAILTO');
  return value == null ? rest : [{ key: 'MAILTO', value }, ...rest];
}

// `custom` is kept in the form state because a schedule such as the default
// '0 0 * * *' is also a preset: without the flag, choosing "Custom…" would
// map straight back to the preset and the five fields would never appear.
export function isCustomSchedule(value) {
  return Boolean(value?.custom) || presetFor(value?.schedule) === 'custom';
}

export function chooseSchedule(value, preset) {
  if (preset === 'custom') return { ...value, custom: true, schedule: splitSchedule(value.schedule) ? value.schedule : '0 0 * * *' };
  return { ...value, custom: false, schedule: preset };
}

export function JobForm({ value, onChange, errors, idPrefix, disabled = false }) {
  const fields = splitSchedule(value.schedule) || ['*', '*', '*', '*', '*'];
  const custom = isCustomSchedule(value);
  const preset = custom ? 'custom' : presetFor(value.schedule);
  const setField = (i, v) => { const f = [...fields]; f[i] = v.replace(/\s+/g, ''); onChange({ ...value, custom: true, schedule: f.join(' ') }); };
  const choose = (p) => onChange(chooseSchedule(value, p));
  return (
    <>
      <Field label="Schedule" required htmlFor={`${idPrefix}-preset`} help={<>{describeSchedule(value.schedule)} · <code>{value.schedule || '—'}</code></>} error={errors?.schedule}>
        <Select id={`${idPrefix}-preset`} value={preset} onChange={choose} options={PRESETS} disabled={disabled} />
      </Field>
      {custom && (
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', gap: '0 10px' }}>
          {FIELD_NAMES.map((name, i) => (
            <Field key={name} label={name[0].toUpperCase() + name.slice(1)} htmlFor={`${idPrefix}-${name}`}>
              <TextInput id={`${idPrefix}-${name}`} value={fields[i]} onChange={(v) => setField(i, v)} spellCheck={false} disabled={disabled} />
            </Field>
          ))}
          <p className="muted small" style={{ gridColumn: '1 / -1', marginTop: -4 }}>Minute 0–59, hour 0–23, day 1–31, month 1–12, weekday 0–7 (0 and 7 are Sunday). <code>*</code> means every, <code>*/5</code> every fifth, <code>1,15</code> a list, <code>1-5</code> a range.</p>
        </div>
      )}
      <Field label="Command" required htmlFor={`${idPrefix}-command`} help={<>Runs in your home directory as your account. Use full paths, for example <code>/usr/bin/php ~/public_html/cron.php</code>; add <code>&gt;/dev/null 2&gt;&amp;1</code> to silence the mail.</>} error={errors?.command}>
        <TextInput id={`${idPrefix}-command`} value={value.command} onChange={(v) => onChange({ ...value, command: v })} placeholder="/usr/bin/php ~/public_html/cron.php" spellCheck={false} autoCapitalize="none" disabled={disabled} />
      </Field>
    </>
  );
}

function RequestError({ error, onRetry }) {
  if (!error || isCapabilityError(error) || isFeatureDisabled(error)) return null;
  if (error.code === 'refused') return <div className="banner banner-warning" role="alert"><AlertTriangle size={18} /><div><strong>The server refused the crontab</strong><p>{error.message}</p><p className="muted">Ask your hosting provider whether cron is allowed for your account.</p></div></div>;
  return <ErrorBanner error={error} onRetry={onRetry} />;
}

const EMPTY_JOB = { schedule: '0 0 * * *', command: '', custom: false };

export default function CronJobs({ fn }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me } = usePanelMe();
  const { data, error, loading, refetch, setData } = usePanelApi('/cron');
  const [draft, setDraft] = useState(EMPTY_JOB);
  const [addError, setAddError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState(null);
  const [mailDraft, setMailDraft] = useState(null);
  const [mailError, setMailError] = useState(null);
  const [envDraft, setEnvDraft] = useState({ key: '', value: '' });
  const [envError, setEnvError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const capability = isCapabilityError(error);
  const env = data?.env || [];
  const jobs = data?.jobs || [];
  const mailto = mailtoOf(env);
  const otherEnv = useMemo(() => env.filter((e) => e.key !== 'MAILTO'), [env]);

  // The email form starts from the crontab's MAILTO; edits live in a draft until saved.
  const mail = mailDraft ?? { value: mailto || '', silent: mailto === '' };
  const setMail = (update) => setMailDraft(typeof update === 'function' ? update(mail) : update);

  if (isFeatureDisabled(error)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const save = async (next, what, { onError, label }) => {
    setBusy(label); onError(null);
    try {
      const { data: res } = await panelApi.put('/cron', { env: next.env, jobs: next.jobs.map((j) => ({ schedule: j.schedule.trim().replace(/\s+/g, ' '), command: j.command })) });
      setLastResult(res);
      setData((d) => ({ ...(d || {}), exists: res.exists, env: res.env, jobs: res.jobs.map((j, i) => ({ ...j, id: jobs.find((o) => o.schedule === j.schedule && o.command === j.command)?.id ?? `${i}:${j.schedule} ${j.command}` })), raw: d?.raw ?? '' }));
      toast.success(what);
      refetch();
      return true;
    } catch (err) { onError(err); return false; } finally { setBusy(null); }
  };

  const fieldErrorsAt = (err, index) => (err?.fields ? { schedule: err.fields[`jobs.${index}.schedule`], command: err.fields[`jobs.${index}.command`] } : null);

  const add = async (e) => {
    e.preventDefault();
    if (!draft.command.trim()) { setAddError({ message: 'Enter the command to run', fields: { [`jobs.${jobs.length}.command`]: ['Required'] } }); return; }
    const ok = await save({ env, jobs: [...jobs, draft] }, 'Cron job added', { onError: setAddError, label: 'add' });
    if (ok) setDraft(EMPTY_JOB);
  };

  const update = async () => {
    const i = jobs.findIndex((j) => j.id === editing.id);
    const next = jobs.map((j, k) => (k === i ? { ...j, schedule: editing.schedule, command: editing.command } : j));
    const ok = await save({ env, jobs: next }, 'Cron job updated', { onError: setEditError, label: 'edit' });
    if (ok) setEditing(null);
  };

  const remove = async (job) => {
    const ok = await confirm({ title: 'Delete this cron job?', message: `${describeSchedule(job.schedule)}: ${job.command}`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await save({ env, jobs: jobs.filter((j) => j.id !== job.id) }, 'Cron job deleted', { onError: (err) => err && toast.error(err), label: 'delete' });
  };

  const saveMail = async (e) => {
    e.preventDefault();
    const value = mail.silent ? '' : mail.value.trim();
    if (!mail.silent && value && !EMAIL_RE.test(value)) { setMailError({ message: 'Enter a valid email address', fields: { 'env.0.value': ['Not an email address'] } }); return; }
    const ok = await save({ env: withMailto(env, mail.silent ? '' : value || null), jobs }, mail.silent ? 'Cron output is no longer mailed' : value ? `Cron output goes to ${value}` : 'Cron output goes to the account mailbox', { onError: setMailError, label: 'mail' });
    if (ok) setMailDraft(null);
  };

  const addEnv = async (e) => {
    e.preventDefault();
    const key = envDraft.key.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key)) { setEnvError({ message: 'Variable names use upper-case letters, digits and "_"', fields: { key: ['Invalid name'] } }); return; }
    if (key === 'MAILTO') { setEnvError({ message: 'Set the cron email in its own card above' }); return; }
    const next = [...env.filter((x) => x.key !== key), { key, value: envDraft.value }];
    const ok = await save({ env: withMailto(next, mailto), jobs }, `${key} set`, { onError: setEnvError, label: 'env' });
    if (ok) setEnvDraft({ key: '', value: '' });
  };

  const removeEnv = async (entry) => {
    await save({ env: env.filter((x) => x.key !== entry.key), jobs }, `${entry.key} removed`, { onError: (err) => err && toast.error(err), label: 'env' });
  };

  const removeAll = async () => {
    const ok = await confirm({ title: 'Remove the whole crontab?', message: `All ${jobs.length} job${jobs.length === 1 ? '' : 's'} and every variable are deleted. Nothing runs on a schedule afterwards.`, confirmLabel: 'Remove crontab', danger: true, typeToConfirm: 'remove' });
    if (!ok) return;
    setBusy('remove');
    try { await panelApi.delete('/cron'); toast.success('Crontab removed'); refetch(); } catch (err) { toast.error(err); } finally { setBusy(null); }
  };

  const envFieldError = (err) => { const k = Object.keys(err?.fields || {}).find((x) => x.startsWith('env.')); return k ? err.fields[k] : err?.fields?.key; };
  // With cron missing the forms stay visible for orientation but cannot submit.
  const blockedSubtitle = capability ? 'Available once cron is installed on this server.' : null;

  return (
    <PanelPage fn={fn} actions={<Button icon={RefreshCw} onClick={() => refetch()}>Refresh</Button>}>
      {capability && <PanelCapabilityState card error={error} onRetry={refetch} />}
      {!capability && error && <RequestError error={error} onRetry={refetch} />}

      <div className="grid-2">
        <form onSubmit={saveMail}>
          <Card title="Cron email" subtitle={blockedSubtitle || 'Whatever a job prints is mailed after each run; the subject names the command.'}>
            <PanelCapabilityState error={isCapabilityError(mailError) ? mailError : null} />
            <RequestError error={mailError} />
            <Field label="Send output to" htmlFor="cron-mailto" help={mail.silent ? 'Output is discarded' : `Leave empty to use the mailbox of ${me?.account?.username || 'your account'} on this server`} error={envFieldError(mailError)}>
              <TextInput id="cron-mailto" type="email" value={mail.value} onChange={(v) => setMail((m) => ({ ...m, value: v }))} placeholder={me?.account?.contactEmail || 'you@example.com'} disabled={mail.silent || capability} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Toggle checked={mail.silent} onChange={(v) => setMail((m) => ({ ...m, silent: v }))} label="Do not send any mail" description={<>Sets <code>MAILTO=""</code>; useful for jobs that print a lot</>} disabled={capability} />
            <FormActions>
              <Button type="submit" variant="primary" icon={Mail} loading={busy === 'mail'} disabled={Boolean(busy) || capability}>Save email</Button>
              {lastResult && <PendingPill result={lastResult} />}
            </FormActions>
          </Card>
        </form>

        <form onSubmit={add}>
          <Card title="Add a cron job" subtitle={blockedSubtitle || 'Pick how often, then the command. It is saved to your crontab straight away.'}>
            <PanelCapabilityState error={isCapabilityError(addError) ? addError : null} />
            <RequestError error={addError} />
            <JobForm value={draft} onChange={setDraft} errors={fieldErrorsAt(addError, jobs.length)} idPrefix="cron-new" disabled={capability} />
            <FormActions>
              <Button type="submit" variant="primary" icon={Plus} loading={busy === 'add'} disabled={Boolean(busy) || capability || !draft.command.trim() || !draft.schedule.trim()}>Add cron job</Button>
            </FormActions>
          </Card>
        </form>
      </div>

      <Card title="Cron jobs" subtitle={jobs.length ? `${jobs.length} scheduled on this account` : undefined} padded={false}
        actions={jobs.length > 0 ? <Button size="sm" variant="danger-ghost" icon={Trash2} loading={busy === 'remove'} disabled={Boolean(busy)} onClick={removeAll}>Remove crontab</Button> : null}>
        <DataTable
          columns={[
            { key: 'schedule', label: 'Runs', render: (r) => <><div>{describeSchedule(r.schedule)}</div><code className="muted small">{r.schedule}</code></> },
            { key: 'command', label: 'Command', render: (r) => <code style={{ wordBreak: 'break-all' }}>{r.command}</code> },
          ]}
          rows={jobs} loading={loading && !data} error={null} rowKey={(r) => r.id}
          rowActions={(r) => [
            { label: 'Edit', primary: true, onClick: () => { setEditing({ ...r }); setEditError(null); } },
            { label: 'Delete', danger: true, onClick: () => remove(r) },
          ]}
          emptyText={capability ? 'Cron jobs appear here once cron is available on this server.' : 'No cron jobs yet. Add one above; each job is listed here with how often it runs and the command.'}
        />
      </Card>

      <Card title="Environment" subtitle={blockedSubtitle || 'Variables placed at the top of the crontab, available to every job.'}>
        <PanelCapabilityState error={isCapabilityError(envError) ? envError : null} />
        <RequestError error={envError} />
        {otherEnv.length > 0 && (
          <KeyValue items={otherEnv.map((e) => [e.key, <span key={e.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><code>{e.value || '""'}</code><button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => removeEnv(e)} disabled={Boolean(busy)} aria-label={`Remove ${e.key}`}>Remove</button></span>])} />
        )}
        <form onSubmit={addEnv} className="form-grid" style={{ marginTop: otherEnv.length ? 12 : 0 }}>
          <Field label="Name" htmlFor="cron-env-key" error={envError?.fields?.key}><TextInput id="cron-env-key" value={envDraft.key} onChange={(v) => setEnvDraft((d) => ({ ...d, key: v.toUpperCase() }))} placeholder="PATH" spellCheck={false} disabled={capability} /></Field>
          <Field label="Value" htmlFor="cron-env-value" error={envFieldError(envError)}><TextInput id="cron-env-value" value={envDraft.value} onChange={(v) => setEnvDraft((d) => ({ ...d, value: v }))} placeholder="/usr/local/bin:/usr/bin:/bin" spellCheck={false} disabled={capability} /></Field>
          <div style={{ gridColumn: '1 / -1' }}><FormActions><Button type="submit" loading={busy === 'env'} disabled={Boolean(busy) || capability || !envDraft.key.trim()}>Set variable</Button></FormActions></div>
        </form>
        <p className="muted small" style={{ marginTop: 10 }}><Info size={12} style={{ verticalAlign: '-2px' }} /> <code>SHELL</code> may be <code>/bin/bash</code> or <code>/bin/sh</code>. Times follow the server clock{me?.hostname ? ` of ${me.hostname}` : ''}; see <Link to={USAGE_PATH}>usage</Link> for your plan's limits.</p>
      </Card>

      <Modal open={Boolean(editing)} title="Edit cron job" onClose={() => setEditing(null)} size="md"
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" icon={Clock} loading={busy === 'edit'} disabled={!editing?.command?.trim()} onClick={update}>Save changes</Button></>}>
        <PanelCapabilityState error={editError} />
        <RequestError error={editError} />
        {editing && <JobForm value={editing} onChange={(v) => setEditing((e) => ({ ...e, ...v }))} errors={fieldErrorsAt(editError, jobs.findIndex((j) => j.id === editing.id))} idPrefix="cron-edit" />}
      </Modal>
    </PanelPage>
  );
}
