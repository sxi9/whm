# Cloudflare DNS management — design of record

Lets the panel manage a domain's DNS at Cloudflare from DNS Zone Manager: the root
administrator connects one Cloudflare account with an API token, individual zones are
*linked* to the Cloudflare zone of the same name, and from then on every record change made
in the panel is mirrored to Cloudflare. Owner's ask: "bind Cloudflare DNS management in this
for easy DNS management".

## Model

| Zone `provider` | Who answers queries | What the panel does on a change |
|---|---|---|
| `bind` (default) | BIND on this server (as before) | render → `named-checkzone` → write → `rndc reload` |
| `cloudflare` | BIND still serves the zone locally **and** Cloudflare holds a mirror; whichever the domain's nameservers point at is authoritative on the internet | same BIND publish, then the job `dns.cloudflare.push` sends the records to Cloudflare |

- **SQLite stays the source of truth** for records. BIND files and the Cloudflare zone are
  both rendered from it. A failed BIND publish still rolls the DB back (nothing is pushed);
  a failed Cloudflare push leaves the DB and BIND as they are and is reported on the zone.
- **Linking is per zone** (`dns_zones.provider`, `cloudflare_zone_id`). The Cloudflare zone
  must already exist in the account (the panel never creates or deletes Cloudflare zones)
  and its name must equal the panel zone's domain. Unlinking only flips the panel back to
  `bind`; nothing is deleted at Cloudflare. Deleting a panel zone likewise leaves Cloudflare
  untouched.
- **A `cloudflare` zone stays editable on a host without BIND** (`assertPublishable(domain)`
  and `publish()` skip the BIND requirement for it), so a Cloudflare-only setup works in
  production; the publish result then says `applied: false` for BIND and carries
  `mirror: { provider: 'cloudflare', jobId }`.
- **Nameservers:** the panel does not change the domain's delegation. Until the registrar
  points the domain at Cloudflare's nameservers (shown in the account zone list), BIND keeps
  answering; after that, Cloudflare does and BIND is a warm standby. The Nameserver Record
  Report shows which is live.

## Record mapping (`services/dns-cloudflare.js`, pure functions, unit-tested)

| Panel | Cloudflare | Notes |
|---|---|---|
| name `@` / `www` / `*` | `example.com` / `www.example.com` / `*.example.com` | names outside the zone are skipped on import |
| ttl `null` | `ttl: 1` (auto) | explicit TTLs are clamped to 60–86400 and logged in the job |
| A, AAAA | `content` | AAAA values are canonicalised (compressed, lowercase — the form Cloudflare stores) on both sides, so `2001:db8:0:0:0:0:0:1` pairs with `2001:db8::1` |
| CNAME, NS, PTR | `content` (no trailing dot) | apex NS are never pushed or imported: Cloudflare manages its own; BIND keeps the panel's |
| MX | `content` + `priority` | — |
| TXT | `content` | Cloudflare returns TXT quoted (`"a" "b"`); the panel stores bare text and sends it unquoted |
| SRV | `data: { priority, weight, port, target }` | panel value `weight port target.`; a response without `data` is parsed from `content` (3 or 4 fields) |
| CAA | `data: { flags, tag, value }` | panel value `flags tag value` |
| HTTPS, SVCB, TLSA, … | — | skipped on import and never deleted on push (unmanaged types) |
| SOA | — | local only |

Import additionally runs the panel's own validation and `checkConflicts` (an apex CNAME,
which Cloudflare flattens but BIND rejects, is skipped with a reason), then stores the result
through `ctx.dns.replaceRecordsFromProvider` (keeps the SOA and apex NS, bumps the serial,
publishes to BIND **without** mirroring back).

## Push = minimal diff

`diffRecords(desired, remote)` pairs records by `(type, name, content)`:
paired records are **updated** (PATCH) only when ttl or priority differ, keeping the remote
record's `proxied` flag; unpaired panel records are **created** (DNS-only, `proxied: false`);
unpaired remote records of managed types are **deleted**. Records are applied one by one so
a failure mid-way leaves a consistent subset that the retry completes. A **proxied**
(orange-cloud) record keeps Cloudflare's Auto TTL: Cloudflare pins it to `1` whatever is sent,
so its TTL is neither compared nor sent (the names whose panel TTL was ignored are logged once
per push as `proxiedTtl`); otherwise the diff would never converge.

**One push or import per zone at a time** (`withZoneLock`, an in-process promise chain per
domain): the job runner claims a second push for the same domain while the first is still
writing, and a diff computed from a listing taken before the first job's writes landed would
undo or duplicate them. The desired set is read only once the lock is held.

The push runs in the job `dns.cloudflare.push` (`runPushJob`): up to `dns.cloudflare.push_attempts`
(default 3) attempts. **Retry policy:** only rate limits (429), Cloudflare 5xx and network
errors/timeouts are retried; a deterministic answer (400, 401 revoked token, 403 missing
DNS:Edit, 404 zone gone, 422, or a panel-side 404/409 such as zone unlinked or token removed)
fails after the first attempt. The wait between attempts is `dns.cloudflare.retry_backoff_ms`
(default `[5000, 20000, 60000]`) or Cloudflare's `Retry-After`, capped at 60 s. A wait of at
most 5 s from the backoff table is slept inside the job; **anything longer, and every
`Retry-After`, releases the worker slot**: the job ends as failed with
`… — retry scheduled in N s`, a timer (one per domain) enqueues a fresh job with
`{ attempt: n + 1, retryOf }` when the wait is over, and that job continues the attempt count.
`GET …/cloudflare` reports `pendingRetry: { at, attempt }` meanwhile. A pending timer is lost on
a panel restart; the zone then stays `failed` until the next change or a manual push.

