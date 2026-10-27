-- Clusters: inbound trust ----------------------------------------------------------
-- Configuration pushes are opt-in. The 025 seed accepted them by default, which let
-- any peer holding a cluster token rewrite this server's settings; the row is reset
-- so an operator turns it on deliberately under Clusters > Configuration Cluster.
UPDATE settings SET value = 'false' WHERE key = 'clusters.config.accept_pushes';
INSERT OR IGNORE INTO settings (key, value) VALUES ('clusters.config.accept_pushes', 'false');

-- The default group selection lives in code (DEFAULT_GROUPS in
-- services/clusters-config.js: every group except security and software). The 025
-- seed row is dropped while it still holds that seed, so the code default applies
-- and new groups join the selection; an operator's own choice is kept.
DELETE FROM settings WHERE key = 'clusters.config.groups'
  AND value = '["basic","tweak","security","dns","mail","ssl","backup","software"]';
