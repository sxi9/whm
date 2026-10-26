import { PageHeader, Card, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, NumberInput, Toggle } from '../../../components/Form.jsx';
import { useSettingsForm, SaveBar, RequestError, ListEditor } from '../../service-config/Shared.jsx';

export default function WebServicesConfiguration({ fn }) {
  const form = useSettingsForm('/service-config/webservices');
  const { data, draft, set } = form;
  return (
    <>
      <PageHeader fn={fn} description="Intended tuning for the panel's own HTTP services (ports 2086/2087 and the JSON API): token and session lifetimes, request limits, CORS origins and logging. These values are stored only; the API server does not read them yet, so saving changes nothing about how the panel behaves today." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          {data.live === false && <div className="banner banner-info"><div><strong>Not wired to the running panel.</strong> Session and token lifetimes, rate limits, CORS, compression and the listen address are still governed by the panel's own configuration file; this page records the intended values for when the API server consumes them.</div></div>}
          <Card title="API" className="config-fields" subtitle={data.lastUpdate ? `Last changed ${formatDate(data.lastUpdate)}` : undefined}>
            <Field inline><Toggle checked={draft.apiEnabled} onChange={set('apiEnabled')} label="JSON API for API tokens" description="Intended setting; API tokens keep working regardless of this value for now" /></Field>
            <div className="form-grid">
              <Field label="API token lifetime (minutes)" help="Intended lifetime for newly issued tokens (not enforced yet)"><NumberInput value={draft.tokenLifetimeMinutes} onChange={set('tokenLifetimeMinutes')} min={5} nullable={false} /></Field>
              <Field label="Browser session timeout (minutes)" help="Not enforced yet"><NumberInput value={draft.sessionTimeoutMinutes} onChange={set('sessionTimeoutMinutes')} min={5} max={10080} nullable={false} /></Field>
              <Field label="Rate limit (requests / minute / IP)" help="Not enforced yet"><NumberInput value={draft.rateLimitPerMinute} onChange={set('rateLimitPerMinute')} min={1} nullable={false} /></Field>
              <Field label="Maximum concurrent requests" help="Not enforced yet"><NumberInput value={draft.maxConcurrentRequests} onChange={set('maxConcurrentRequests')} min={1} nullable={false} /></Field>
              <Field label="Request log retention (days)" help="Not enforced yet"><NumberInput value={draft.requestLogRetentionDays} onChange={set('requestLogRetentionDays')} min={1} max={3650} nullable={false} /></Field>
            </div>
            <Field label="Allowed cross-origin origins" help="One origin per line (https://host[:port]); empty = same origin only. Stored, not yet applied to CORS headers"><ListEditor value={draft.allowedOrigins} onChange={set('allowedOrigins')} placeholder="https://panel.example.com" /></Field>
          </Card>
          <Card title="Transport" className="config-fields" subtitle="Stored only; the panel's listeners are configured in its own environment file.">
            <Field inline><Toggle checked={draft.enableCompression} onChange={set('enableCompression')} label="Compress API responses (gzip)" /></Field>
            <Field inline><Toggle checked={draft.ipv6Listen} onChange={set('ipv6Listen')} label="Listen on IPv6 as well as IPv4" /></Field>
            <Field inline><Toggle checked={draft.exposeVersion} onChange={set('exposeVersion')} label="Expose the panel version in the Server header" /></Field>
          </Card>
          <SaveBar form={form} label="Save settings" />
        </>
      )}
    </>
  );
}
