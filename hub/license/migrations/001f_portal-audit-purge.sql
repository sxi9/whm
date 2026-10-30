-- Before this round the request audit stored the portal password-change body
-- ({ current, next }) verbatim, readable through GET /v1/admin/audit by any
-- admin:read holder. The route now hides both values; rows written earlier
-- are purged here. A refused attempt (wrong current password) was recorded
-- under 'POST /password': Express restores req.baseUrl before the error
-- handler answers. Idempotent.
UPDATE audit_log SET args_redacted = NULL
  WHERE action IN ('POST /v1/portal/password', 'POST /password') AND args_redacted IS NOT NULL;
