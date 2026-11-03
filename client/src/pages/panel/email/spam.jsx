import { useEffect, useState } from 'react';
import { Plus, X, ShieldOff } from 'lucide-react';
import { Card, StatusPill, formatDate } from '../../../components/Common.jsx';
import { Field, TextInput, NumberInput, Toggle, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, fieldError, isFeatureDisabled } from './parts/Shared.jsx';

export function scoreHint(score) {
  if (score == null) return '';
  if (score < 3) return 'Very strict: some legitimate newsletters and notifications are flagged.';
  if (score <= 5) return 'Balanced: the usual setting.';
  if (score <= 8) return 'Lenient: only obvious spam is flagged.';
  return 'Very lenient: almost nothing is flagged.';
}

// Add/remove rows of a sender list; the parent sends the whole list on save.
export function AddressList({ title, subtitle, addresses, onChange, error, max = 200 }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const a = draft.trim().toLowerCase();
    if (!a || addresses.includes(a)) { setDraft(''); return; }
    onChange([...addresses, a]);
    setDraft('');
  };
  return (
    <Card title={title} subtitle={subtitle} actions={<span className="muted">{addresses.length} of {max}</span>}>
      <form onSubmit={(e) => { e.preventDefault(); add(); }} className="input-group" style={{ maxWidth: 480 }}>
        <TextInput value={draft} onChange={setDraft} type="email" placeholder="sender@example.com" aria-label={`Add to ${title.toLowerCase()}`} autoCapitalize="none" />
        <Button type="submit" icon={Plus} disabled={!draft.trim() || addresses.length >= max}>Add</Button>
      </form>
      {error && <div className="field-message">{Array.isArray(error) ? error.join(', ') : String(error)}</div>}
      {addresses.length === 0 ? <p className="muted" style={{ marginTop: 12 }}>No addresses yet. Add one above and save.</p> : (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <tbody>
              {addresses.map((a) => (
                <tr key={a}>
                  <td><code>{a}</code></td>
                  <td className="actions-col"><button type="button" className="icon-button" aria-label={`Remove ${a}`} onClick={() => onChange(addresses.filter((x) => x !== a))}><X size={16} /></button></td>
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
      <Card title="Filtering" subtitle="Incoming mail is scored by SpamAssassin; anything at or above the threshold is marked as spam." actions={<StatusPill status={current.enabled ? 'enabled' : 'disabled'} />}>
        <MutationError error={error} />
        <Toggle checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Filter spam" description="Marks suspicious messages so mail apps can move them to the junk folder." />
        <div className="form-grid" style={{ marginTop: 16 }}>
          <Field label="Spam threshold" error={fieldError(error, 'requiredScore')} help={`Score from 1 to 20 at which a message counts as spam. ${scoreHint(form.requiredScore)}`}>
            <NumberInput value={form.requiredScore} onChange={(v) => set({ requiredScore: v })} nullable={false} min={1} max={20} step={0.1} disabled={!form.enabled} aria-label="Spam threshold" style={{ maxWidth: 160 }} />
          </Field>
        </div>
        <Toggle checked={form.autoDelete} onChange={(v) => set({ autoDelete: v, autoDeleteScore: v ? (form.autoDeleteScore ?? form.requiredScore) : form.autoDeleteScore })} disabled={!form.enabled} label="Delete obvious spam" description="Messages scoring at or above a second, higher threshold are discarded instead of delivered." />
        {form.autoDelete && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Delete at score" error={fieldError(error, 'autoDeleteScore')} help="Must be at least the spam threshold. Deleted messages cannot be recovered.">
              <NumberInput value={form.autoDeleteScore ?? form.requiredScore} onChange={(v) => set({ autoDeleteScore: v })} nullable={false} min={1} max={20} step={0.1} disabled={!form.enabled} aria-label="Auto-delete threshold" style={{ maxWidth: 160 }} />
            </Field>
          </div>
        )}
      </Card>
      <div className="grid-2">
        <AddressList title="Allow list" subtitle="Mail from these senders is never marked as spam." addresses={form.whitelist} onChange={(v) => set({ whitelist: v })} error={fieldError(error, 'whitelist')} />
        <AddressList title="Block list" subtitle="Mail from these senders is always marked as spam." addresses={form.blacklist} onChange={(v) => set({ blacklist: v })} error={fieldError(error, 'blacklist')} />
      </div>
      <FormActions>
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>Save spam settings</Button>
        {dirty && <Button onClick={() => set({ enabled: current.enabled, requiredScore: current.requiredScore, autoDelete: current.autoDelete, autoDeleteScore: current.autoDeleteScore, whitelist: current.whitelist || [], blacklist: current.blacklist || [] })}>Discard changes</Button>}
        <PendingPill result={pending} />
        {current.updatedAt && <span className="muted" style={{ alignSelf: 'center' }}>Last saved {formatDate(current.updatedAt)}</span>}
      </FormActions>
    </form>
  );
}

export default function SpamFilters({ fn }) {
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
      toast.success('Spam settings saved');
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  return (
    <PanelPage fn={fn}>
      {isFeatureDisabled(error) ? <PanelRequestError error={error} fn={fn} /> : (
        <>
          {error && <Card><PanelRequestError error={error} fn={fn} onRetry={refetch} /></Card>}
          {loading && !data && !error && <Card><p className="muted">Loading…</p></Card>}
          {data && data.available === false && (
            <div className="banner banner-warning"><ShieldOff size={18} /><div><strong>Spam filtering is not available on this server</strong><p>SpamAssassin is not installed, so these settings cannot take effect yet. Ask your hosting provider to enable it.</p></div></div>
          )}
          {data && <SpamSettingsForm current={data} onSubmit={save} busy={busy} error={mutationError} pending={pending} />}
        </>
      )}
    </PanelPage>
  );
}
