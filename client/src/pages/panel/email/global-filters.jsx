import { FiltersPanel } from './parts/Filters.jsx';
import { InfoNote, useEmailT } from './parts/Shared.jsx';

// Account-wide filters: one script that runs before each mailbox's own filters.
export default function GlobalFilters({ fn }) {
  const { t } = useEmailT();
  return (
    <FiltersPanel fn={fn} base="/email/global-filters" intro={<InfoNote>{t('panel.email.global_filters.intro', "These rules run for every mailbox on this account before the mailbox's own filters.")}</InfoNote>} />
  );
}
