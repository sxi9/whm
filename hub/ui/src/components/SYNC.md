# Component kit snapshot

These files are **copies** of the panel's shared UI kit, not imports. The panel components reach
into panel-only modules (`api/client.js`, `AuthContext`, `icons.js`, `hooks/useFavorites.js`,
`i18n/useT.js`); a relative import across `client/` and `hub/ui/` would couple two deployables and
break the hub whenever the panel UI moves. **Re-copy by hand, never import across packages.**

Source commit: `2a83117` (branch `claude/kind-meitner-dlnbas`, 2026-11-03) — the Keel design system; the hub's `Shell.jsx` mirrors the panel's sidebar-first layout (`.app` → `.sidebar` + `.app-main`).

| File | Source | Deviation from the source |
|---|---|---|
| `Common.jsx` | `client/src/components/Common.jsx` | `PageHeader` has no favourite star and no i18n (`crumbs`/`home` props instead of `fn.category`); `CapabilityNotice` text is hub-specific (501 = feature not configured); `StatusPill` tone map extended with hub statuses (verified, published, in_review, yanked, revoked, retiring, …) |
| `DataTable.jsx` | `client/src/components/DataTable.jsx` | byte-identical |
| `Form.jsx` | `client/src/components/Form.jsx` | byte-identical |
| `Modal.jsx` | `client/src/components/Modal.jsx` | byte-identical |
| `Toast.jsx` | `client/src/components/Toast.jsx` | byte-identical |
| `ProgressLog.jsx` | `client/src/components/ProgressLog.jsx` | rewritten: the hub has no SSE job stream, so the component polls `jobPath` (`GET /v1/admin/jobs/:id` or `/v1/reseller/jobs/:id`) until `done`/`failed` |
| `ConfigPage.jsx` | `client/src/components/ConfigPage.jsx` | takes `loadPath`/`savePath`/`method` instead of the panel's fixed `/system/settings?prefix=` |
| `ActionPage.jsx` | `client/src/components/ActionPage.jsx` | passes `crumbs`/`home` to `PageHeader` |
| `../styles/tokens.css` | `client/src/theme/tokens.css` | byte-identical |
| `../styles/base.css` | `client/src/theme/base.css` | identical plus the `.impersonation-banner` rules at the end; `hub.css` holds the hub-only additions |
| `../styles/base.css` | `client/src/theme/base.css` | byte-identical (hub additions live in `../styles/hub.css`) |

Hub-native code that is **not** part of the snapshot: `../api/client.js`, `../hooks/*`, `../auth/*`,
`../shell/*`, `../widgets/*`, `../styles/hub.css`.

## Re-sync procedure

1. `cp client/src/components/{DataTable,Form,Modal,Toast}.jsx hub/ui/src/components/` and the two CSS files.
2. Re-apply the deviations listed above to `Common.jsx`, `ConfigPage.jsx`, `ActionPage.jsx`, `ProgressLog.jsx`
   (diff against the previous hub copy first).
3. Update the commit hash above, run `cd hub/ui && npx vitest run && npm run build`.
