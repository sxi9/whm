# Account panel shell (`/panel`)

The customer-facing side of the product (design of record: `docs/design/customer-panel.md`,
§6). Same process, same design system, its own navigation: one hosting account per session.

## Files

| File | Role |
|---|---|
| `nav.js` | `PANEL_CATEGORY_DEFS` → `buildNav(defs, { basePath: '/panel', keyPrefix: 'panel' })`. Exports `PANEL_CATEGORIES`, `PANEL_FUNCTIONS`, `PANEL_FUNCTION_BY_KEY/BY_PATH`, `searchPanelFunctions(q, features)`, `visibleCategories(features)`, `featureEnabled`, `panelId(fn)`, `PANEL_PATHS`. Import-free ESM: `e2e/panel-check.cjs` loads it from Node. `buildNav` with the defaults reproduces the 212 admin entries of `client/src/nav.js` byte for byte (`test/panel-nav.test.js`); the integrator moves it there. |
| `icons.js` | `panelIconFor(name)`, `panelColorFor(slug)` — the group tiles (`.nav-tile`, `--tile`). |
| `registry.js` | `PANEL_PAGE_REGISTRY` from `import.meta.glob('../pages/panel/*/*.jsx')`. |
| `routes.jsx` | `panelRoutes` — spread into `createBrowserRouter([...])` **before** the admin `/` entry. |
| `PanelLayout.jsx` | auth gate (`panelRedirect`), `GET /api/panel/me` once, `ShellContext` + `PanelContext`, `PanelShell` (sidebar, top bar, banners, outlet, footer), full-page `PanelDisabledPage` on `panel_disabled` / `no_account` / `panel_scope_required`. |
| `PanelSidebar.jsx`, `PanelTopBar.jsx`, `PanelBanners.jsx`, `PanelHome.jsx` | the shell; favorites under `whm.panel.favorites`, sidebar state under `whm.panel.sidebar.*` (every `localStorage` access is guarded). |
| `PanelPage.jsx` | `PanelPage` / `PanelPageHeader` (breadcrumbs to `/panel`, `panel.` i18n prefix, panel favorites), `PanelCapabilityState` (501), `PendingPill` (`applied:false`), `FeatureDisabledState` (403 `feature_disabled`), `PanelFunctionPage` (placeholder), `PanelNotFoundPage`. |
| `hooks/usePanelPlugins.js`, `PanelPluginPage.jsx` | `PanelPluginProvider` (in `PanelLayout`, gated by `hasFeature('plugins')`) loads `GET /api/panel/plugins/ui`; `panelPluginEntries` / `withPluginEntries` append the pages of enabled plugins to the Software group for the sidebar, home grid and search; `PanelPluginPage` serves `plugins/:pluginId/*` with `pages/plugins/PluginPage.jsx`'s `PluginPageView` pointed at `/panel/plugins/<id>` (contract §53). |
| `hooks/usePanel.js` | `usePanelMe()` (`{ me, loading, error, reload, hasFeature }`), `usePanelApi('/domains')` (= `useApi('/panel/domains')`), `panelApi.get/post/put/patch/delete`, `useScopeBanner()`, `usePanelFavorites()`, `percentOf`, `meterTone`. |
| `ShellContext.js` | `ADMIN_SHELL` (default) / `PANEL_SHELL`; `useShell()`. `components/Common.jsx`'s `PageHeader` reads it once the integrator wires that one line. |
| `../auth/home.js` | `homePathFor(user)`, `inShellFor(user, path)`, `landingFor(user, from)` for `Login.jsx` / `Layout.jsx`. |

## Adding a page (U6 builders, one group each)

1. Find the function in `nav.js` (`PANEL_CATEGORY_DEFS`): group slug + function slug, e.g.
   `email` / `forwarders` → key `panel:email/forwarders`, path `/panel/email/forwarders`.
2. Create `client/src/pages/panel/<group>/<function>.jsx`, default-exporting `({ fn })`:

```jsx
import { Card } from '../../../components/Common.jsx';
import { PanelPage, PanelCapabilityState } from '../../../panel/PanelPage.jsx';
import { usePanelApi } from '../../../panel/hooks/usePanel.js';

export default function Forwarders({ fn }) {
  const { data, error, loading, refetch } = usePanelApi('/email/forwarders');
  return (
    <PanelPage fn={fn}>
      <Card padded={false}>
        <PanelCapabilityState error={error} onRetry={refetch} />
        {/* DataTable from components/DataTable.jsx, forms from components/Form.jsx */}
      </Card>
    </PanelPage>
  );
}
```

3. Shared pieces of a group go one directory deeper (`pages/panel/<group>/parts/*.jsx`): the
   registry glob matches depth two only, so they never become routes.
4. Rules: only the shared kit (`Card`, `KeyValue`, `StatusPill`, `EmptyState`, `DataTable`,
   `Form.jsx` fields, `Modal`/`useConfirm`, `useToast`, `ProgressLog`) and `base.css` classes;
   no page CSS, no hex colours, icons imported by name, tables inside `.table-wrap`. Mutations go
   through `panelApi.*` and show `PendingPill` when the API answers `applied:false`. A 403
   `feature_disabled` renders `FeatureDisabledState`; a 501 renders `PanelCapabilityState`. Labels
   come from `t('panel.<group>/<function>.label', fn.label)` (keys in `i18n/en.json`).
5. Tests: `client/test/panel-<group>.test.js(x)` with `renderToStaticMarkup` + `MemoryRouter`
   (no jsdom); mock `../src/auth/AuthContext.jsx` and provide `PanelContext` with a fixture `me`.

## Session shape

`GET /api/panel/me` → `{ user, account: { username, domain, ip, package, plan, features, limits,
suspended, forcePasswordChange, demoMode, contactEmail, homeDir, shell, createdAt, domains[] },
usage, counts, actingAs: null | { account, by, expiresAt }, policy: { require2fa,
passwordSynced }, hostname, csrfToken }` — see `docs/design/customer-panel.md` §4.1.
