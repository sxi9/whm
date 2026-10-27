# Automated Backup (`net.whm.automated-backup`)

A bundled plugin (installed and enabled at boot by the Plugins category, exempt from the
package-signature gates like the other bundled plugins) that runs scheduled account backups on
top of the host backup API. Its pages live under **Backup › Automated Backup** in the sidebar.

## What a run does

1. Selects accounts per the **Back up** setting: all accounts, accounts on the listed packages, or
   the listed accounts (unknown names become run warnings).
2. Resolves the **Destination ids** against `ctx.api.backups.destinations.list()`; an unknown id is
   skipped with a warning (`unknown_destination`). Copy ids from the *Backup destinations* page.
3. For each account, up to **max_parallel** at a time: takes the per-account lock
   (`lock:<account>` in the plugin store, TTL **lock_ttl_minutes**; lock acquisition is
   serialised per account inside the plugin process, so a scheduled run and a manual `POST /run`
   started together back up an account once; a live lock skips the account with a `locked`
   warning, an expired one is taken over), creates the archive, verifies it when
   **verify** is on, uploads it to every destination, records it in the `artefacts` collection and
   releases the lock.
4. Applies retention (below), writes the run to the `runs` history and notifies the server
   contacts per **notify_on** (`failure` by default).

Cancelling the run job stops before the next account; locks are released in any case.

## Retention

Retention keeps, per account, the newest archive of the last **retention_daily** distinct days,
the newest of the last **retention_weekly** ISO weeks and the newest of the last
**retention_monthly** months, and deletes every other local archive *the plugin created* through
`ctx.api.backups.delete`. Archives recorded from host-initiated backups (the Backup category or
other plugins, seen through the `backup.completed` hook) are listed in the history but never pruned.
When an account is terminated its locks, artefact rows and run rows (host-initiated and restore
runs, which carry `account`) are dropped.

**Remote copies are governed by the destination's own retention.** The host has no API to remove
a copy from a destination, so when a local archive is pruned its uploads are recorded as
`remote: 'retained'` in the run history and left in place. `ctx.api.backups.delete` removes the
local artefact only.

## Encryption

This panel version only produces gzip-compressed, unencrypted archives (`COMPRESSIONS = ['gzip']`;
`encrypt: true` answers `UNSUPPORTED`). The **encrypt** toggle requests encryption from the host;
when the host refuses, the archive is written unencrypted and the run carries an
`encrypt_unsupported` warning. The plugin cannot encrypt the bytes itself: `ctx.fs` is its own
data directory and archives are not readable through the SDK.

## Restore

Restores need a single-use confirm token issued to root for exactly one archive and account:

```
POST /api/plugins/manage/net.whm.automated-backup/restore-token { "artefactId": "…", "account": "…" }
POST /api/plugins/net.whm.automated-backup/restore { "artefactId": "…", "account": "…", "confirmToken": "…" }
```

The *Restore an archive* page is that second call. The route keeps the token in memory under a
random single-use reference (for the token's own 10-minute lifetime) and enqueues only that
reference, so the token never lands in the host's persisted job params, the run history or the
store; the job redeems the reference once. A bad, expired or already-used token — or a reference
orphaned by a panel restart — fails the restore job with `PERMISSION_DENIED`, which the history
records; request a new token.

## Routes (root only)

| Route | Purpose |
|---|---|
| `GET /status` | scope, schedule, next/last run, live locks, archive count |
| `GET /runs?limit=&kind=` | run history (`run`, `prune`, `restore`, `host`) |
| `GET /artefacts?account=&local=` | archives known to the plugin (the *Archives* page) |
| `GET /locks` · `POST /locks/:account/release` | live locks; release a stale one |
| `GET /destinations` | configured destinations with a `selected` flag |
| `POST /run { accounts? }` · `POST /prune` · `POST /restore` | start the jobs (`202 { job }`) |

## Scheduling

The **schedule** cron setting binds the `scheduled-run` schedule; leaving it empty disables
scheduled runs (the *Run backups now* action still works). Settings are read at the start of each
run, so changes apply to the next run.

```
cd plugins/bundled/net.whm.automated-backup && npm test     # node --test "test/*.test.js"
```

`node --test` needs the file glob; a bare directory argument fails with `MODULE_NOT_FOUND`.
