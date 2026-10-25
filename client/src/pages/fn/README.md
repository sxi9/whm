# Function pages (auto-registered)

Put a page at `fn/<category-slug>/<function-slug>.jsx` and it is routed automatically —
the path is the function key from `client/src/nav.js` (e.g.
`fn/dns-functions/dns-zone-manager.jsx` → `/dns-functions/dns-zone-manager`).

```jsx
import { PageHeader, Card } from '../../../components/Common.jsx';

export default function DnsZoneManager({ fn }) {   // fn = the nav.js entry (label, description, key…)
  return (
    <>
      <PageHeader fn={fn} />
      <Card>…</Card>
    </>
  );
}
```

Share implementation between related pages by putting components in a sibling domain
folder (e.g. `pages/dns/ZoneEditor.jsx`) and importing them; the `fn/` file stays the
thin, routed entry point. Use the shared building blocks in `components/`:
`DataTable`/`useTableState`, `Form` fields, `ConfigPage` (settings-backed forms),
`ActionPage` (one-button actions with result log), `ProgressLog` (job SSE), `Modal`/
`useConfirm`, `useToast`, `useApi`/`useMutation`, `CapabilityNotice`.
