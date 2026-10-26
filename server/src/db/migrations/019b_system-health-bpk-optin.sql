-- System Health: the disallowed-process list is opt-in ----------------------------
--
-- Migration 019 seeded the classic WHM list with every entry enabled, so a fresh
-- install started killing matching non-root processes on its first scheduled scan.
-- WHM ships the list unchecked: nothing is killed until the operator ticks entries.
-- Only built-in rows the operator never touched are reset.
UPDATE bpk_patterns SET enabled = 0, updated_at = datetime('now')
  WHERE builtin = 1 AND enabled = 1 AND updated_at = created_at;
