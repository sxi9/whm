## 16. License Server (reselling the panel)

The panel is a **vendor product**: the owner (the *vendor*) sells it to their own customers
and lets *resellers* (sub-vendors) issue licenses within a quota. Licensing is implemented
as a separate deployable, `hub/license/`, operated by the vendor, plus a thin client inside
the panel (`server/src/services/license.js`). Design rules:

- **Offline-verifiable**: a license is an Ed25519-signed token the panel validates with
  embedded vendor public keys; the hub is only needed to *activate*, *check in* and *renew*.
- **Never take customer sites down**: a lapsed/invalid license puts the panel into a
  read-only *degraded mode*; Apache/BIND/Exim/MySQL keep serving.
- **Same conventions as the panel**: Node 22 + Express + SQLite (WAL), `zod` on every
  endpoint, `{data, meta}` / `{error}` envelopes, audit log, non-root service user.

### 16.1 Positioning, deployment & config

```
hub/
├── license/                     whm-license  (this section)
│   ├── src/
│   │   ├── index.js             bootstrap, HTTPS :7443
│   │   ├── app.js               express assembly (helmet, rate-limit, api-key auth, zod)
│   │   ├── config.js            /etc/whm-hub/license.conf + env
│   │   ├── db/ schema.sql migrate.js seed.js
│   │   ├── lib/ keys.js (Ed25519 signing, kid, rotation)  canonical.js (JCS)  keyfmt.js (WHM-XXXX keys)
│   │   │        fingerprint.js (drift score)  webhooks.js  nonce.js  scheduler.js
│   │   ├── services/ licenses.js activations.js customers.js resellers.js trials.js billing.js reports.js
│   │   └── routes/ public.js reseller.js admin.js portal.js
│   └── portal/                  React (Vite) admin + reseller portal
└── marketplace/                 see §17
```

| Item | Value |
|---|---|
| Service / user | `whm-license.service`, `User=whmhub` (non-root; never needs an agent) |
| Ports | `:7443` HTTPS (public API + portal); `:7440` loopback-only `/metrics` + `/healthz` |
| Config | `/etc/whm-hub/license.conf` (yaml): `public_url`, `db_path`, `signing_keys_dir`, `token_ttl_hours` (168), `checkin_interval_hours` (12), `default_grace_days` (7), `webhook_secret_enc`, `smtp`, `rate_limits` |
| Signing keys | `/etc/whm-hub/keys/<kid>.ed25519` (`0600 whmhub`), `active_kid` in config; private keys never leave the host (optional HSM/KMS driver) |
| DB | `/var/lib/whm-hub/license.db` (SQLite WAL) |
| Logs | `/var/log/whm-hub/license/{app,audit,access}.log` |