Every attempt is recorded in `dns_cloudflare_sync`; the zone row carries `cloudflare_status`
(`linked` → `pending` → `ok` | `failed`), `cloudflare_synced_at` and `cloudflare_last_error`.
A push already **queued** for the same domain **by the same principal** is reused, so a burst
of edits produces one job; another principal's queued job is never reused (the jobs API hides
other principals' jobs, so a reseller must not be handed root's job id) and a *running* job is
never reused (its listing may predate the change) — the per-zone lock serialises the two and
the second push is a no-op. `POST …/cloudflare/push` answers `202 { job: { id, status,
reused }, zone }` — the job's log lines come only from the jobs API, which applies its own
ownership rule.

## Hook into the DNS service

`publish()` in `services/dns-functions.js` ends with `mirror(fresh)`: when the zone's provider
is `cloudflare` it calls `ctx.dnsCloudflare.enqueuePush(domain)` and adds
`mirror: { provider, jobId }` to the result every mutation already returns (`addRecord`,
`updateRecord`, `deleteRecord`, `setSoa`, `setTtl`, `saveRawZone`, `applyZone`, the email
DNS, routing, hostname and bulk jobs — anything that publishes). Callers from other
categories (`ensureZoneForDomain`, `upsertRecords`, …) therefore mirror automatically with
unchanged signatures.

## Security

- The API token is **root-only**: `PUT/DELETE /api/dns/cloudflare/token`. It is verified with
  `GET /user/tokens/verify` and a zone listing (proves Zone:Read) before being stored, encrypted
  with the panel master key, in its own table `dns_cloudflare_settings` — deliberately not in
  `settings`, which `/api/system/settings` exposes and the config cluster pushes to peers.
  It is sent only as a bearer header; status answers carry the token *id*, never the token;
  audit rows redact `apiToken` (the `token` key rule) and services audit only ids and counts.
- **Linking and unlinking are root-only** (`POST …/cloudflare/link|unlink` take `requireRoot`
  and `link()`/`unlink()` re-check `isRoot`). The token is account-wide, so whoever links a
  panel zone of a given name gains import and push rights over the Cloudflare zone of that
  name; a reseller can put any domain name into the panel (an account or parked domain) and
  must therefore never be able to claim a Cloudflare zone root did not assign to them. The
  rule: **a reseller imports, pushes and follows only zones root has linked on accounts they
  own**; linking is root's decision, made from the zone card (`canLink` in `GET …/cloudflare`
  hides the buttons for everyone else).
- Zone actions (`POST …/cloudflare/{import,push}`, `GET …/cloudflare`) take `requireReseller`
  and resolve the zone through `ctx.dns.loadZone(domain, user)`, the same ownership check as
  every other zone endpoint, so a reseller touches only zones of accounts they own. The
  account-wide zone list (`GET /api/dns/cloudflare/zones`) is root-only; the token check in
  `configure()` seeds its 60 s cache only when the first page already holds the whole account
  (fewer than 50 zones), otherwise the next listing pages through all of them.
- Outbound calls use global `fetch` with `AbortSignal.timeout(20 s)`, `redirect: 'error'`, a
  fixed base URL (`CLOUDFLARE_API`, overridable only via `config.cloudflareApiBase` for tests)
  and Cloudflare's JSON envelope; errors map to `cloudflare_error` (502, carries Cloudflare's
  message and code), network/timeouts to 503, "not configured" to 409 `cloudflare_not_configured`.
- Every mutation writes an audit row: `dns.cloudflare.configure`, `remove_token`, `link`,
  `unlink`, `import`, `push`, `push_requested`.

## Files

| Piece | Path |
|---|---|
| migration | `server/src/db/migrations/035_dns-cloudflare.sql` (settings table, `dns_zones.provider` + `cloudflare_*` columns, `dns_cloudflare_sync` log) |
| service | `server/src/services/dns-cloudflare.js` → `ctx.dnsCloudflare` (created in the DNS category's `register`) |
| DNS hooks | `server/src/services/dns-functions.js`: `assertPublishable(domain)`, `publish(..., { mirror })`, `loadZone`, `replaceRecordsFromProvider` |
| routes | `server/src/routes/categories/dns-functions.js` (`/api/dns/cloudflare/*`, `/api/dns/zones/:domain/cloudflare/*`) |
| job | `dns.cloudflare.push` |
| UI | `client/src/pages/dns/CloudflarePanel.jsx` (`CloudflareSetupCard`, `CloudflareZoneCard`, `ProviderBadge`) used by DNS Zone Manager; provider column in Delete a DNS Zone |
| tests | `server/test/dns-cloudflare.test.js` (fetch is stubbed with an in-memory, paginating Cloudflare API with `Retry-After` and a listing delay hook), `client/test/dns-cloudflare-panel.test.jsx` (root-only link controls, retry notice) |

## Not in this round

- Creating the Cloudflare zone from the panel (needs an account-level token and plan choices).
- Choosing "proxied" per record from the panel; new records are DNS-only, existing flags are kept.
- Pulling Cloudflare changes made outside the panel on a schedule (import is manual).
- Per-reseller Cloudflare accounts: one account per server, linked zones are owned per account.
