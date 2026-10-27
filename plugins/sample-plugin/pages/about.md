# Sample Notes

A reference plugin for the WHM plugin SDK. It keeps short notes per server, writes a daily
digest and demonstrates every extension point the SDK offers:

- **Settings** of every field type (text, number, select, multiselect, toggle, password, cron, textarea)
- **Hooks**: a cancellable `pre` hook on `account.created` (blocked usernames), `post` hooks on
  `account.created` and `account.terminated`
- **Jobs**: a cancellable `digest` job and a non-cancellable `housekeeping` job
- **Cron**: a setting-bound schedule (`setting:digestSchedule`) and a fixed one (`30 3 * * *`)
- **Pages**: table, form, settings, action, markdown and html
- **Routes** with per-route roles under `/api/plugins/net.whm.sample-notes/`
- **Store** key/value entries and the `notes` collection, **fs** exports, **crypto** for the webhook
  token, **net.fetch** to `hooks.example.net`, **events** in its own namespace, **i18n** (en, de)
  and a **migration** from 1.0.x

The source lives in `plugins/sample-plugin/` and is documented in `plugins/SDK.md`.
