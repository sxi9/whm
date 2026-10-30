# Security alert mails ("emergency update" notices)

Owner's finding (2026-10-30): "whenever there is a security alert, send an auto mail to users
(server-wide) that an emergency update is pushed, and save the users from hacks". This page records
what the panel now does, the events, the settings, the delivery rules and what is never sent.

## Pieces

| Piece | Where |
|---|---|
| Service `ctx.securityAlerts` | `server/src/services/security-alerts.js` (created by the Server Contacts module, after `ctx.contacts`) |
| Table `security_alerts` + `security_alert_deliveries`, settings defaults | migration `037_security-alerts.sql` |
| Job `security.alerts.deliver` | registered in `routes/categories/server-contacts.js`; pending alerts found at boot are scheduled again |
| Routes (root only) | `/api/server-contacts/security-alerts` (overview), `/alerts?limit`, `PUT /settings`, `POST /test`, `POST /raise`, `POST /deliver` |
| Contacts event | `security.alert` (group Security, default severity critical) in `server-contacts.js` `EVENTS`, routable per contact and through Edit System Mail Preferences (root mail) |
| UI | Contact Manager › "Security notifications" card (`client/src/pages/contacts/SecurityAlerts.jsx`), Security Advisor › "Alerts" panel |
| Hooks | `security-center.js` `advisor.scan()`, `software.js` `update.checkJob()`, `update.runJob()`, `panel.check()` |

## Kinds (what raises an alert)

| Kind | Raised by | Default severity | Audience | Dedupe key |
|---|---|---|---|---|
| `advisor.critical` | Security Advisor scan: every finding graded `critical` that was **not** critical in the previous run | critical | admins | `advisor:<finding id>` |
| `php.advisory` | the same scan, for `php.advisory.<CVE>` findings (an advisory from `security.advisories` matched an installed PHP version) | critical | admins | `advisor:php.advisory.<CVE>` |
| `updates.security_available` | `software.update.check` (nightly `os-update-check`, "Check now") when the simulation lists security updates | warning | admins | `updates.security_available:<sha256 of the sorted security package names>` — a new set alerts at once, the same set at most once per 24 h |
| `updates.security_applied` | `software.system.update` when the packages it upgraded include security updates (auto-apply or a manual run) | critical | **all** | `updates.security_applied:<job id>` |
| `panel.security_release` | `software.panel.check()` when the feed's release carries `security: true` (or `tags: ["security"]`) and is newer than the running version | critical | admins | `panel.security_release:<version>` |
| `manual` | an administrator, Contact Manager › Send a notice | critical (chosen) | **all** (chosen per notice) | random |
| `test` | Contact Manager › Send a test alert | info (bypasses the minimum) | **all** only when "Test with accounts too" is confirmed | random |

`raise({ kind, severity?, title, body, dedupeKey, source?, data? })` is synchronous and idempotent:
a key seen within the last 24 h returns the existing alert (`deduped: true`); an older row with the same
key has its key retired (`<key>#<id>`) so the column stays unique. Nothing is recorded while
`security.alerts.enabled` is off.

The feed field `latest.security` (boolean) is new in `software.panel.status()`; the feed may set
`security: true` on a release object.

## Settings

| Key | Default | Effect |
|---|---|---|
| `security.alerts.enabled` | `true` | Off: `raise()` records nothing, the test/notice/deliver endpoints answer 422, the delivery job does nothing. |
| `security.alerts.notify_accounts` | `false` | On: audience-"all" alerts are mailed to the contact address of every **active** hosting account (`accounts.suspended = 0`, usable `contact_email`). |
| `security.alerts.min_severity` | `critical` | Alerts below it are recorded with state `skipped` and never delivered (test and manual notices bypass it). |
| `security.alerts.digest_minutes` | `60` | After a delivery, alerts raised inside this window are `held` and sent together as one digest when the window closes (an unref'd timer; pending rows are re-scheduled at boot). `0` delivers every alert at once. |
| `security.alerts.last_delivery_at` | — | Written by the job; the digest window counts from it. |

## Delivery rules

1. `raise()` stores the row, writes an audit entry (`security.alerts.raise`, kind, severity, title,
   dedupe key, state — never the body) and, unless the alert is below the minimum severity, schedules
   delivery: enqueue `security.alerts.deliver` when the digest window is closed, otherwise hold.
2. The job takes every `pending`/`held` alert (or the explicit `alertIds` of a test or notice) and:
   - **Administrators:** one `ctx.contacts.notify('security.alert', { subject, body, severity, data })`
     per run (a digest when several alerts are pending). Contacts subscribed to `security.alert` or to
     all events, at or above their minimum severity, receive it on their channel; root mail follows
     `contacts.root_mail_events`. The result (`matched/sent/failed`) is stored in `admin_result_json`,
     `notified_admins_at` is set, the state becomes `sent` (or `failed` when notify threw).
   - **Accounts:** only when `notify_accounts` is on (or the test/notice asked for it) and only for
     alerts whose kind has audience `all`. Recipients are grouped by address, processed in chunks of 25
     with a 500 ms pause between chunks, one mail per address through `ctx.contacts.mail` (Exim or the
     SMTP relay). `security_alert_deliveries (alert_id, account_id)` is unique: a claim row is inserted
     before the send, so an account is never mailed twice for the same alert (a `failed` row may be
     retried by a later run, a `sent` one never). Without a mail transport the step is recorded as
     `skippedReason: no_mail_transport`. Admin-only kinds are recorded as `skipped: admins_only`.
   - `security.alerts.last_delivery_at` is set; an audit row `security.alerts.deliver` records counts.
3. Alerts older than 180 days that are no longer pending are pruned on the next `raise()`.

## Templates (`renderMail`, exported for tests)

Plain text and HTML, both carrying the product name (the HST Panel › Customization company name
when set, else "HST Panel"), the hostname, **what happened**, **what the panel did** (per kind: the
fix page for a finding, "nothing was installed yet" for pending updates, "the panel applied the
updates / a reboot is required" for applied ones, the upgrade page for a panel release), **when**
(UTC) and a link to the panel (`https://<hostname>:2087` or the HTTP port when TLS is off).

Account mails use `accountText()` only: for `updates.security_applied` the server, the account
names and domains behind the address, the number (and names, no versions) of updated packages,
whether a reboot follows and "nothing is required from you"; for `manual` the administrator's text as
written; for `test` a one-line notice. Kinds without an account text are not rendered for accounts.

Today both transports send `text/plain`; the HTML part is produced and returned by the API/renderer
but not yet put on the wire (see integrator notes: `buildMessage` in `server-contacts-smtp.js` and the
agent op `mail.sendmail` would need a `multipart/alternative` body).

## What is never sent

- **To accounts:** finding titles or details, package versions, advisory text, job logs, the
  administrator's name, any other account's address (each address is a separate envelope), and no
  alert of an admin-only kind at all. Suspended accounts are not mailed.
- **To anyone:** secrets (the audit row and the alert body never carry tokens, passwords or keys; the
  advisor's findings do not contain them), the raw feed URL credentials, SMTP credentials.
- **In audit rows:** notice and alert bodies (`body` is dropped by the audit redactor; only the title,
  kind, severity, dedupe key and counts are kept).

## Relationship to existing notifications

Server Configuration still raises `updates.available` after every update check with security
counts; `security.alert` is the dedicated, critical-by-default event, so an administrator can route
the two differently (for example `updates.available` to Slack, `security.alert` to SMS). A persisting
critical finding is alerted once (when it appears), not on every nightly scan; it reappears as a new
alert only after it was gone from a run.
