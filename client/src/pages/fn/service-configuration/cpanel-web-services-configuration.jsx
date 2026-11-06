import { Info } from 'lucide-react';
import { PageHeader, Card, Loading, formatDate } from '../../../components/Common.jsx';
import { Field, NumberInput, Toggle } from '../../../components/Form.jsx';
import { useSettingsForm, SaveBar, RequestError, ListEditor } from '../../service-config/Shared.jsx';

export default function WebServicesConfiguration({ fn }) {
  const form = useSettingsForm('/service-config/webservices');
  const { data, draft, set } = form;
  return (
    <>
      <PageHeader fn={fn} title={fn.label} description="Tuning for the panel's own HTTP services (ports 2086/2087 and the JSON API): token and session lifetimes, request limits, CORS origins and logging." />
      <RequestError error={form.error} onRetry={form.refetch} />
      {form.loading && !data && <Loading />}
      {data && draft && (
        <>
          {data.live === false && <div className="banner banner-info"><Info size={18} /><div><strong>Stored, not applied yet.</strong> Session and token lifetimes, rate limits, CORS, compression and the listen address are still governed by the panel's own configuration file; this page records the intended values for when the API server consumes them.</div></div>}
          <Card title="API" className="config-fields" subtitle={data.lastUpdate ? `Last changed ${formatDate(data.lastUpdate)}` : undefined}>
            <Field inline><Toggle checked={draft.apiEnabled} onChange={set('apiEnabled')} label="JSON API for API tokens" description="Lets API tokens call the JSON API" /></Field>
            <div className="form-grid">
              <Field label="API token lifetime (minutes)" help="Minutes; applies to newly issued tokens"><NumberInput value={draft.tokenLifetimeMinutes} onChange={set('tokenLifetimeMinutes')} min={5} nullable={false} /></Field>
              <Field label="Browser session timeout (minutes)" help="5 to 10080 minutes (one week)"><NumberInput value={draft.sessionTimeoutMinutes} onChange={set('sessionTimeoutMinutes')} min={5} max={10080} nullable={false} /></Field>
              <Field label="Rate limit (requests / minute / IP)"><NumberInput value={draft.rateLimitPerMinute} onChange={set('rateLimitPerMinute')} min={1} nullable={false} /></Field>
              <Field label="Maximum concurrent requests"><NumberInput value={draft.maxConcurrentRequests} onChange={set('maxConcurrentRequests')} min={1} nullable={false} /></Field>
              <Field label="Request log retention (days)" help="1 to 3650 days"><NumberInput value={draft.requestLogRetentionDays} onChange={set('requestLogRetentionDays')} min={1} max={3650} nullable={false} /></Field>
            </div>
            <Field label="Allowed cross-origin origins" help="One origin per line (https://host[:port]); empty = same origin only"><ListEditor value={draft.allowedOrigins} onChange={set('allowedOrigins')} placeholder="https://panel.example.com" /></Field>
          </Card>
          <Card title="Transport" className="config-fields">
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
