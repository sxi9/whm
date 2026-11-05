import { useEffect, useState } from 'react';
import { Plus, X, ShieldOff } from 'lucide-react';
import { Card, EmptyState, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, fieldError, isFeatureDisabled, useEmailT, tr } from './parts/Shared.jsx';

export function scoreHint(score) {
  if (score == null) return '';
  if (score < 3) return tr('panel.email.spam.hint_strict', 'Very strict: some legitimate newsletters and notifications are flagged.');
  if (score <= 5) return tr('panel.email.spam.hint_balanced', 'Balanced: the usual setting.');
  if (score <= 8) return tr('panel.email.spam.hint_lenient', 'Lenient: only obvious spam is flagged.');
  return tr('panel.email.spam.hint_very_lenient', 'Very lenient: almost nothing is flagged.');
}

// Add/remove rows of a sender list; the parent sends the whole list on save.
export function AddressList({ title, subtitle, addresses, onChange, error, max = 200 }) {
  const { t } = useEmailT();
  const [draft, setDraft] = useState('');
  const add = () => {
    const a = draft.trim().toLowerCase();
    if (!a || addresses.includes(a)) { setDraft(''); return; }
    onChange([...addresses, a]);
    setDraft('');
  };
  return (
    <Card title={title} subtitle={subtitle} actions={<span className="muted">{t('panel.email.common.n_of_m', '{n} of {m}', { n: addresses.length, m: max })}</span>}>
      <div className="input-group" style={{ maxWidth: 480 }}>
        <TextInput value={draft} onChange={setDraft} type="email" placeholder="sender@example.com" aria-label={t('panel.email.spam.add_to_list', 'Add to {list}', { list: title.toLowerCase() })} autoCapitalize="none" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button icon={Plus} disabled={!draft.trim() || addresses.length >= max} onClick={add}>{t('panel.email.common.add', 'Add')}</Button>
      </div>
      {error && <div className="field-message">{Array.isArray(error) ? error.join(', ') : String(error)}</div>}
      {addresses.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>{t('panel.email.spam.list_empty', 'No addresses yet. Add one above and save.')}</p> : (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <tbody>
              {addresses.map((a) => (
                <tr key={a}>
                  <td><code>{a}</code></td>
                  <td className="actions-col"><button type="button" className="icon-button" aria-label={t('panel.email.spam.remove_address', 'Remove {address}', { address: a })} onClick={() => onChange(addresses.filter((x) => x !== a))}><X size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function SpamSettingsForm({ current, onSubmit, busy, error, pending }) {
  const { t } = useEmailT();
  const [form, setForm] = useState(() => ({ enabled: current.enabled, requiredScore: current.requiredScore, autoDelete: current.autoDelete, autoDeleteScore: current.autoDeleteScore, whitelist: current.whitelist || [], blacklist: current.blacklist || [] }));
  useEffect(() => { setForm({ enabled: current.enabled, requiredScore: current.requiredScore, autoDelete: current.autoDelete, autoDeleteScore: current.autoDeleteScore, whitelist: current.whitelist || [], blacklist: current.blacklist || [] }); }, [current.updatedAt]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify({ enabled: current.enabled, requiredScore: current.requiredScore, autoDelete: current.autoDelete, autoDeleteScore: current.autoDeleteScore, whitelist: current.whitelist || [], blacklist: current.blacklist || [] });
  const submit = (e) => {
    e.preventDefault();
    const score = Math.round(Number(form.requiredScore) * 10) / 10;
    onSubmit({ enabled: form.enabled, requiredScore: score, autoDelete: form.autoDelete, autoDeleteScore: form.autoDelete ? Math.round(Number(form.autoDeleteScore ?? score) * 10) / 10 : null, whitelist: form.whitelist, blacklist: form.blacklist });
  };
  return (
    <form onSubmit={submit}>
      <Card title={t('panel.email.spam.filtering', 'Filtering')} subtitle={t('panel.email.spam.filtering_subtitle', 'Incoming mail is scored by SpamAssassin; anything at or above the threshold is marked as spam.')} actions={<StatusPill status={current.enabled ? 'enabled' : 'disabled'} />}>
        <MutationError error={error} />
        <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label={t('panel.email.spam.filter_spam', 'Filter spam')} description={t('panel.email.spam.filter_spam_help', 'Marks suspicious messages so mail apps can move them to the junk folder.')} />
        <div className="form-grid" style={{ marginTop: 16 }}>
          <Field label={t('panel.email.spam.threshold', 'Spam threshold')} error={fieldError(error, 'requiredScore')} help={`${t('panel.email.spam.threshold_help', 'Score from 1 to 20 at which a message counts as spam.')} ${scoreHint(form.requiredScore)}`}>
            <NumberInput value={form.requiredScore} onChange={(v) => set({ requiredScore: v })} nullable={false} min={1} max={20} step={0.1} disabled={!form.enabled} aria-label={t('panel.email.spam.threshold', 'Spam threshold')} style={{ maxWidth: 160 }} />
          </Field>
        </div>
        <Toggle checked={form.autoDelete} onChange={(v) => set({ autoDelete: v, autoDeleteScore: v ? (form.autoDeleteScore ?? form.requiredScore) : form.autoDeleteScore })} disabled={!form.enabled} label={t('panel.email.spam.auto_delete', 'Delete obvious spam')} description={t('panel.email.spam.auto_delete_help', 'Messages scoring at or above a second, higher threshold are discarded instead of delivered.')} />
        {form.autoDelete && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label={t('panel.email.spam.delete_at', 'Delete at score')} error={fieldError(error, 'autoDeleteScore')} help={t('panel.email.spam.delete_at_help', 'Must be at least the spam threshold. Deleted messages cannot be recovered.')}>
              <NumberInput value={form.autoDeleteScore ?? form.requiredScore} onChange={(v) => set({ autoDeleteScore: v })} nullable={false} min={1} max={20} step={0.1} disabled={!form.enabled} aria-label={t('panel.email.spam.auto_delete_threshold', 'Auto-delete threshold')} style={{ maxWidth: 160 }} />
            </Field>
          </div>
        )}
      </Card>
      <div className="grid-2">
        <AddressList title={t('panel.email.spam.allow_list', 'Allow list')} subtitle={t('panel.email.spam.allow_list_help', 'Mail from these senders is never marked as spam.')} addresses={form.whitelist} onChange={(v) => set({ whitelist: v })} error={fieldError(error, 'whitelist')} />
        <AddressList title={t('panel.email.spam.block_list', 'Block list')} subtitle={t('panel.email.spam.block_list_help', 'Mail from these senders is always marked as spam.')} addresses={form.blacklist} onChange={(v) => set({ blacklist: v })} error={fieldError(error, 'blacklist')} />
      </div>
      <FormActions>
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>{t('panel.email.spam.save', 'Save spam settings')}</Button>
        {dirty && <Button onClick={() => set({ enabled: current.enabled, requiredScore: current.requiredScore, autoDelete: current.autoDelete, autoDeleteScore: current.autoDeleteScore, whitelist: current.whitelist || [], blacklist: current.blacklist || [] })}>{t('panel.email.common.discard_changes', 'Discard changes')}</Button>}
        <PendingPill result={pending} />
        {current.updatedAt && <span className="muted" style={{ alignSelf: 'center' }}>{t('panel.email.spam.last_saved', 'Last saved {date}', { date: formatDate(current.updatedAt) })}</span>}
      </FormActions>
    </form>
  );
}

// What a threshold is and when it acts, in the cPanel wording customers know:
// one score per account, applied only once the mail server hands mail to a scanner.
export function ThresholdHelp() {
  const { t } = useEmailT();
  return (
    <Card title={t('panel.email.spam.how_title', 'How spam scoring works')}>
      <p>{t('panel.email.spam.how_scoring', 'Every incoming message is given a score: the more spam-like its sender, links and wording, the higher the number. The spam threshold is the score at which a message is marked as spam. It applies to this account only; every account on the server keeps its own threshold and lists.')}</p>
      <p>{t('panel.email.spam.how_threshold', 'A threshold of 5 is the usual starting point. Lower values catch more spam but also more newsletters and notifications; higher values let more through. Auto-delete uses a second, higher score so that only obvious spam is discarded and nothing borderline is lost.')}</p>
      <p>{t('panel.email.spam.how_lists', 'The allow list and block list override the score for the senders you name, so a wanted sender is never flagged and a known spammer always is.')}</p>
      <p className="muted">{t('panel.email.spam.how_scanner', 'Scores only exist when the mail server hands incoming mail to a scanner. On a server whose mail server runs without content scanning, mail is delivered unscored and the threshold has no effect until your hosting provider installs the scanning build and SpamAssassin.')}</p>
    </Card>
  );
}

// Why saved settings would not act on this server (GET /email/spam reason).
export function unavailableText(reason) {
  switch (reason) {
    case 'exim_no_content_scan': return tr('panel.email.spam.reason_no_content_scan', 'The mail server was built without content scanning, so it cannot hand incoming mail to SpamAssassin.');
    case 'spamd_not_running': return tr('panel.email.spam.reason_spamd_not_running', 'SpamAssassin is installed but its daemon is not running, so incoming mail is not scored.');
    case 'exim_missing': return tr('panel.email.spam.reason_exim_missing', 'The mail server (Exim) is not installed, so there is no incoming mail to filter.');
    case 'spamd_missing':
    default: return tr('panel.email.spam.reason_spamd_missing', 'SpamAssassin is not installed, so incoming mail is not scored.');
  }
}

// Settings cannot take effect: the form is withheld rather than saved as if
// it filtered anything (the API refuses the save with 501/422 as well).
export function SpamUnavailable({ reason, detail, onRetry }) {
  const { t } = useEmailT();
  return (
    <Card>
      <EmptyState icon={ShieldOff} title={t('panel.email.spam.unavailable_title', 'Spam filtering is not available on this server')}>
        <p>{unavailableText(reason)}</p>
        {detail && <p className="muted">{detail}</p>}
        {reason === 'exim_no_content_scan' && <p className="muted">{t('panel.email.spam.no_scan_thresholds', 'Incoming mail is delivered unscored, so a per-account threshold would have nothing to compare against; the settings cannot be saved here until the scanning build is installed.')}</p>}
        <p className="muted">{t('panel.email.spam.unavailable_text', 'Ask your hosting provider to enable it. Your other mail settings keep working.')}</p>
        {onRetry && <p><button className="btn btn-sm" onClick={onRetry}>{t('panel.email.common.recheck', 'Re-check')}</button></p>}
      </EmptyState>
    </Card>
  );
}

export default function SpamFilters({ fn }) {
  const { t } = useEmailT();
  const toast = useToast();
  const { data, error, loading, refetch, setData } = usePanelApi('/email/spam');
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState(null);
  const save = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await panelApi.put('/email/spam', body);
      setData(res.data);
      setPending(res.data?.applied === false ? res.data : null);
      toast.success(t('panel.email.spam.toast_saved', 'Spam settings saved'));
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  return (
    <PanelPage fn={fn}>
      {isFeatureDisabled(error) ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          {error && <Card><PanelRequestError error={error} fn={fn} onRetry={refetch} /></Card>}
          {loading && !data && !error && <Card><p className="muted">{t('panel.email.common.loading', 'Loading…')}</p></Card>}
          {data && data.available === false && <SpamUnavailable reason={data.reason} detail={data.detail} onRetry={refetch} />}
          {data && data.available !== false && <SpamSettingsForm current={data} onSubmit={save} busy={busy} error={mutationError} pending={pending} />}
          {data && <ThresholdHelp />}
        </>
      )}
    </PanelPage>
  );
}
