import { useState } from 'react';
import { Search, Route } from 'lucide-react';
import { Card, EmptyState, StatusPill } from '../../../components/Common.jsx';
import { Field, TextInput, Select, Button, FormActions, ErrorBanner } from '../../../components/Form.jsx';
import { PanelPage, PanelCapabilityState, FeatureDisabledState } from '../../../panel/PanelPage.jsx';
import { panelApi, usePanelMe } from '../../../panel/hooks/usePanel.js';
import { queryString } from '../../../api/client.js';
import { useT } from '../../../i18n/useT.js';
import { fill } from '../../../i18n/fill.js';
import { isCapabilityError, isFeatureDisabled } from '../files/parts/paths.js';

export const LOOKUP_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR'];

// The same shape the API validates: a hostname with at least one dot or a
// literal address. Checked here only to spare a round trip; the server and
// the agent each check again.
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]{2,39}$/i;
export const isTarget = (v) => { const s = String(v ?? '').trim(); return HOST_RE.test(s) || IPV4_RE.test(s) || (s.includes(':') && IPV6_RE.test(s)); };

const ms = (n) => `${Number(n).toFixed(n >= 100 ? 0 : 1)} ms`;

export function LookupResult({ result }) {
  const { t } = useT();
  if (!result) return null;
  const title = fill(t('panel.dnstrack.lookup_result', '{type} records of {name}'), { type: result.type, name: result.name });
  if (result.error === 'timeout') {
    return <EmptyState icon={Search} title={title}><p>{t('panel.dnstrack.lookup_timeout', 'No name server answered in time.')}</p></EmptyState>;
  }
  if (!result.answers.length) {
    return <EmptyState icon={Search} title={title}><p>{t('panel.dnstrack.lookup_empty', 'No records of this type were found.')}</p></EmptyState>;
  }
  return (
    <div className="table-wrap" data-lookup={result.name}>
      <table className="table">
        <thead><tr><th>{t('panel.dnstrack.col_type', 'Type')}</th><th>{t('panel.dnstrack.col_answer', 'Answer')}</th></tr></thead>
        <tbody>
          {result.answers.map((a, i) => <tr key={i}><td><code>{result.type}</code></td><td><code>{a}</code></td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function TraceResult({ result }) {
  const { t } = useT();
  if (!result) return null;
  if (result.error === 'unknown_host') return <ErrorBanner error={{ message: fill(t('panel.dnstrack.trace_unknown_host', '{host} could not be resolved.'), { host: result.host }) }} />;
  if (result.error === 'timeout' && !result.hops.length) return <ErrorBanner error={{ message: t('panel.dnstrack.trace_timeout', 'The trace did not finish within 60 seconds.') }} />;
  const summary = result.reached
    ? fill(t('panel.dnstrack.trace_reached', 'Reached {target} in {count} hops.'), { target: result.target || result.host, count: result.hops.length })
    : fill(t('panel.dnstrack.trace_not_reached', '{host} was not reached within {count} hops.'), { host: result.target || result.host, count: result.hops.length });
  return (
    <div data-trace={result.host}>
      <p>
        <StatusPill status={result.reached ? 'ok' : 'warning'}>{result.reached ? t('panel.dnstrack.reached', 'Reached') : t('panel.dnstrack.not_reached', 'Not reached')}</StatusPill>{' '}
        {summary}
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('panel.dnstrack.col_hop', 'Hop')}</th><th>{t('panel.dnstrack.col_address', 'Address')}</th><th>{t('panel.dnstrack.col_rtt', 'Round trip')}</th></tr></thead>
          <tbody>
            {result.hops.map((h) => (
              <tr key={h.hop}>
                <td>{h.hop}</td>
                <td>{h.addresses.length ? h.addresses.map((a) => <code key={a} style={{ marginRight: 6 }}>{a}</code>) : <span className="muted">{t('panel.dnstrack.no_reply', 'no reply')}</span>}</td>
                <td>{h.rtts.length ? h.rtts.map(ms).join('  ') : ''}{h.timeouts ? <span className="muted">{h.rtts.length ? '  ' : ''}{'*'.repeat(h.timeouts)}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function TrackDns({ fn }) {
  const { t } = useT();
  const { me } = usePanelMe();
  const [lookup, setLookup] = useState({ name: me?.account?.domain || '', type: 'A' });
  const [lookupState, setLookupState] = useState({ loading: false, error: null, result: null });
  const [trace, setTrace] = useState({ host: me?.account?.domain || '' });
  const [traceState, setTraceState] = useState({ loading: false, error: null, result: null });

  const run = async (path, params, setState) => {
    setState({ loading: true, error: null, result: null });
    try {
      const res = await panelApi.get(`/dns/track/${path}${queryString(params)}`);
      setState({ loading: false, error: null, result: res.data });
    } catch (error) {
      setState({ loading: false, error, result: null });
    }
  };
  const submitLookup = (e) => { e.preventDefault(); run('lookup', { name: lookup.name.trim().toLowerCase(), type: lookup.type }, setLookupState); };
  const submitTrace = (e) => { e.preventDefault(); run('trace', { host: trace.host.trim().toLowerCase() }, setTraceState); };

  const blocking = [lookupState.error, traceState.error].find((err) => isFeatureDisabled(err) || isCapabilityError(err));
  if (isFeatureDisabled(blocking)) return <PanelPage fn={fn}><FeatureDisabledState fn={fn} /></PanelPage>;

  const typeOptions = LOOKUP_TYPES.map((v) => ({ value: v, label: v }));
  return (
    <PanelPage fn={fn}>
      <Card title={t('panel.dnstrack.lookup_title', 'Domain lookup')} subtitle={t('panel.dnstrack.lookup_help', 'Ask the name servers this server uses for the records of any domain.')}>
        <PanelCapabilityState error={isCapabilityError(lookupState.error) ? lookupState.error : null} />
        <form onSubmit={submitLookup}>
          <div className="form-grid">
          <Field label={t('panel.dnstrack.name', 'Domain or host')} htmlFor="dnstrack-name">
            <TextInput id="dnstrack-name" value={lookup.name} onChange={(v) => setLookup((s) => ({ ...s, name: v }))} placeholder="example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t('panel.dnstrack.type', 'Record type')} htmlFor="dnstrack-type">
            <Select id="dnstrack-type" value={lookup.type} onChange={(v) => setLookup((s) => ({ ...s, type: v }))} options={typeOptions} />
          </Field>
          </div>
          <FormActions><Button type="submit" variant="primary" icon={Search} loading={lookupState.loading} disabled={!isTarget(lookup.name)}>{t('panel.dnstrack.lookup', 'Look up')}</Button></FormActions>
        </form>
        {lookupState.error && !isCapabilityError(lookupState.error) && <ErrorBanner error={lookupState.error} />}
        <LookupResult result={lookupState.result} />
      </Card>

      <Card title={t('panel.dnstrack.trace_title', 'Trace route')} subtitle={t('panel.dnstrack.trace_help', 'Show the path packets take from this server to a host, hop by hop. A trace takes up to a minute.')}>
        <PanelCapabilityState error={isCapabilityError(traceState.error) ? traceState.error : null} />
        <form onSubmit={submitTrace}>
          <div className="form-grid">
          <Field label={t('panel.dnstrack.host', 'Host or IP address')} htmlFor="dnstrack-host">
            <TextInput id="dnstrack-host" value={trace.host} onChange={(v) => setTrace({ host: v })} placeholder="example.com" autoComplete="off" spellCheck={false} />
          </Field>
          </div>
          <FormActions><Button type="submit" variant="primary" icon={Route} loading={traceState.loading} disabled={!isTarget(trace.host)}>{t('panel.dnstrack.trace', 'Trace')}</Button></FormActions>
        </form>
        {traceState.loading && <p className="muted">{t('panel.dnstrack.tracing', 'Tracing… this can take up to a minute.')}</p>}
        {traceState.error && !isCapabilityError(traceState.error) && <ErrorBanner error={traceState.error} />}
        <TraceResult result={traceState.result} />
      </Card>
    </PanelPage>
  );
}
