-- Branding: migration 029 seeded the Support settings with the legacy vendor's
-- name and portal, so the service's own 'Hostingsignal Support' default was never
-- reached on an installed server. Rows that still carry those seed values move to
-- the Hostingsignal defaults (the portal link is shown once the operator sets a
-- URL under Support Center); a value the operator changed is left alone.
UPDATE settings SET value = '"Hostingsignal Support"', updated_at = datetime('now')
  WHERE key = 'support.provider_name' AND value = '"cPanel Support"';
UPDATE settings SET value = '""', updated_at = datetime('now')
  WHERE key = 'support.portal_url' AND value = '"https://support.cpanel.net/"';
