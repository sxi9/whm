# Sample Notes (`net.whm.sample-notes`)

The reference plugin for the WHM plugin SDK. It is a small per-server notebook, and it is
deliberately boring: every feature exists to show one extension point of `plugins/SDK.md`.

| Extension point | Where |
|---|---|
| Settings, one field of every type | `plugin.json` → `settings.fields` (`text`, `number`, `select`, `multiselect`, `toggle`, `password`, `cron`, `textarea`) |
| Cancellable `pre` hook + `post` hooks | `hooks.beforeAccountCreated` (refuses blocked usernames with `evt.cancel()`), `afterAccountCreated` (welcome note), `afterAccountTerminated` (drops the account's notes) |
| Jobs, cancellable and not | `jobs.digest` (`cancellable: true`), `jobs.housekeeping` (`cancellable: false`) |
| Cron, setting-bound and fixed | `cron[0].schedule = "setting:digestSchedule"`, `cron[1].schedule = "30 3 * * *"` |
| Pages of every kind | `ui.pages`: table (`/`), form (`/new`), settings, action (`/digest`), markdown (`/about`), html (`/widget`); `/schedules` (markdown) is registered at runtime with `ctx.ui.registerPage` |
| Routes with roles | `routes()`: `GET/POST /notes` for root and resellers (resellers scoped to their accounts), `DELETE /notes/:id`, `/status`, `/export`, `POST /digest` root only |
| Store | kv entries (`installedAt`, `digest:last`, `webhook:token`) and the `notes` collection |
| fs | `exports/latest-digest.json` in the plugin data directory |
| crypto | the webhook token mirrored into the store with `ctx.crypto.encrypt` |
| net.fetch | `POST https://hooks.example.net/whm-notes` under `net:outbound:hooks.example.net` |
| events | `net.whm.sample-notes.note_created`, `net.whm.sample-notes.digest_sent` |
| i18n | `locales/en.json`, `locales/de.json`; `ctx.i18n.t()` with `{placeholders}` |
| migrate(from) | 1.0.x notes gain `tags` and a valid `category` |

## Developing

```
cd plugins/sample-plugin
npm test                                  # node --test against the SDK mock host
node ../../scripts/build-plugin.js . --out dist/sample-notes.whmplugin
node ../../scripts/build-plugin.js . --sign test/fixtures/dev.pem --dev   # DEV-SIGNATURE.json for a marketplace upload
npm run fixtures                          # regenerate test/fixtures/sample-notes-signed.whmplugin
```

`test/fixtures/` holds a fixture developer key (`dev.pem`/`dev.pub`, test-only) and the plugin packed
with a `DEV-SIGNATURE.json` from that key. The hub's upload tests and the panel's marketplace install
tests consume it; `test/fixture.test.js` fails when the plugin changed and the fixture was not
regenerated. The plugin is distributed through the marketplace under the vendor developer `net.whm`;
it is not a bundled plugin.
