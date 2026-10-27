import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, StatusPill, formatDate } from '../../components/Common.jsx';
import { Field, TextInput, Textarea, Button, ErrorBanner } from '../../components/Form.jsx';
import { api } from '../../api/client.js';
import { useApi } from '../../hooks/useApi.js';
import { useAction } from '../../hooks/useAction.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { KV } from '../../widgets/index.jsx';

const FIELDS = [['display_name', 'Display name'], ['company', 'Company'], ['website', 'Website (https)'], ['country', 'Country (ISO-2)'], ['support_email', 'Support e-mail'], ['support_url', 'Support URL (https)']];

export function statusHint(d) {
  if (!d) return '';
  if (!d.email_verified) return 'Verify your e-mail address from the registration mail.';
  if (!d.totp_enabled) return 'Enable two-factor authentication before claiming namespaces or adding keys.';
  if (!(d.namespaces || []).length) return 'Claim a namespace and submit evidence under Verification.';
  if (d.status === 'pending' && !d.verified_at) return 'Waiting for the vendor to verify your identity; uploads open after verification.';
  if (d.status === 'pending' && d.verified_at) return 'Re-verification pending: uploads are accepted, publishing is paused.';
  if (d.status === 'rejected') return `Rejected: ${d.status_reason || 'see the mail'}. Resubmit evidence to re-enter the queue.`;
  if (d.status === 'suspended') return `Suspended: ${d.status_reason || 'contact the vendor'}.`;
  return 'Verified — you can publish to the marketplace.';
}

export default function Profile() {
  const { data, error, refetch } = useApi('/dev/profile');
  const { refresh } = useAuth();
  const { run, busy, error: saveError } = useAction();
  const draftOf = (d) => Object.fromEntries(FIELDS.map(([k]) => [k, d?.[k] || '']));
  const [draft, setDraft] = useState(() => draftOf(data));
  const [email, setEmail] = useState(data?.email || '');
  const [payout, setPayout] = useState('');
  useEffect(() => { if (data) { setDraft(draftOf(data)); setEmail(data.email || ''); } }, [data]);
  const d = data;
  const save = () => run(() => api.patch('/dev/profile', Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === '' ? (k === 'display_name' ? undefined : null) : v]).filter(([, v]) => v !== undefined))), { success: 'Profile saved', then: refetch });
  const saveEmail = () => run(() => api.patch('/dev/profile', { email }), { success: 'E-mail changed; every session and API key was invalidated — sign in again', then: refresh });
  const savePayout = () => run(async () => { let parsed; try { parsed = JSON.parse(payout); } catch { throw Object.assign(new Error('Payout details must be a JSON object'), { fields: { payout: ['invalid JSON'] } }); } await api.patch('/dev/profile', { payout: parsed }); }, { success: 'Payout details stored encrypted', then: refetch });
  return (
    <>
      <PageHeader title="Profile" description="Your public vendor card and account status." home="/dev" actions={d && <StatusPill status={d.status} />} />
      <ErrorBanner error={error} onRetry={refetch} />
      {d && (
        <>
          <div className="banner banner-info"><div><strong>{statusHint(d)}</strong> <span className="muted">Steps: e-mail → 2FA (<Link to="/dev/security">Security</Link>) → namespace + evidence (<Link to="/dev/verification">Verification</Link>) → signing key (<Link to="/dev/keys">Keys</Link>) → listing + upload (<Link to="/dev/plugins">Plugins</Link>).</span></div></div>
          <div className="two-col">
            <Card title="Public card">
              <ErrorBanner error={saveError} />
              {FIELDS.map(([k, label]) => <Field key={k} label={label} error={saveError?.fields?.[k]}><TextInput value={draft[k] ?? ''} onChange={(v) => setDraft((x) => ({ ...x, [k]: v }))} /></Field>)}
              <Button variant="primary" loading={busy} onClick={save}>Save profile</Button>
            </Card>
            <div>
              <Card title="Account">
                <KV items={[['Slug', d.slug], ['E-mail', <>{d.email} <StatusPill status={d.email_verified ? 'verified' : 'pending'} /></>], ['2FA', <StatusPill status={d.totp_enabled ? 'enabled' : 'disabled'} />], ['Namespaces', (d.namespaces || []).join(', ') || '—'], ['Verified', d.verified_at ? `${formatDate(d.verified_at)} · due ${formatDate(d.reverify_due_at)}` : 'not yet'], ['Revenue share', `${d.revenue_share_pct}%`], ['Payout details', d.has_payout ? 'on file' : 'missing'], ['Registered', formatDate(d.created_at)]]} />
              </Card>
              <Card title="Change e-mail" subtitle="Needs a fresh two-factor code; invalidates every session and API key.">
                <Field label="New e-mail"><TextInput type="email" value={email} onChange={setEmail} /></Field>
                <Button loading={busy} disabled={!email || email === d.email} onClick={saveEmail}>Change e-mail</Button>
              </Card>
              <Card title="Payout details" subtitle="Stored encrypted; needs a fresh two-factor code. Changing them triggers re-verification.">
                <Field label="JSON (e.g. Stripe Connect account or IBAN)"><Textarea value={payout} onChange={setPayout} rows={3} mono placeholder='{"stripe_account":"acct_…"}' /></Field>
                <Button loading={busy} disabled={!payout} onClick={savePayout}>Save payout details</Button>
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
