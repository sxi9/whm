-- Security alerts: root mail by default ---------------------------------------
-- A fresh install has no contacts, so security.alert reached nobody until an
-- administrator subscribed one. The event joins the root-mail routing once;
-- other entries of a list an operator saved are kept.
UPDATE settings
   SET value = json_insert(value, '$[#]', 'security.alert')
 WHERE key = 'contacts.root_mail_events'
   AND json_valid(value) AND json_type(value) = 'array'
   AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = 'security.alert');
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('contacts.root_mail_events', '["service.down","disk.space.low","backup.failed","login.failed.blocked","ssl.expiring","license.invalid","security.alert"]');
