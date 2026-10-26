-- Software: every Apache profile carries the utilities package (apache2-utils /
-- httpd-tools). apache2 depends on it on Debian, so a profile without it made
-- "remove extras" take Apache down with it. Stock rows only; copies are the
-- operator's own.
UPDATE ea4_profiles SET packages_json = '{"debian":["apache2","apache2-utils","php-fpm","php-cli","php-common","php-opcache"],"rhel":["httpd","httpd-tools","mod_ssl","php","php-fpm","php-cli","php-common","php-opcache"]}', updated_at = datetime('now')
  WHERE name = 'Minimal' AND stock = 1;

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('software.nginx.apache_ssl_port', '8443'),
  ('software.nginx.last_fingerprint', 'null');
