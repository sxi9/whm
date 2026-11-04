-- The seeded php-fpm candidate list stopped at php8.3-fpm and INSERT OR IGNORE
-- never touches an existing row, so installs made before 8.4/8.5 reported an
-- active PHP-FPM as not installed. unit_candidates is not user-editable, so the
-- row can be replaced outright; the guard keeps the statement re-runnable.
UPDATE services
   SET unit_candidates = '["php-fpm","php8.5-fpm","php8.4-fpm","php8.3-fpm","php8.2-fpm","php8.1-fpm"]'
 WHERE name = 'php-fpm' AND unit_candidates NOT LIKE '%php8.5-fpm%';
