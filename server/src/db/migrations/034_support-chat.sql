-- Support: Account Conversations (account manager + in-panel chat) ----
-- The manager is the root or reseller user the account turns to for support;
-- the creator is recorded by default. A deleted manager leaves the account unmanaged.
ALTER TABLE accounts ADD COLUMN manager_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_manager ON accounts (manager_user_id);

-- One thread per account, shared by the manager side (root, the owner, the
-- manager) and the account side (the hosted-account login).
CREATE TABLE IF NOT EXISTS support_conversations (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL UNIQUE REFERENCES accounts (id) ON DELETE CASCADE,
  subject         TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_message_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);

-- `side` records which party wrote the message, so unread counts survive a
-- user row being deleted or an author changing role.
CREATE TABLE IF NOT EXISTS support_messages (
  id                 INTEGER PRIMARY KEY,
  conversation_id    INTEGER NOT NULL REFERENCES support_conversations (id) ON DELETE CASCADE,
  author_user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  author_username    TEXT NOT NULL,
  author_role        TEXT NOT NULL,
  side               TEXT NOT NULL CHECK (side IN ('manager', 'account')),
  body               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  read_by_manager_at TEXT,
  read_by_account_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_support_messages_unread_manager ON support_messages (conversation_id, side, read_by_manager_at);
CREATE INDEX IF NOT EXISTS idx_support_messages_unread_account ON support_messages (conversation_id, side, read_by_account_at);
