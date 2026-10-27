-- Which peer endpoint the last push used: the cluster-aware receiver
-- (/api/clusters/dns/receive) or the plain zone import on older panels.
ALTER TABLE dns_zone_sync ADD COLUMN endpoint TEXT;
