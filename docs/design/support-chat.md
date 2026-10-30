# Account manager and Account Conversations (Support › Account Conversations)

Owner's finding: *when creating a user or reseller, ask who will manage the account and show the
account manager to the user for future queries and support; create a chat window inside the backend
and on the user side.* This page records what was built (unit U7), where it lives and what still
depends on the hosted-account ("HST Panel") login.

## Account manager

| Piece | Where |
|---|---|
| Column | `accounts.manager_user_id` (nullable, `REFERENCES users ON DELETE SET NULL`), migration `034_support-chat.sql`. `034b_support-chat-manager-backfill.sql` names the **owner** as manager of every account that has none, so a host upgraded in place does not leave its existing accounts unmanaged (no notice mail, "No manager assigned" on both sides). |
| Rules | The manager is a `root` or `reseller` user that is not suspended. Root may name anyone; a reseller may name **itself or a root user** (handing an account to another reseller is root's decision, otherwise a reseller could grant a third party read access to the thread). Default on create: **the creator**. `manager: null` on modify clears it. |
| API | `POST /api/accounts { manager? }`, `PATCH /api/accounts/:username { manager?: username \| null }`, `GET /api/accounts/managers` (the candidates the caller may pick), `GET /api/accounts?manager=<username>&sort=manager`. Account rows carry `manager`, `manager_role`, `manager_email`, `manager_user_id`. |
| Audit | `account.create` args include `manager` (user id); `account.modify` records the input. |
| UI | Create a New Account › *Account manager* card (the select follows the Owner field until picked by hand; placeholder "Default: you"); Modify an Account › *Account manager* select and the `AccountSummary` block (`client/src/pages/accounts/AccountDetails.jsx`) with a *Conversation* link. |

Ownership is unchanged: `accounts.get/modify` still require root or the owner. Being the manager
grants access to the **conversation** only (see scope below), not to the account's settings.

## Account Conversations

One thread per hosting account. Two parties:

- **manager side** — root, the account's owner and its assigned manager (role `root`/`reseller`);
- **account side** — the hosted-account login: a `users` row with role `user` whose `username` equals
  the account's `username` (the convention cPanel › Modify News and Reseller Center already use).

Tables (`034_support-chat.sql`): `support_conversations (account_id UNIQUE, subject, status
open|closed, last_message_at)` and `support_messages (conversation_id, author_user_id, author_username,
author_role, side manager|account, body ≤ 4000, created_at, read_by_manager_at, read_by_account_at)`.
`side` is stored so unread counts survive a deleted user row. Terminating the account cascades.

### Service `ctx.supportChat` (`server/src/services/support-chat.js`)

| Method | Behaviour |
|---|---|
| `listConversations(query, user)` | One row per account in scope, with or without a thread, paginated (`q`, `status`, `unread`, `sort=activity\|username\|domain\|unread\|status`, `dir`). `meta.viewerSide` tells the page which side it renders. |
| `get(username, user, { before, limit })` | Account summary (with manager), conversation, messages oldest→newest, `hasMore`, `viewerSide`, `canModerate`. |
| `post(username, body, user, req)` | Creates the thread on first use (subject `Support for <domain>`), reopens a closed one, stores the message, audits `support.chat.post` **without the text** (`chars`, side, ids), publishes to the SSE subscribers, emits the panel event `support.chat.message` (metadata only), and mails the other party a notice (manager email when the account writes, `contact_email` when the manager writes) through `ctx.contacts.sendMail` when mail can leave the server — best effort, never blocks. |
| `markRead(username, user)` | Stamps `read_by_<side>_at` on the other side's unread messages. The manager side is one party: once root, the owner or the manager read a message it is read for all of them. |
| `update(username, { status, subject }, user, req)` | Manager side only (403 for the account); creates the thread row when the account has none. Audited as `support.chat.update`. |
| `unread(user)` | `{ total, conversations: [{ account, domain, unread }] }` for the viewer's side — the figure a top-bar badge would show. |
| `subscribe(accountId, fn)` | In-process fan-out used by the SSE route. |

Scope (`loadAccount`): root → every account; reseller → `owner_id = me OR manager_user_id = me`;
user → `accounts.username = my username`. Out-of-scope accounts answer **404**, not 403, so a
reseller cannot enumerate other resellers' accounts.

### Routes (`server/src/routes/categories/support.js`, mounted under `/api/support`)

| Route | Roles | Notes |
|---|---|---|
| `GET /chat` | root, reseller, user | list |
| `GET /chat/unread` | root, reseller, user | badge figure (sits before `/chat/:username`, "unread" is a valid username) |
| `GET /chat/:username` | root, reseller, user | `?before=<id>&limit=1..500` |
| `GET /chat/:username/stream` | root, reseller, user | SSE: `snapshot` (same shape as `get`), then `message`, `read`, `status`; `: ping` every 15 s; the path ends in `/stream` so the API rate limiter and access log skip it like the job streams |
| `POST /chat/:username/messages` | root, reseller, user | `{ body }` — CRLF normalised, trimmed, 1–4000 chars, no NUL. **The request-level audit row would carry the text; `liftMessageText` runs first on the route, replaces `req.body` with `{ chars }` and hands the text on as `req.messageText`, so a 404, 422 or 5xx row carries the length only.** Responses sent before the route is reached (401 expired session, 403 CSRF, 423 license-degraded) still finish with the raw body — see below. |
| `POST /chat/:username/read` | root, reseller, user | |
| `PATCH /chat/:username` | root, reseller | `{ status?, subject? }` |

### Page

`Support › Account Conversations` (`client/src/pages/fn/support/account-conversations.jsx` →
`client/src/pages/support/ChatWorkspace.jsx`): conversation list on the left (filter box for the manager
side, unread badges, closed pills, last message preview), thread on the right with day separators,
left/right bubbles by side, *Load earlier messages*, Close/Reopen for the manager side, and a composer
(Ctrl+Enter sends, character counter). The thread opens the SSE stream and also fetches the thread
once, so a proxy that buffers SSE still shows the messages. `EventSource` reconnects by itself after a panel
restart or a proxy idle timeout and the route sends a fresh `snapshot`; `mergeSnapshot` folds every snapshot into
the open thread (new ids appended, status/subject refreshed, `hasMore` taken from a snapshot that reaches back to
the oldest known message), so messages posted while the stream was down appear without leaving the page. `?account=<username>` deep-links a thread
(used by the *Conversation* button in the account summary). Hosted-account logins (`role: user`) see
the page as **My support**: a banner naming their manager and their single thread, opened automatically.

### Panel events

`support.chat.message { account, domain, conversationId, messageId, side, author, chars, reopened }`
and `support.chat.status { account, conversationId, status, by }` are emitted on `ctx.events` for Manage
Hooks and plugins. They deliberately carry no message text; the SSE stream (scoped per viewer) does.

## The hosted-account side today

`users.role = 'user'` rows can authenticate (`services/auth.js` does not restrict the role; the 2FA
enrolment rule applies to root/resellers only), and the chat scopes them to the account named like
them. Nothing in the panel creates such rows yet — they exist only through tests or the database —
and the WHM shell still shows the full sidebar to a `user` session (every other route answers 403).
When the HST Panel login lands it should: create or link the `user` row per account, land those
sessions on `/support/account-conversations` (the only Support function they can use) and hide the
rest of the sidebar. The chat needs no change for that.

## Not done here (shared files)

- Audit rows for responses sent before the route runs: `middleware/audit.js` records `req.body` on
  `finish` for every mutation, and `requireAuth` (401), CSRF (403) and the license gate (423) answer before
  `/support/chat/:username/messages` can replace it, so those rows carry the message text. Fix in the
  shared middleware, e.g. a `bodyAudit` map keyed by `METHOD /path-pattern` (or `req.auditArgs` set by an
  early `app.use`) that stores `{ chars }` for this route whatever the outcome.
- Top bar badge: `TopBar.jsx` has a Bell button but no count mechanism; `GET /api/support/chat/unread`
  is ready for it (poll every 60 s, show `total`, link to the page).
- List Accounts manager column: `client/src/pages/accounts/AccountsTable.jsx` — add
  `{ key: 'manager', label: 'Manager', sortable: true }`; the API already returns and sorts by it.
- Tracker/docs: CHECKLIST (Support now has 4 functions, 216 in total), BLUEPRINT §Support,
  `docs/MANUAL.md` (manager field, Account Conversations), screenshots for the new page and the
  manager card in Create a New Account.
