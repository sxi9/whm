import { useState } from 'react';
import { api } from '../../../api/client.js';
import { PageHeader, Card, StatusPill, KeyValue } from '../../../components/Common.jsx';
import { Field, TextInput, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { RequestError } from '../../email/Shared.jsx';

export default function MailTroubleshooter({ fn }) {
  const [address, setAddress] = useState('');
  const [state, setState] = useState({ loading: false, result: null, error: null });
  const run = async (e) => {
    e?.preventDefault?.();
    setState({ loading: true, result: null, error: null });
    try { const { data } = await api.post('/email/troubleshoot', { address: address.trim() }); setState({ loading: false, result: data, error: null }); } catch (error) { setState({ loading: false, result: null, error }); }
  };
  const r = state.result;
  return (
    <>
      <PageHeader fn={fn} description="Diagnoses delivery to one address: how Exim would route it (exim -bt), the domain's MX records, whether this server can reach the first exchanger on port 25, and whether a locally hosted domain's MX actually points here." />
      <Card title="Address to test">
        <form onSubmit={run}>
          <Field label="Email address" error={state.error?.fields?.address}><TextInput value={address} onChange={setAddress} placeholder="someone@example.com" /></Field>
          <FormActions><Button type="submit" variant="primary" loading={state.loading} disabled={!address.includes('@')}>Run diagnostics</Button></FormActions>
        </form>
      </Card>
      {state.error && !state.error.fields && <RequestError error={state.error} />}
      {state.error?.fields && <ErrorBanner error={state.error} />}
      {r && (
        <>
          {r.hints.length > 0 && <div className="banner banner-warning"><div>{r.hints.map((h) => <p key={h}>{h}</p>)}</div></div>}
          {r.hints.length === 0 && <div className="banner banner-info"><div>No problems found for <code>{r.address}</code>.</div></div>}
          <Card title="Domain" actions={<StatusPill status={r.local.hosted ? 'ok' : 'unknown'}>{r.local.hosted ? 'hosted here' : 'external'}</StatusPill>}>
            <KeyValue items={[['Domain', <code key="d">{r.domain}</code>], r.local.hosted && ['Account', r.local.account], r.local.hosted && ['Email routing', r.local.routing || 'auto'], r.local.mxPointsHere != null && ['MX points to this server', <StatusPill key="m" status={r.local.mxPointsHere ? 'ok' : 'warning'}>{r.local.mxPointsHere ? 'yes' : 'no'}</StatusPill>]]} />
          </Card>
          <Card title="MX records" actions={<StatusPill status={r.mx.ok && r.mx.records.length ? 'ok' : 'warning'}>{r.mx.ok && r.mx.records.length ? `${r.mx.records.length} record(s)` : r.mx.error || 'none'}</StatusPill>}>
            {r.mx.records.length ? <KeyValue items={r.mx.records.map((m) => [`MX ${m.priority}`, <code key={m.exchange}>{m.exchange}</code>])} /> : <p className="muted">No MX records{r.mx.fallbackA?.length ? `; A record fallback: ${r.mx.fallbackA.join(', ')}` : ''}.</p>}
          </Card>
          {r.smtp && (
            <Card title="SMTP connectivity" actions={<StatusPill status={r.smtp.ok ? 'ok' : 'failed'}>{r.smtp.ok ? 'reachable' : r.smtp.error}</StatusPill>}>
              <KeyValue items={[['Host', <code key="h">{r.smtp.host}:25</code>], ['Banner', r.smtp.banner ? <code key="b">{r.smtp.banner}</code> : <span key="n" className="muted">{r.smtp.ok ? 'connected, no banner within 5 s' : 'no connection'}</span>]]} />
            </Card>
          )}
          <Card title="Exim routing (exim -bt)" actions={<StatusPill status={!r.exim.available ? 'not-installed' : r.exim.routable ? 'ok' : 'failed'}>{!r.exim.available ? 'Exim not installed' : r.exim.routable ? 'routable' : 'unrouteable'}</StatusPill>}>
            {!r.exim.available && <p className="muted">{r.exim.reason}</p>}
            {r.exim.available && r.exim.routes && <KeyValue items={r.exim.routes.map((x, i) => [x.address || `route ${i + 1}`, x.error || `router ${x.router || '?'}, transport ${x.transport || '?'}${x.target ? ` → ${x.target}` : ''}`])} />}
            {r.exim.output && <pre className="log">{r.exim.output}</pre>}
            {r.exim.verify && <><h3>Verification (exim -bv)</h3><StatusPill status={r.exim.verify.ok ? 'ok' : 'failed'}>{r.exim.verify.ok ? 'verified' : 'failed'}</StatusPill><pre className="log">{r.exim.verify.output || '(no output)'}</pre></>}
            {r.exim.error && <ErrorBanner error={{ message: r.exim.error }} />}
          </Card>
        </>
      )}
    </>
  );
}
