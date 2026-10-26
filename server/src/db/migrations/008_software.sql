-- Software: EasyApache 4 profiles (package sets per distro family) and defaults.
CREATE TABLE IF NOT EXISTS ea4_profiles (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  packages_json TEXT NOT NULL DEFAULT '{"debian":[],"rhel":[]}',
  stock         INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO ea4_profiles (name, description, packages_json, stock) VALUES
  ('Default', 'Apache (event MPM) with PHP-FPM, the common PHP extensions and mod_ssl. The recommended starting point for shared hosting.',
   '{"debian":["apache2","apache2-utils","php-fpm","php-cli","php-common","php-mysql","php-curl","php-gd","php-mbstring","php-xml","php-zip","php-intl","php-bcmath","php-soap","php-imagick","php-opcache"],"rhel":["httpd","httpd-tools","mod_ssl","php","php-fpm","php-cli","php-common","php-mysqlnd","php-gd","php-mbstring","php-xml","php-pecl-zip","php-intl","php-bcmath","php-soap","php-opcache"]}', 1),
  ('Minimal', 'Apache and one PHP-FPM runtime with only the core extensions. Good for static sites or when you add extensions by hand.',
   '{"debian":["apache2","apache2-utils","php-fpm","php-cli","php-common","php-opcache"],"rhel":["httpd","httpd-tools","mod_ssl","php","php-fpm","php-cli","php-common","php-opcache"]}', 1),
  ('All PHP options', 'Every PHP extension the distribution ships, for hosts that run many different applications.',
   '{"debian":["apache2","apache2-utils","php-fpm","php-cli","php-common","php-mysql","php-pgsql","php-sqlite3","php-curl","php-gd","php-mbstring","php-xml","php-zip","php-intl","php-bcmath","php-soap","php-imagick","php-opcache","php-redis","php-memcached","php-ldap","php-imap","php-xmlrpc","php-gmp","php-tidy","php-xsl","php-apcu"],"rhel":["httpd","httpd-tools","mod_ssl","php","php-fpm","php-cli","php-common","php-mysqlnd","php-pgsql","php-pdo","php-gd","php-mbstring","php-xml","php-pecl-zip","php-intl","php-bcmath","php-soap","php-opcache","php-pecl-redis","php-pecl-memcached","php-ldap","php-gmp","php-tidy","php-xsl","php-pecl-apcu","php-process","php-json"]}', 1),
  ('Hardened', 'The Default profile plus ModSecurity and mod_evasive for the Security Center WAF and request-flood protection.',
   '{"debian":["apache2","apache2-utils","php-fpm","php-cli","php-common","php-mysql","php-curl","php-gd","php-mbstring","php-xml","php-zip","php-intl","php-bcmath","php-soap","php-imagick","php-opcache","libapache2-mod-security2","modsecurity-crs","libapache2-mod-evasive"],"rhel":["httpd","httpd-tools","mod_ssl","php","php-fpm","php-cli","php-common","php-mysqlnd","php-gd","php-mbstring","php-xml","php-pecl-zip","php-intl","php-bcmath","php-soap","php-opcache","mod_security","mod_security_crs","mod_evasive"]}', 1);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('software.update_url', '""'),
  ('software.panel.last_check', 'null'),
  ('software.updates.auto_os', 'false'),
  ('software.updates.last_check', 'null'),
  ('software.nginx.enabled', 'false'),
  ('software.nginx.cache', 'false'),
  ('software.nginx.apache_port', '8080'),
  ('software.nginx.cache_max_mb', '1024'),
  ('software.nginx.cache_ttl', '"10m"'),
  ('software.nginx.last_sync', 'null'),
  ('software.ea4.active_profile', 'null');
