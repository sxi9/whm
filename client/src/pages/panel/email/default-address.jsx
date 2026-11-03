import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, RadioGroup, Button, FormActions } from '../../../components/Form.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { PanelPage, PendingPill } from '../../../panel/PanelPage.jsx';
import { usePanelApi, panelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, MutationError, useAccountDomains, fieldError, isFeatureDisabled } from './parts/Shared.jsx';

export const ACTIONS = [
  { value: 'fail', label: 'Reject with an error', description: 'The sender receives a bounce saying the address does not exist. Recommended: spammers learn nothing and your server does not fill up.' },
  { value: 'blackhole', label: 'Discard silently', description: 'Messages are dropped without telling the sender.' },
  { value: 'forward', label: 'Forward to an address', description: 'Everything sent to an unknown address at this domain lands in one inbox (a catch-all).' },
];

export function actionText(action) {
  return ACTIONS.find((a) => a.value === action)?.label || action;
}

export function DefaultAddressForm({ current, onSubmit, busy, error, pending }) {
  const [action, setAction] = useState(current?.action || 'fail');
  const [destination, setDestination] = useState(current?.destination || '');
  useEffect(() => { setAction(current?.action || 'fail'); setDestination(current?.destination || ''); }, [current?.action, current?.destination]);
  const dirty = action !== (current?.action || 'fail') || (action === 'forward' && destination.trim().toLowerCase() !== (current?.destination || ''));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ action, destination: action === 'forward' ? destination.trim().toLowerCase() : undefined }); }}>
      <MutationError error={error} />
      <RadioGroup name={`default-${current?.domain || 'domain'}`} value={action} onChange={setAction} options={ACTIONS} />
      {action === 'forward' && (
        <Field label="Deliver to" required error={fieldError(error, 'destination')} help="A mailbox at one of your domains or any other address.">
          <TextInput value={destination} onChange={setDestination} type="email" placeholder="catchall@example.com" autoCapitalize="none" style={{ maxWidth: 420 }} />
        </Field>
      )}
      <FormActions>
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty || (action === 'forward' && !destination.trim())}>Save</Button>
        <PendingPill result={pending} />
      </FormActions>
    </form>
  );
}

function DomainDefault({ domain, fn }) {
  const toast = useToast();
  const { data, error, loading, refetch, setData } = usePanelApi(`/email/domains/${domain}/default`);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [pending, setPending] = useState(null);
  const save = async (body) => {
    setBusy(true); setMutationError(null);
    try {
      const res = await panelApi.put(`/email/domains/${domain}/default`, body);
      setData(res.data);
      setPending(res.data?.applied === false ? res.data : null);
      toast.success(`Default address for ${domain}: ${actionText(body.action).toLowerCase()}`);
    } catch (err) { setMutationError(err); } finally { setBusy(false); }
  };
  if (isFeatureDisabled(error)) return null;
  const status = data ? (data.configured ? <StatusPill status={data.action === 'forward' ? 'ok' : data.action === 'fail' ? 'warning' : 'disabled'}>{actionText(data.action)}</StatusPill> : <StatusPill status="unknown">Not set · rejects with an error</StatusPill>) : null;
  return (
    <Card title={domain} subtitle={data?.action === 'forward' && data.destination ? `Unknown addresses are delivered to ${data.destination}.` : 'What happens to mail for an address at this domain that has no mailbox or forwarder.'} actions={status}>
      <PanelRequestError error={error} fn={fn} onRetry={refetch} />
      {loading && !data && !error && <p className="muted">Loading…</p>}
      {data && <DefaultAddressForm current={data} onSubmit={save} busy={busy} error={mutationError} pending={pending} />}
    </Card>
  );
}

export default function DefaultAddress({ fn }) {
  const domains = useAccountDomains();
  const probe = usePanelApi(domains[0] ? `/email/domains/${domains[0]}/default` : null);
  if (isFeatureDisabled(probe.error)) return <PanelPage fn={fn}><PanelRequestError error={probe.error} fn={fn} /></PanelPage>;
  return (
    <PanelPage fn={fn}>
      {domains.map((d) => <DomainDefault key={d} domain={d} fn={fn} />)}
      {!domains.length && <Card><p className="muted">No domains on this account yet.</p></Card>}
      <p className="muted">Forwarders for individual addresses are managed under <Link to="/panel/email/forwarders">Forwarders</Link>.</p>
    </PanelPage>
  );
}
