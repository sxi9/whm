-- Development: API token expiry is stored as 'YYYY-MM-DDTHH:MM:SSZ' so every
-- reader (including new Date() in the Bearer authenticator) treats it as UTC.
-- Rows written in the earlier zone-less 'YYYY-MM-DD HH:MM:SS' form (UTC) are
-- rewritten in place.
UPDATE api_tokens
   SET expires_at = replace(expires_at, ' ', 'T') || 'Z'
 WHERE expires_at IS NOT NULL
   AND expires_at LIKE '____-__-__ __:__:__';
