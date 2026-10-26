-- System Health: case-insensitive uniqueness for the disallowed list ------------
--
-- The service checks duplicates with COLLATE NOCASE but the table's UNIQUE
-- constraint was case-sensitive, so a race between two adds could store both
-- "minerd" and "MINERD". Rows that already collide keep the built-in (or the
-- oldest) entry; the index then makes the database enforce the rule.
DELETE FROM bpk_patterns
  WHERE EXISTS (
    SELECT 1 FROM bpk_patterns o
    WHERE lower(o.name) = lower(bpk_patterns.name)
      AND (o.builtin > bpk_patterns.builtin OR (o.builtin = bpk_patterns.builtin AND o.id < bpk_patterns.id))
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_bpk_patterns_name_nocase ON bpk_patterns (name COLLATE NOCASE);
