import { useSearchParams } from 'react-router-dom';
import { Card } from '../../../components/Common.jsx';
import { Field, Select } from '../../../components/Form.jsx';
import { PanelPage } from '../../../panel/PanelPage.jsx';
import { usePanelApi } from '../../../panel/hooks/usePanel.js';
import { PanelRequestError, InfoNote, useEmailT } from './parts/Shared.jsx';
import { FiltersPanel } from './parts/Filters.jsx';

// Per-mailbox filters: pick a mailbox (kept in ?mailbox=), then the shared
// panel lists and edits that mailbox's filters.
export default function Filters({ fn }) {
  const { t } = useEmailT();
  const [params, setParams] = useSearchParams();
  const selected = params.get('mailbox') || '';
  const { data, error, loading, refetch } = usePanelApi('/email/accounts?usage=false&pageSize=200');
  const mailboxes = data || [];
  const current = mailboxes.find((m) => String(m.id) === selected) || null;
  const picker = (
    <Card>
      <Field label={t('panel.email.common.mailbox', 'Mailbox')} help={t('panel.email.filters.mailbox_help', 'Filters belong to one mailbox; account-wide rules live under Account-wide filters.')}>
        <Select value={selected} onChange={(v) => setParams(v ? { mailbox: v } : {})} options={mailboxes.map((m) => ({ value: String(m.id), label: m.address }))} placeholder={loading ? t('panel.email.filters.loading_mailboxes', 'Loading mailboxes…') : t('panel.email.filters.choose_mailbox', 'Choose a mailbox')} aria-label={t('panel.email.common.mailbox', 'Mailbox')} disabled={loading || !mailboxes.length} />
      </Field>
      {!loading && !error && !mailboxes.length && <InfoNote>{t('panel.email.filters.no_mailboxes', 'Create a mailbox under Email accounts first; filters are attached to a mailbox.')}</InfoNote>}
    </Card>
  );
  if (error) {
    return <PanelPage fn={fn}><Card padded={false}><PanelRequestError error={error} fn={fn} onRetry={refetch} /></Card></PanelPage>;
  }
  if (!current) {
    return <PanelPage fn={fn}>{picker}</PanelPage>;
  }
  return (
    <FiltersPanel fn={fn} base="/email/filters" qs={`?mailbox=${current.id}`} intro={<InfoNote>{t('panel.email.filters.intro_1', 'Filters of')} <code>{current.address}</code>{t('panel.email.filters.intro_2', ', applied as mail arrives and after the account-wide filters.')}</InfoNote>}>
      {picker}
    </FiltersPanel>
  );
}
