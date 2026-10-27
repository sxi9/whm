-- Security Center amendment: data-driven PHP advisory list for the Security
-- Advisor (ctx.security.phpAdvisories). Operators extend or replace the list
-- through the security.advisories setting; INSERT OR IGNORE keeps their edits.
--
-- Entry shape: { id, title, severity (critical|high|medium|low), published,
-- url, affected: { "<php minor>": "<range>" }, fixedIn: { "<php minor>":
-- "<version>" } | null, note }. A range is "*" or space-separated comparators
-- ("<8.3.36", ">=8.2.0 <8.2.35"); "||" separates alternatives.
--
-- Seed = what php.net (archive/2026.php, 21 and 23 Oct 2026) and the GHSA
-- record GHSA-6wmf-4rv5-p3rp state. CVE-2026-115560 has no version data yet, so
-- it carries no ranges and is reported as an unpatched advisory only.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('security.advisories', '[{"id":"CVE-2026-109619","title":"PHP2Shell: unauthenticated remote code execution (CVE-2026-109618, CVE-2026-109619)","severity":"critical","published":"2026-10-21","url":"https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp","affected":{"8.5":"<8.5.12","8.4":"<8.4.27","8.3":"<8.3.36","8.2":"<8.2.35","8.1":"*","8.0":"*","7.4":"*"},"fixedIn":{"8.5":"8.5.12","8.4":"8.4.27","8.3":"8.3.36","8.2":"8.2.35"},"note":"Affects every PHP installation serving web requests (PHP-FPM, mod_php, php-cgi); CVSS 9.2 and exploited in the wild. PHP 8.1 and older get no packaged fix from the PHP project (source-only backports for 7.4, 8.0 and 8.1), so move those sites to a supported branch. Until updated, php.net lists partial mitigations only: memory_limit=-1 via php_admin_value, a low post_max_size, session.upload_progress.enabled=0 and fatal_error_backtraces=0 on 8.5."},{"id":"CVE-2026-115560","title":"Session upload progress: unpatched RCE vector in unusual configurations (informational advisory)","severity":"medium","published":"2026-10-23","url":"https://www.php.net/archive/2026.php#2026-10-23-1","affected":{},"fixedIn":null,"note":"No release yet; the fix ships with the next regular bugfix release. Only applications that set session.serialize_handler to php_binary or php_serialize and switch it to php with ini_set() before session_start() are exposed. Mitigation: session.upload_progress.enabled=0."}]');
