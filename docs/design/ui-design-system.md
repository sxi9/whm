# Keel UI design system

The panel's visual language (client `client/src/theme/tokens.css` + `base.css`, copied into
`hub/ui/src/styles/`). It follows the conventions of Apple's platform UI: system typography,
grouped inset surfaces, hairline separators, tinted controls, one accent colour, restrained
motion. The goal is a product that looks hand-made and specific, not generic.

## Principles

1. **One accent.** `--primary` (system blue) is the only brand colour in controls. Status uses
   `--ok` / `--warn` / `--bad` and their `-soft` tints. No gradients, no purple, no glass except the
   translucent bars (`--glass`) and toasts.
2. **Surfaces, not boxes.** Content sits on `--bg` (grouped background) in `.card` surfaces with
   `--radius-lg` corners and a hairline `--border`. Inside a card, rows are separated by hairlines,
   never by nested boxes. Avoid borders on borders.
3. **Typography does the hierarchy.** Page title 28/700 tight tracking, card title 17/600, body
   14, secondary 13.5 muted, captions 12.5. No uppercase labels, no letter-spaced small caps.
   Numbers are tabular (`font-variant-numeric: tabular-nums` is set on `td`, `dd`, `.stat .value`).
4. **Controls feel native.** Inputs are filled fields (`--fill`), no border until focus. Switches are
   `.toggle` (green when on). Buttons: `.btn` (grey fill), `.btn-primary`, `.btn-danger`,
   `.btn-ghost` (tinted text), `.btn-danger-ghost`, `.btn-sm`. Segmented control: `.segmented`.
5. **Colour by token only.** No hex/rgb in JSX or page CSS. Category colours come from
   `colorFor(slug)` in `client/src/icons.js` and are applied through `--tile` on `.nav-tile`.
6. **Dark mode is automatic.** Every token has a dark value; a page that only uses tokens needs
   nothing else. Check both schemes.
7. **Motion is brief.** 120–250 ms, `var(--ease)`; press feedback is `scale(0.97)`; sheets and
   menus pop in, nothing slides across the screen.
8. **Write like a person.** Sentence case, specific nouns, no exclamation marks, no emoji, no
   "✨", no "Oops". Empty states say what the screen will show and how to get there.

## Shell

- Sidebar (left, full height, translucent `--chrome`): brand, search, Home, Favorites, then the
  30 categories as rows with a coloured icon tile (`.nav-tile`) and a count. Active items are
  filled with `--chrome-active`.
- Top bar (translucent `--glass`): global search with `Alt /`, hostname chip, audit log, bell, user
  menu. The brand appears here only on phones.
- Content column: max 1320 px, 24/32 px padding; `.page-header` with breadcrumbs, large title,
  favourite star, description, and actions on the right.

## Page patterns

| Need | Use |
|---|---|
| Page chrome | `PageHeader` (`fn` prop) — never hand-written `h1`s |
| Group of settings or a result | `Card` (`title`, `subtitle`, `actions`, `padded={false}` for tables) |
| Key/value facts | `KeyValue` (`.kv`) |
| Lists of records | `DataTable` (search, sort, paging, row actions) inside `Card padded={false}` |
| Numbers at a glance | `.stat-grid` of `.stat` tiles, `.meter` for usage |
| Forms | `Field` + `TextInput`/`Select`/`Toggle`/`PasswordInput`, `.form-grid` for two columns, `FormActions` |
| One-shot actions | `ActionPage` |
| Settings backed by `/system/settings` | `ConfigPage` |
| Notices | `.banner banner-{info,warning,error,success}` with a lucide icon as the first child |
| Status | `StatusPill` |
| Dialogs | `Modal` / `useConfirm()` |
| Progress | `ProgressLog` |
| Code/log output | `pre.log` |

Inline `style={{}}` is acceptable only for one-off layout (a width, a gap, `marginTop`), never for
colours, fonts, radii or shadows. Prefer the utility classes: `.muted`, `.align-right`, `.grid-2`,
`.list-plain`, `.form-narrow`, `.row-actions`.

## Phones (≤ 640 px)

`base.css` ends with one additive `@media (max-width: 640px)` block; desktop rendering never
changes and no class is renamed. What it does, and the rules a page must follow to stay inside it:

- **Nothing scrolls sideways.** `e2e/panel-check.cjs` opens the home page and every account-panel
  function at 390×844 and fails on `document.documentElement.scrollWidth > innerWidth`, on header
  actions outside the viewport, and on a visible keyboard hint. Tables are the one exception:
  they scroll inside `.table-wrap`, so every table stays inside one.
- **Header and hero stack.** `.page-header` and `.home-hero` become columns; `.page-header-actions`
  wraps. Keep header actions to two or three buttons; a page with more collapses the rest into the
  kit's row menu (`RowActions` from `DataTable.jsx`, see the file manager's `.fm-actions-compact`).
- **Fluid search.** `.search .input` loses its fixed width (`280px` / `220px` on desktop) and fills
  its row; `.card-header`, `.card-actions`, `.datatable-actions`, `.datatable-footer`, `.form-actions`
  and `.modal-footer` wrap; `.segmented` wraps.
- **Key/value lists** (`.kv`) go single column, value under label, left aligned.
- **Top bar.** The account name next to the avatar is hidden (`.user-menu .user-name`) and the
  keyboard hint (`<kbd class="kbd-hint">`) is hidden here and under `(pointer: coarse)`; the
  `Alt /` shortcut still works.
- **Fixed widths in JSX** are the usual cause of a failure: put the width on a class in `base.css`
  (`.fm-path-go { width: 300px }`) and override it in the phone block, never `style={{ width }}`
  on something that must shrink.

## Naming

The product is **Keel** (default `branding.company_name`; operators change it under
Panel › Customization). The admin console is "the panel" or "Keel"; the account holder's
interface is "the account panel". The words *cPanel* and *WHM* appear only when they mean the
external cPanel product (migration sources, cpmove archives, API compatibility notes).
Function keys, routes, API prefixes, settings keys and plugin ids never change when a label
changes — pin the slug in `client/src/nav.js` instead.

## Menus

Every popover menu (a row's ⋯ actions, the user menu, any dropdown of commands) is built on `hooks/useMenu.js` through `components/Menu.jsx`. A menu opens on click or ArrowDown, never on hover, and is never closed by the pointer leaving anything: it closes on a press outside the trigger and the menu, on Escape (focus returns to the trigger), on Tab (focus returns to the trigger first so the native Tab continues from there), on a route change and, for a floating menu, it follows the trigger on scroll and resize (useMenu's `closeOnScroll` option closes instead when a consumer uses the hook directly). The trigger carries `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`; the list is `role="menu"` with `role="menuitem"` entries, and ArrowDown/ArrowUp/Home/End move between them. Floating menus are portalled to `<body>` (`theme/menu.css`) so cards and scrolling tables never clip them; they flip above the trigger near the bottom of the viewport.
