-- Cluster event log: kind / status / peer filters newest first (the list
-- sorts by id); see server/test/perf/list-endpoints.test.js.
CREATE INDEX IF NOT EXISTS idx_cluster_events_kind_id ON cluster_events (kind, id);
CREATE INDEX IF NOT EXISTS idx_cluster_events_status_id ON cluster_events (status, id);
CREATE INDEX IF NOT EXISTS idx_cluster_events_cluster_id ON cluster_events (cluster_id, id);
