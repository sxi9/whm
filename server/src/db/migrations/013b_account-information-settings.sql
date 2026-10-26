-- Account Information: suspension on exceed is owned by Account Functions
-- (Limit Bandwidth Usage); the collector's settings no longer carry it.
UPDATE settings
   SET value = json_remove(value, '$.suspendOnExceed', '$.suspendReason')
 WHERE key = 'account_info.bandwidth' AND json_valid(value) AND json_type(value) = 'object'
   AND (json_extract(value, '$.suspendOnExceed') IS NOT NULL OR json_extract(value, '$.suspendReason') IS NOT NULL);
