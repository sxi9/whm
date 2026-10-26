-- Server Contacts fix round: relay credentials stay off plain connections
-- unless allowed, webhooks to private/loopback addresses are opt-in, and
-- Edit System Mail Preferences also manages mail for the nobody user.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('contacts.smtp.allow_plaintext_auth', 'false'),
  ('contacts.webhook.allow_private', 'false'),
  ('contacts.nobody_forward', '[]');
