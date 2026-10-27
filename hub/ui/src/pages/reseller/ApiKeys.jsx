import { useState } from 'react';
import { PageHeader, Card } from '../../components/Common.jsx';
import { Tabs } from '../../widgets/index.jsx';
import { ApiKeysPanel, WebhooksPanel, RESELLER_API_SCOPES } from '../admin/Integrations.jsx';

export default function ResellerApiKeys() {
  const [tab, setTab] = useState('api-keys');
  return (
    <>
      <PageHeader title="API keys & webhooks" description="Integrate your billing system: issue, renew and revoke through the reseller API; receive license events by webhook." home="/reseller" />
      <Card padded={false}>
        <div style={{ padding: '12px 18px 0' }}><Tabs value={tab} onChange={setTab} tabs={[{ value: 'api-keys', label: 'API keys' }, { value: 'webhooks', label: 'Webhooks' }]} /></div>
        <div className="card-body">
          {tab === 'api-keys' && <><p className="muted">Keys call <code>/v1/reseller/*</code> with <code>Authorization: Bearer whk_…</code>. Creating one requires a fresh two-factor code.</p><ApiKeysPanel base="/reseller" scopes={RESELLER_API_SCOPES} /></>}
          {tab === 'webhooks' && <WebhooksPanel base="/reseller" />}
        </div>
      </Card>
    </>
  );
}
