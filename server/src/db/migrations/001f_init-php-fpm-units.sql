-- The seeded php-fpm Service Manager row listed unit names only up to
-- php8.3-fpm and INSERT OR IGNORE never refreshes it, so hosts whose unit is
-- php8.4-fpm or newer (Debian 13, Ubuntu 25.04+) showed PHP-FPM as not
-- installed. The pattern matches every versioned unit; the capability layer
-- prefers the newest. Idempotent: rows already carrying the pattern are left alone.
UPDATE services
   SET unit_candidates = '["php-fpm","php*-fpm"]'
 WHERE name = 'php-fpm' AND unit_candidates NOT LIKE '%php*-fpm%';