**HA notes.** Token *validation* is stateless (public-key only) and happens on the panel, so
the hub being down never breaks running panels. The hub itself is a single writer: run one
primary; optional read replicas (Litestream/LiteFS style streaming of the SQLite WAL) serve
`GET` traffic (`/v1/keys`, portal reads, reports) behind the load balancer; all `POST`s go to
the primary. Check-ins are idempotent and retried by panels, so brief primary failover is
invisible. **Backup**: `sqlite3 .backup` every hour to `/var/backups/whm-hub/`, encrypted
off-site copy nightly (same destination drivers as the panel's `fs` family: S3/SFTP/B2),
signing keys backed up *separately* (offline, encrypted); restore test monthly.

### 16.2 Products & editions

One product (`whm-panel`) with editions; a `products` row per edition so prices/limits are
data, not code. Feature flags gate panel functions; limits are numeric and enforced by the
panel (§16.8) and by the hub (activation counting).

| Edition | Servers (`max_activations`) | Hosting accounts | Resellers | Term | Feature flags |
|---|---|---|---|---|---|
| **Trial** | 1 | 5 | 0 | 14 days, non-renewable, one per fingerprint/customer | `marketplace_free` |
| **Solo** | 1 | 25 | 0 | monthly/annual | `marketplace_free`, `api` |
| **Pro** | 1 | unlimited (`-1`) | 5 | monthly/annual | + `marketplace_paid`, `transfers`, `autossl_wildcard` |
| **Reseller** | N (bought per server, 2–50) | unlimited | unlimited | annual | + `clusters`, `white_label`, `multi_server` |
| **Enterprise** | N (contract) | unlimited | unlimited | contract, custom grace (30 d) | all + `sso`, `priority_support`, `custom_branding_builder` |

Full flag catalog (`features_json` keys, all booleans): `api`, `transfers`, `clusters`,
`multi_server`, `marketplace_free`, `marketplace_paid`, `white_label`, `autossl_wildcard`,
`sso`, `terminal`, `priority_support`, `custom_branding_builder`. Limits (`limits_json`):
`max_accounts`, `max_resellers`, `max_domains_per_account` (`-1` = unlimited),
`max_activations`, `grace_days`. Editions are *ordered* (`rank`) so upgrade/downgrade is a
comparison, not a special case.

### 16.3 Data model (SQLite)

```sql
-- Vendor & tenancy -----------------------------------------------------------
vendors(id, name, public_url, support_email, default_grace_days, created_at)       -- single row normally
customers(id, vendor_id, reseller_id NULL, name, email UNIQUE, company, country,
          external_ref,                                                           -- billing system id (Stripe cus_…, WHMCS client id)
          status, created_at)                                                     -- status: active|suspended|closed
resellers(id, vendor_id, name, email UNIQUE, portal_user_id, status,              -- sub-vendors
          quota_json,                                                             -- {"solo":100,"pro":50,"reseller":5,"trial":-1}
          pricing_json,                                                           -- {"solo":{"monthly":600,"annual":6000}} (cents, wholesale)
          issued_json,                                                            -- running counters per edition
          brand_json, created_at)                                                 -- white-label name/logo for their portal
portal_users(id, vendor_id, reseller_id NULL, email UNIQUE, password_hash, role,   -- role: vendor_admin|vendor_support|reseller_admin|reseller_staff
             totp_secret_enc, totp_enabled, last_login_at, created_at)

-- Catalog -------------------------------------------------------------------
products(id, sku UNIQUE, name, edition, rank, term,                               -- edition: trial|solo|pro|reseller|enterprise; term: days|monthly|annual|contract
         limits_json, features_json, price_cents, currency, active)

-- Licenses ------------------------------------------------------------------
licenses(id, key_hash UNIQUE, key_prefix,                                          -- sha256(key); prefix "WHM-7K3Q" for display/search
         product_id, edition, limits_json, features_json,                          -- snapshot at issue (overrides allowed)
         status,                                                                   -- pending|active|suspended|expired|revoked
         issued_at, starts_at, expires_at NULL, grace_days, max_activations,
         customer_id, reseller_id NULL, issued_by, notes, external_ref, created_at, updated_at)
activations(id, license_id, fingerprint,                                           -- composite sha256 (hex)
            fp_components_json,                                                    -- {"machine_id":"<sha256>","mac":"<sha256>","disk":"<sha256>"}
            hostname, public_ip, panel_version, os,
            first_seen, last_checkin, token_kid, status,                           -- active|deactivated|reclaimed|blocked
            deactivated_at, deactivated_by, drift_events)
checkins(id, activation_id, ts, panel_version, accounts_used, resellers_used,      -- heartbeat log (90-day retention)
         ip, result, latency_ms)                                                   -- result: ok|rotated|revoked|expired|suspended|over_limit
revocations(id, license_id, activation_id NULL, reason, revoked_by, ts, propagated_at)
trials(id, customer_id, license_id, fingerprint, email_hash, ip, started_at,
       converted_license_id NULL, converted_at NULL)                              -- enforces one trial per fingerprint/email
transfers(id, license_id, from_activation_id, to_activation_id NULL, requested_at,
          completed_at, requested_by)                                              -- explicit deactivate/transfer flow
billing_events(id, source, event_type, external_id UNIQUE, payload_json,           -- inbound (Stripe/WHMCS/Paddle) idempotency log
               processed_at, result)
webhook_endpoints(id, owner_type, owner_id, url, secret_enc, events_json, enabled) -- owner_type: vendor|reseller
webhook_deliveries(id, endpoint_id, event, payload_json, attempt, status, next_at, last_code)
api_keys(id, owner_type, owner_id, name, key_hash, scopes_json, expires_at,        -- scopes: license:read license:issue license:revoke …
         last_used_at, created_at)
nonces(nonce PRIMARY KEY, seen_at)                                                 -- replay cache (10-min TTL)
signing_keys(kid PRIMARY KEY, public_key, created_at, retired_at NULL, status)     -- active|retiring|retired
audit_log(id, ts, principal, role, ip, action, target, args_redacted, result)      -- same shape as the panel's
```

### 16.4 License key & signed token

**Human key** — `WHM-XXXX-XXXX-XXXX-XXXX`: 16 chars from the Crockford base32 alphabet
(no `I L O U`, case-insensitive on input, dashes optional): 15 random chars (75 bits from
`crypto.randomBytes`) + 1 Crockford mod-37 check char. The key is a *bearer secret* that
resolves to a license: the hub stores only `sha256(key)` (`licenses.key_hash`) and the first
group (`key_prefix`) for display. The panel stores the key encrypted (AES-256-GCM via
`lib/crypto.js`). A key never carries entitlement data — the token does.

**Token** — `WHMT1.<base64url(payload)>.<base64url(signature)>`:

```json
{ "v": 1, "iss": "https://license.vendor.example", "kid": "a91f3c2e",
  "lid": "lic_01J9ZQ8X", "aid": "act_01JA02KQ", "cid": "cus_01J9ZP11",
  "ed": "pro", "rank": 30,
  "lim": { "max_accounts": -1, "max_resellers": 5, "max_activations": 1, "max_domains_per_account": -1 },
  "feat": { "api": true, "transfers": true, "marketplace_paid": true, "clusters": false, "white_label": false },
  "fp": "sha256:4f1b…e0",
  "iat": 1761350400, "nbf": 1761350100, "exp": 1761955200,
  "lexp": 1792886400, "grace": 7, "nonce": "n_7c0b4d…", "status": "active" }
```

- **Canonical JSON** (JCS / RFC 8785 subset): object keys sorted by UTF-16 code unit, no
  whitespace, integers only (no floats/NaN), strings escaped only where JSON requires it,
  UTF-8 bytes. `canonical.js` is the single implementation, shared by hub and panel.
- **Signature**: Ed25519 (`crypto.sign(null, Buffer.from(canonical), privateKey)`) over the
  canonical payload bytes; base64url without padding. `kid` = first 8 hex of
  `sha256(raw 32-byte public key)`.
- **Clock skew**: panel accepts `nbf − 300 s` and `exp + 300 s`; hub rejects requests whose
  `ts` is more than 300 s off and logs a `clock_skew` message back to the panel.
- **Lifetimes**: token `exp = min(iat + token_ttl (7 d), lexp + grace)`; check-ins every 12 h
  always return a fresh token, so a healthy panel never comes near `exp`. License expiry
  `lexp` is independent: after `lexp` the hub still issues tokens with `status:"grace"` until
  `lexp + grace`, then `status:"expired"` tokens (still signed, so the panel can trust the
  *reason*).
- **Key rotation**: the panel embeds `server/src/services/license-keys.json`
  `{ "keys": [ {"kid":"a91f3c2e","pub":"<base64>","not_after":null}, … ] }` (≥2 keys). A
  new signing key is first *added* to the panel's embedded set in a release, then made
  `active` on the hub ≥ 90 days later; the old key stays `retiring` for ≥ 2× token TTL, then
  `retired` (rejected). `GET /v1/keys` publishes the same set, but the panel only *pins*
  keys shipped in its own code (an online key list can add nothing the binary doesn't trust).
- Every hub **response** to the panel is itself signed (`X-WHM-Signature: kid=…,sig=…` over
  the canonical response body, which echoes the request `nonce`), so even non-token answers
  (`revoked`, `messages`) cannot be spoofed by a MITM/local proxy.

### 16.5 Server fingerprinting

The panel asks the agent (`sys.fingerprint`, read-only op) for three stable identifiers and
hashes each separately so raw values never leave the server:

| Component | Source | Weight |
|---|---|---|
| `machine_id` | `/etc/machine-id` (fallback `/var/lib/dbus/machine-id`) | 0.50 |
| `mac` | MAC of the interface holding the default route (`ip -j route`, `ip -j link`) | 0.30 |
| `disk` | root filesystem UUID (`findmnt -J /` → `blkid`), fallback `/dev/disk/by-id` | 0.20 |

`fingerprint = sha256("whmfp1|" + h(machine_id) + "|" + h(mac) + "|" + h(disk))`.
On activation/check-in the hub compares component hashes against the stored activation:
`drift = Σ weight(component that changed)`. Rules: `drift == 0` → same server;
`0 < drift ≤ 0.5` (e.g. NIC or disk replaced) → same activation, hub updates the stored
components, increments `drift_events`, emits message `fingerprint_updated`; `drift > 0.5`
(machine-id changed = cloned/reinstalled) → treated as a **new server**: it is accepted only
if `active activations < max_activations`, otherwise `409 activation_limit` with the list of
current activations (hostname, last check-in) so the admin can deactivate one. **Reclaim**:
an activation with no check-in for 30 days may be reclaimed automatically by a new
activation of the same license (logged, webhook `license.transferred`). **Re-activation
limits**: at most 3 activations per license per 30 days (sliding) without vendor
approval — blocks key-sharing while allowing a reinstall; vendor/reseller can lift it.

### 16.6 Flows (request / response)

All panel→hub calls: `POST`, JSON, headers `X-WHM-Nonce`, `X-WHM-Timestamp`; body always
includes `key` (or the current `token` for check-in), `fingerprint` + `fp_components`,
`hostname`, `panel_version`. Errors use the panel envelope `{error:{code,message}}` and are
signed too.

**Issue (vendor/reseller API)**
```http
POST /v1/reseller/licenses            Authorization: Bearer <api key, scope license:issue>
{ "sku": "whm-pro-annual", "customer": {"email":"ops@acme.example","name":"Acme"}, "term_months": 12,
  "notes": "order #5531", "external_ref": "whmcs:5531" }
→ 201 { "data": { "license_id":"lic_01J9ZQ8X", "key":"WHM-7K3Q-M2DF-9XA1-P0R6", "edition":"pro",
         "expires_at":"2027-10-25T00:00:00Z", "max_activations":1 }, "meta": { "quota_left": {"pro": 49} } }
```
The clear-text key is returned **once**; afterwards only `key_prefix` is visible.

**Activate (panel)**
```http
POST /v1/activate
{ "key":"WHM-7K3Q-M2DF-9XA1-P0R6", "fingerprint":"sha256:4f1b…e0",
  "fp_components": {"machine_id":"…","mac":"…","disk":"…"}, "hostname":"srv1.acme.example",
  "panel_version":"1.4.2", "os":"ubuntu-24.04", "nonce":"n_7c0b…", "ts":1761350400 }
→ 200 { "data": { "token":"WHMT1.eyJ…", "activation_id":"act_01JA02KQ", "checkin_interval_hours":12,
         "messages":[] }, "meta": {"nonce":"n_7c0b…"} }
→ 409 { "error": { "code":"activation_limit", "message":"1 of 1 activations in use",
         "activations":[{"id":"act_…","hostname":"old.acme.example","last_checkin":"2026-10-20T07:11:00Z"}] } }
```

**Check-in (panel, every 12 h, jittered ±20 min)**
```http
POST /v1/checkin
{ "token":"WHMT1.…", "fingerprint":"sha256:…", "fp_components":{…}, "panel_version":"1.4.2",
  "usage": {"accounts":41,"resellers":2,"domains":97}, "nonce":"n_…", "ts":1761393600 }
→ 200 { "data": { "token":"WHMT1.…(fresh)", "status":"active", "revoked":false,
         "license": {"edition":"pro","expires_at":"2027-10-25T00:00:00Z","days_left":365},
         "messages":[{"level":"info","code":"renewal_available","text":"Renew before 2027-10-25"}] } }
→ 200 { "data": { "token":"WHMT1.…(status:expired)", "status":"expired", "revoked":false, "messages":[…] } }
→ 403 { "error": { "code":"revoked", "message":"License revoked: chargeback", "revoked_at":"…" } }
```
If `fingerprint` drifts > 0.5 the hub answers `409 fingerprint_mismatch` with the same
`activations` list as above; the panel then shows the transfer dialog.

**Deactivate / transfer (panel or portal)**
```http
POST /v1/deactivate            { "token":"WHMT1.…", "reason":"migrating" }        → 200 {"data":{"deactivated":true}}
POST /v1/admin/activations/act_01JA02KQ/deactivate   { "reason":"customer request" }  (portal/API, no server access needed)
POST /v1/transfers             { "key":"WHM-…", "from_activation":"act_01JA02KQ", "fingerprint":"<new>", … }
→ 200 { "data": { "token":"WHMT1.…", "activation_id":"act_01JA9…", "transferred_from":"act_01JA02KQ" } }
```
Transfer = atomic deactivate-old + activate-new in one hub transaction; the old server
learns it on its next check-in (`403 deactivated`) and enters degraded mode.

**Renew · Upgrade/Downgrade · Suspend/Unsuspend · Revoke (admin/reseller API)**
```http
POST /v1/admin/licenses/lic_01J9ZQ8X/renew      { "term_months":12 }      → expires_at += 12 months (from max(now, expires_at))
POST /v1/admin/licenses/lic_01J9ZQ8X/change-edition { "sku":"whm-reseller-annual-5", "prorate":true }
   → limits/features snapshot replaced; downgrade is refused with 409 over_limit {"accounts":41,"max_accounts":25}
     unless "force":true (panel then blocks new creation but keeps existing accounts)
POST /v1/admin/licenses/:id/suspend   { "reason":"invoice overdue" }  /unsuspend          → status flips; next check-in returns status
POST /v1/admin/licenses/:id/revoke    { "reason":"chargeback" }       → revocations row; all activations → blocked; webhook license.revoked
```
Edition changes take effect at the next check-in; the portal offers "Push now", which just
shortens the panel's next check-in via the `messages` channel (panels poll; the hub never
connects inbound to a customer server).

**Trial start → convert (panel "Start free trial" button, or portal)**
```http
POST /v1/trial   { "email":"ops@acme.example", "fingerprint":"sha256:…", "fp_components":{…}, "hostname":"…", "nonce":"…", "ts":… }
→ 201 { "data": { "key":"WHM-TR1A-…", "token":"WHMT1.…", "expires_at":"2026-11-08T…", "activation_id":"act_…" } }
→ 409 { "error": { "code":"trial_exists", "message":"A trial was already used on this server or e-mail" } }
POST /v1/admin/trials/trl_01J…/convert  { "sku":"whm-solo-annual" }
→ 200 { "data": { "license_id":"lic_01J9ZQ8X", "key":"WHM-…" } }      -- same activation carried over; no re-activation needed
```
Conversion keeps the trial's `activation` row (re-parented to the new license) so the panel
just receives a Pro/Solo token at the next check-in — zero downtime, no key re-entry.

**Reseller issuance within quota · bulk issue · lost key**
```http
POST /v1/reseller/licenses/bulk  { "sku":"whm-solo-annual", "count":25, "customer_id":"cus_…", "notes":"Q4 batch" }
→ 202 { "job": {"id":"job_…"} } → GET /v1/jobs/job_…  → { "data": { "licenses":[{"license_id":"…","key":"WHM-…"},…] } }  (keys shown once; CSV download)
   quota check: issued_json[edition] + count ≤ quota_json[edition] else 409 quota_exceeded
POST /v1/admin/licenses/lic_01J9ZQ8X/rekey  { "reason":"customer lost key" }
→ 200 { "data": { "key":"WHM-…(new)" } }      -- old key_hash invalidated; existing activations/tokens unaffected
POST /v1/recover  { "email":"ops@acme.example" }  → 202 always; e-mails the customer their key prefixes + portal link (no keys by mail)
```

### 16.7 Hub REST API

**Public / panel** (no API key; nonce + timestamp + per-IP and per-key rate limits):

| Method & path | Function |
|---|---|
| `POST /v1/activate` · `/v1/checkin` · `/v1/deactivate` · `/v1/transfers` | panel lifecycle (§16.6) |
| `POST /v1/trial` · `POST /v1/recover` | self-service trial, lost-key mail |
| `GET /v1/keys` | published signing keys `{keys:[{kid,pub,status}]}` (informational; panel pins its own) |
| `GET /v1/status/:license_prefix` | public "is this key valid/edition/expiry" lookup for support (no PII) |
| `GET /healthz` · `GET /metrics` (loopback) | liveness, Prometheus metrics |

**Reseller** (API key `owner_type=reseller`, scopes `license:read license:issue license:renew
license:revoke customer:write webhook:write`; every row filtered by `reseller_id`):

| Method & path | Function |
|---|---|
| `GET/POST /v1/reseller/licenses` · `GET /v1/reseller/licenses/:id` | list/issue/view own licenses |
| `POST /v1/reseller/licenses/bulk` · `POST …/:id/renew` · `/change-edition` · `/suspend` · `/unsuspend` · `/revoke` · `/rekey` | lifecycle |
| `GET /v1/reseller/licenses/:id/activations` · `POST …/activations/:aid/deactivate` | server bindings |
| `GET/POST /v1/reseller/customers` · `PATCH /v1/reseller/customers/:id` | own customers |
| `GET /v1/reseller/quota` · `GET /v1/reseller/invoices` | remaining quota per edition, wholesale statement |
| `GET/POST/DELETE /v1/reseller/webhooks` · `GET/POST/DELETE /v1/reseller/api-keys` | integration |

**Admin** (API key `owner_type=vendor`, scopes `admin:*`, `billing:webhook`, `report:read`; portal
users use session + 2FA and the same routes):

| Method & path | Function |
|---|---|
| `GET/POST /v1/admin/products` · `PUT /v1/admin/products/:sku` | editions, limits, prices |
| `GET/POST /v1/admin/customers` · `/resellers` · `PATCH …/:id` · `PUT /v1/admin/resellers/:id/quota` | tenancy, quotas, pricing |
| `GET/POST /v1/admin/licenses` (`?q=&status=&edition=&expiring_within=`) · all lifecycle sub-routes of the reseller table, unscoped | license management |
| `GET /v1/admin/activations` (`?stale=30d`) · `POST …/:id/deactivate` · `/block` · `/reclaim` | activation control |
| `GET /v1/admin/revocations` · `GET /v1/admin/checkins?license_id=` | audit views |
| `POST /v1/admin/billing/webhooks/:source` (`stripe|whmcs|paddle`) | inbound billing events (signature-verified, idempotent via `external_id`) |
| `GET/POST /v1/admin/signing-keys` · `POST …/:kid/retire` | key rotation |
| `GET /v1/admin/reports/{activations,renewals,churn,resellers}` · `GET /v1/admin/export.csv` | reports (§16.11) |
| `GET /v1/admin/audit` · `GET/POST/DELETE /v1/admin/api-keys` · `/webhooks` | audit, keys, outbound webhooks |

**Outbound webhooks** (vendor and reseller endpoints): events `license.issued`,
`license.activated`, `license.checkin_failed` (3 misses), `license.expiring` (30/14/7/1 d),
`license.expired`, `license.suspended`, `license.revoked`, `license.transferred`,
`license.renewed`, `license.edition_changed`, `trial.started`, `trial.converted`. Body
`{id, event, ts, data:{license_id, key_prefix, edition, customer_id, external_ref, …}}`;
header `X-WHM-Webhook-Signature: t=<unix>,v1=<hmac-sha256(secret, t + "." + body)>`;
retries with exponential backoff (1 m → 24 h, 10 attempts), replay from the portal.
**Inbound billing**: a Stripe `invoice.paid` / WHMCS `InvoicePaid` / Paddle
`subscription.payment_succeeded` with `external_ref` → `renew`; `subscription.deleted` /
`InvoiceCancelled` → `suspend` after grace; refund/chargeback → `revoke`.

### 16.8 Panel-side enforcement (`server/src/services/license.js`)

State lives in the panel DB (added to §6):

```sql
license_state(id PRIMARY KEY CHECK(id=1), key_enc, token, payload_json, activation_id,
              status,                                 -- unlicensed|active|grace|degraded|expired|suspended|revoked
              last_checkin_at, last_ok_at, next_checkin_at, fail_count, messages_json, updated_at)
license_events(id, ts, event, detail_json)            -- feeds audit_log + Contact Manager
```

- **Boot**: load `license_state`, verify `token` offline against the pinned keys
  (`kid` lookup → Ed25519 verify → canonical re-serialisation must equal the signed bytes →
  `nbf/exp` with 300 s skew → `fp` equals the current `sys.fingerprint` within drift ≤ 0.5).
  Result cached in memory; `license.get()` is synchronous for middleware.
- **Check-in**: scheduler job every `checkin_interval_hours` (default 12, jitter). Success →
  store fresh token, `fail_count=0`, `status` from token. Network/5xx failure →
  `fail_count++`, keep the cached token; the token itself is valid 7 days, so the panel stays
  `active` through outages; when the token's `exp` passes with no fresh token → `grace`
  (banner) for `grace_days`, then **`degraded`**.
- **Degraded mode** (also for `expired`, `suspended`, `revoked`, `unlicensed`):
  *read-only administration* — RBAC middleware denies every mutating route except
  `auth/*`, `license/*`, `services/*/restart`, `backups/*` (you may always rescue data) and
  `accounts/:user/unsuspend`; `GET`s work. Account creation, package changes, DNS edits,
  plugin installs return `423 {error:{code:"license_degraded", message, action:"/server-config/basic-setup#license"}}`.
  **Nothing on the host is touched**: no vhost, zone, mailbox, DB or systemd change is made
  because of license state — customer sites, mail and databases keep serving indefinitely.
- **Edition limits**: `AccountService.create()` and `ResellerService.create()` call
  `license.assertCapacity('accounts')` → `409 {error:{code:"license_limit",
  message:"Your Solo license allows 25 hosting accounts (25 in use). Upgrade to Pro to add more.", limit:25, used:25}}`.
  Feature flags gate routers: `requireFeature('transfers')` on Transfers, `clusters` on
  Clusters/DNS Cluster, `terminal` on Terminal, `api` on API-token creation, `white_label`
  on Customization/Theme Manager branding fields, `marketplace_paid` on paid plugin install
  (§17). Downgrades never delete anything over the new limit.
- **UI**: the Home **Statistics panel** gets a *License* row (edition, status pill, days
  left, activations `1/1`, last check-in); **Basic WebHost Manager Setup → License** tab:
  enter/replace key, "Check in now", view edition/limits/features, activations list with
  *Deactivate this server* / *Transfer*, start trial, open vendor portal. A persistent top
  banner in `grace`/`degraded`.
- **Events → notifications**: `license.expiring` (30/14/7/1 d), `license.expired`,
  `license.grace_started`, `license.degraded`, `license.revoked`, `license.suspended`,
  `license.fingerprint_changed`, `license.checkin_failed` → `audit_log` rows and Contact
  Manager channels (new event keys in `contacts.events_json`). A `hooks` event
  `license.status_changed` lets billing/integrators react.
- **Panel routes** (`routes/license.js`): `GET /api/license` · `POST /api/license/key`
  (activate/replace) · `POST /api/license/checkin` · `POST /api/license/deactivate` ·
  `POST /api/license/trial` · `GET /api/license/activations`. Root only.

### 16.9 Vendor admin portal & reseller portal

`hub/license/portal/` (React + Vite, same component kit as the panel: `DataTable`, `Form`,
`ConfigPage`, `ActionPage`, `StatusPill`). Login with password + TOTP; RBAC per `portal_users.role`.

| Area | Screens |
|---|---|
| **Vendor: Dashboard** | active activations per edition, check-ins/hour, expiring in 30 d, failed check-ins, revenue by reseller, webhook failures |
| **Vendor: Licenses** | list/search (`key_prefix`, customer, hostname, IP), detail (token preview, activations, check-in history, revocations, events), issue, bulk issue + CSV, renew, change edition, suspend, revoke, rekey, notes |
| **Vendor: Customers / Resellers** | CRUD, reseller quota + wholesale pricing editor, reseller statement, impersonate-reseller (audited) |
| **Vendor: Products** | editions matrix (limits × features × price), ordering/rank |
| **Vendor: Trials** | funnel (started/converted/expired), abuse view (same IP/e-mail hash) |
| **Vendor: Integrations** | API keys + scopes, outbound webhooks (test, replay, delivery log), inbound billing connectors, signing-key rotation |
| **Vendor: Reports / Audit** | §16.11 reports, export, audit log |
| **Reseller portal** (white-label `brand_json`) | dashboard (quota left per edition, expiring), my licenses (issue/renew/suspend/revoke/rekey within quota), my customers, activations (deactivate), API keys & webhooks, statement |

### 16.10 Security & anti-abuse

- **Signed everything**: tokens and every hub response are Ed25519-signed; the panel
  pins keys compiled into its release; `kid` must be in the pinned set and not expired.
- **Nonce / replay**: each panel request carries a random 128-bit nonce + timestamp; the hub
  rejects reused nonces (`nonces` table, 10-min TTL) and skew > 300 s; the response echoes the
  nonce inside the signed body, so a replayed "active" response cannot revive a revoked panel.
- **Rate limits** (express-rate-limit, per IP and per key prefix): `/v1/activate` 10/h,
  `/v1/checkin` 12/h per activation, `/v1/trial` 3/day per IP, `/v1/recover` 3/h, reseller API
  600/h, admin 1200/h; HTTP 429 with `Retry-After`. Failed key lookups beyond 20/h per IP → 24 h
  block (cPHulk analog, same table shape as `cphulk_blocks`).
- **Activation-count enforcement** is server-side only; the token's `fp` binds it to one
  fingerprint, so copying `license_state` to another server fails offline verification.
- **Fingerprint drift** per §16.5; large drift and > 3 re-activations/30 d require vendor
  approval; all drift logged (`activations.drift_events`, `checkins`).
- **Panel tamper detection**: `license.js` and `license-keys.json` hashes are listed in the
  release manifest (`/opt/whm/MANIFEST.sha256`, signed with the same vendor key); the
  updater and `Security Advisor` verify them and report "panel integrity" findings. Not a
  guarantee against a determined root operator (none exists) — a deterrent that also
  catches corrupted installs.
- **Revocation propagation**: revoke → immediate `blocked` activations; panels learn at next
  check-in (≤ 12 h) or when their token expires (≤ 7 d) — the hub never needs inbound access
  to customer servers. `license.checkin_failed` after 3 consecutive misses alerts the vendor.
- **Logging & data minimisation**: the hub stores fingerprint *hashes*, hostname, public IP
  and panel version — no account names, domains or e-mail of end users; `usage` counts are
  integers. Check-in rows are pruned after 90 days, nonces after 10 minutes, trial e-mail
  stored as `email_hash` + the customer record. API keys and webhook secrets are stored
  hashed/encrypted; clear-text license keys are shown once and never logged.
- Hub hardening mirrors §10: helmet, CSRF on portal routes, bcrypt + TOTP for portal users,
  `zod` on every route, audit log of every admin/reseller mutation, TLS only.

### 16.11 Operational

- **Monitoring**: `/healthz` (DB writable, active signing key loadable, clock sane),
  `/metrics` (checkins_total by result, activations_active by edition, token_sign_latency,
  webhook_failures, replica_lag_seconds). Alerts: check-in error rate > 2 %, signing key
  within 30 d of planned retirement, webhook endpoint failing > 1 h, DB backup age > 2 h.
- **Scheduler** (`lib/scheduler.js`, node-cron style): hourly `expire-licenses` (status →
  `expired` after `expires_at + grace_days`), daily `expiring-reminders` (e-mail customer +
  reseller + webhooks at 30/14/7/1 d), daily `stale-activations` (flag > 30 d, reclaimable),
  daily `trial-expiry`, hourly `webhook-retry`, 10-min `nonce-prune`, daily `checkin-prune`
  (90 d), hourly `db-backup`.
- **Reports** (`GET /v1/admin/reports/*`, portal charts, CSV): active activations per
  edition over time; renewals due / completed / lapsed per month; churn (expired-not-renewed
  within 30 d) by edition and reseller; reseller quota usage and wholesale statement; trial
  funnel; panel-version distribution (drives update nudges via `messages`).
- **Export**: `GET /v1/admin/export.csv?table=licenses|activations|customers` and a full
  `sqlite3 .backup` download for vendor admins (audited).

### 16.12 Roadmap entry & tests

| Phase | Deliverable |
|---|---|
| **P7 Commercial** | `hub/license/` (API, portal, signing/rotation, webhooks, billing connectors, reports) + panel `license.js` (offline verify, check-in, degraded mode, edition gates, Basic Setup License tab, notifications); then `hub/marketplace/` (§17). |

The suite (node:test, temp SQLite, fixed test key pair) must cover:

- `canonical.js`: key ordering, escaping, integer-only, byte-for-byte parity between hub and panel copies (golden vectors).
- `keyfmt.js`: generation, Crockford normalisation (`o`→`0`, `i/l`→`1`, case, dashes), check-char rejection, `sha256` lookup.
- Token: sign/verify round-trip; tampered payload, wrong `kid`, retired key, `nbf/exp` ± skew boundaries, `fp` mismatch above/below the 0.5 drift threshold.
- Activate: happy path; `activation_limit` with activations list; reclaim of a 31-day-stale activation; > 3 re-activations/30 d blocked; nonce replay rejected; timestamp skew rejected.
- Check-in: fresh token issued; `expired`/`grace`/`suspended`/`revoked` statuses; fingerprint drift update path; `usage` recorded; rate limit.
- Lifecycle: issue → renew (expiry extends from max(now, expires_at)) → upgrade → downgrade refused when over limit, allowed with `force` → suspend/unsuspend → revoke (activations blocked, revocation row, webhook queued) → rekey invalidates old key only.
- Trials: one per fingerprint and per e-mail hash; convert carries over the activation.
- Resellers: quota enforcement incl. bulk; row scoping (a reseller cannot read/modify another's license); API-key scopes matrix.
- Webhooks: HMAC signature, retry/backoff schedule, idempotent inbound billing events (`external_id` UNIQUE), each billing source mapped to the right lifecycle action.
- Panel `license.js`: boot verify with pinned keys; cache; network failure → stays `active` until `exp`; → `grace` → `degraded` timeline (fake clock); degraded RBAC matrix (mutations 423, GETs and rescue routes allowed, **no agent op ever dispatched** on license state change); `assertCapacity` and `requireFeature` messages; events reach `audit_log` and Contact Manager; UI status payload shape.
- Security: `zod` rejection of malformed fingerprints/keys, rate-limit 429s, data-minimisation (no raw machine-id/MAC in any stored row or log line), manifest integrity check failure surfaces as an Advisor finding.
