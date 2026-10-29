// Single source of truth for the WHM navigation: 30 categories, 212 functions.
// The sidebar, the Tools grid, the router and the function registry are all
// derived from this file — never add a route anywhere else.

export function slugify(label) {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['’™®]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// [label, description, phase]
const CATEGORY_DEFS = [
  ['Server Configuration', 'Settings', [
    ['Basic WebHost Manager Setup', 'Contact details, main and shared IPs, nameservers and account defaults.', 1],
    ['Change Root Password', 'Rotate the server\'s root password.', 1],
    ['Configure cPanel Analytics', 'Opt in or out of anonymous interface analytics.', 5],
    ['Configure cPanel Cron Jobs', 'Schedules for the panel\'s own maintenance tasks.', 1],
    ['Initial Quota Setup', 'Enable and verify filesystem disk quotas.', 2],
    ['Link Server Nodes', 'Register linked servers for distributed workloads.', 5],
    ['Server Profile', 'Choose which roles this server fulfils.', 5],
    ['Server Time', 'Timezone and NTP synchronisation.', 2],
    ['Statistics Software Configuration', 'Web statistics generators and their schedule.', 5],
    ['Terminal', 'In-browser root shell.', 5],
    ['Tweak Settings', 'Hundreds of server-wide behaviour switches.', 1],
    ['Update Preferences', 'Release tier and automatic update policy.', 5],
    ['WHM Marketplace', 'Browse and install add-ons and plugins.', 5],
  ]],
  ['Support', 'LifeBuoy', [
    ['Create Support Ticket', 'Open a support request with a system snapshot.', 5],
    ['Grant cPanel Support Access', 'Time-boxed access for support engineers.', 5],
    ['Support Center', 'Documentation, forums and support resources.', 5],
  ]],
  ['Networking Setup', 'Network', [
    ['Change Hostname', 'Set the server\'s fully qualified hostname.', 4],
    ['Resolver Configuration', 'DNS resolvers the server uses.', 4],
  ]],
  ['Security Center', 'Shield', [
    ['Apache mod_userdir Tweak', 'Control ~user URL access.', 3],
    ['SMTP Restrictions', 'Block outgoing SMTP from non-mail users.', 3],
    ['Compiler Access', 'Allow or deny compilers to unprivileged users.', 3],
    ['Configure Security Policies', 'Login security policies.', 3],
    ['cPHulk Brute Force Protection', 'Block repeated failed logins.', 3],
    ['Host Access Control', 'Per-service allow and deny rules.', 3],
    ['Manage External Authentications', 'External identity providers for login.', 3],
    ['Manage root\'s SSH Keys', 'Generate, import and authorise root SSH keys.', 3],
    ['Manage Wheel Group Users', 'Who may become root with su.', 3],
    ['ModSecurity Configuration', 'Web application firewall settings.', 3],
    ['ModSecurity Tools', 'Review hits and manage rules.', 3],
    ['ModSecurity Vendors', 'Install and update rule vendors.', 3],
    ['Password Strength Configuration', 'Minimum password strength requirements.', 3],
    ['Security Advisor', 'Scan the server for security weaknesses.', 3],
    ['Security Questions', 'Recovery question policy.', 3],
    ['Shell Fork Bomb Protection', 'Per-user process and memory limits.', 3],
    ['SSH Password Authorization Tweak', 'Toggle SSH password authentication.', 3],
    ['Traceroute Enable/Disable', 'Control traceroute availability.', 3],
    ['Two-Factor Authentication', 'Time-based one-time passwords for panel logins.', 1],
  ]],
  ['Server Contacts', 'Contact', [
    ['Contact Manager', 'Notification channels and the events they receive.', 4],
    ['Edit System Mail Preferences', 'Where system mail is delivered.', 4],
  ]],
  ['Resellers', 'Users', [
    ['Change Ownership of an Account', 'Move an account to another reseller.', 4],
    ['Change Ownership of Multiple Accounts', 'Bulk ownership changes.', 4],
    ['Edit Reseller Nameservers and Privileges', 'ACLs and nameservers per reseller.', 4],
    ['Email All Resellers', 'Broadcast a message to every reseller.', 4],
    ['Manage Reseller\'s IP Delegation', 'IP addresses a reseller may assign.', 4],
    ['Manage Reseller\'s Shared IP', 'Default shared IP for a reseller.', 4],
    ['Reseller Center', 'Create and manage resellers and their limits.', 4],
    ['Reset Resellers', 'Strip reseller privileges.', 4],
    ['Show Reseller Accounts', 'Accounts owned by a reseller.', 4],
    ['View Reseller Usage and Manage Account Status', 'Usage overview with suspend controls.', 4],
  ]],
  ['Service Configuration', 'Server', [
    ['Apache Configuration', 'Global web server directives and includes.', 2],
    ['cPanel Log Rotation Configuration', 'Log rotation policy.', 2],
    ['cPanel Web Disk Configuration', 'WebDAV service settings.', 5],
    ['cPanel Web Services Configuration', 'Panel web service tuning.', 5],
    ['Exim Configuration Manager', 'Mail server configuration.', 3],
    ['FTP Server Selection', 'Choose the FTP daemon.', 2],
    ['Mailserver Configuration', 'IMAP/POP server settings.', 3],
    ['Manage Service SSL Certificates', 'Certificates for mail, FTP, web and the panel.', 3],
    ['Nameserver Selection', 'Choose the DNS server software.', 2],
    ['Service Manager', 'Enable, monitor and auto-restart services.', 1],
  ]],
  ['Locales', 'Languages', [
    ['Configure Application Locales', 'Default and available interface languages.', 5],
    ['Copy a Locale', 'Duplicate a locale to customise it.', 5],
    ['Delete a Locale', 'Remove a custom locale.', 5],
    ['Edit a Locale', 'Edit translated strings.', 5],
    ['Locale XML Download', 'Export a locale.', 5],
    ['Locale XML Upload', 'Import a locale.', 5],
    ['View Available Locales', 'All installed locales.', 5],
  ]],
  ['Backup', 'Archive', [
    ['Backup Configuration', 'Schedule, retention, scope and destinations.', 4],
    ['Backup Restoration', 'Restore a full account backup.', 4],
    ['Backup User Selection', 'Include or exclude accounts.', 4],
    ['File and Directory Restoration', 'Restore individual files.', 4],
  ]],
  ['Clusters', 'Share2', [
    ['Configuration Cluster', 'Share configuration with peer servers.', 5],
    ['DNS Cluster', 'Replicate DNS zones to other nameservers.', 5],
  ]],
  ['System Reboot', 'Power', [
    ['Forceful Server Reboot', 'Reboot immediately.', 4],
    ['Graceful Server Reboot', 'Stop services cleanly, then reboot.', 4],
  ]],
  ['Server Status', 'Activity', [
    ['Apache Status', 'Live web server worker status.', 2],
    ['Daily Process Log', 'Resource usage by process over time.', 2],
    ['Server Information', 'Hardware, OS, memory and disk details.', 1],
    ['Service Status', 'Up/down state of monitored services.', 1],
    ['Task Queue Monitor', 'Background jobs and their progress.', 1],
  ]],
  ['Account Information', 'UserSearch', [
    ['List Accounts', 'Search, inspect and act on hosting accounts.', 1],
    ['List Parked Domains', 'Parked (alias) domains.', 2],
    ['List Subdomains', 'All subdomains.', 2],
    ['List Suspended Accounts', 'Accounts currently suspended.', 1],
    ['Manage Account Enhancements', 'Add-on entitlements per account.', 5],
    ['Show Accounts Over Quota', 'Accounts exceeding disk quota.', 2],
    ['View Bandwidth Usage', 'Bandwidth consumption per account.', 2],
  ]],
  ['Account Functions', 'UserCog', [
    ['Change Site\'s IP Address', 'Move a site to a different IP.', 2],
    ['Create a New Account', 'Provision a hosting account.', 1],
    ['Email All Users', 'Broadcast a message to all account owners.', 2],
    ['Force Password Change', 'Require accounts to change their password.', 2],
    ['Limit Bandwidth Usage', 'Set a bandwidth cap.', 2],
    ['Manage Account Suspension', 'Suspend or unsuspend with a reason.', 1],
    ['Manage Demo Mode', 'Restrict accounts to read-only demo mode.', 2],
    ['Manage Shell Access', 'Normal, jailed or no shell.', 2],
    ['Modify an Account', 'Change domain, owner, package and limits.', 1],
    ['Password Modification', 'Set an account\'s password.', 1],
    ['Quota Modification', 'Change disk quota.', 2],
    ['Raw Apache Log Download', 'Download raw web access logs.', 2],
    ['Raw NGINX Log Download', 'Download raw NGINX logs.', 2],
    ['Rearrange an Account', 'Move an account\'s home to another partition.', 2],
    ['Reset Account Bandwidth Limit', 'Clear bandwidth counters.', 2],
    ['Terminate Accounts', 'Permanently remove accounts.', 1],
    ['Unsuspend Bandwidth Exceeders', 'Bulk unsuspend accounts over bandwidth.', 2],
    ['Upgrade/Downgrade an Account', 'Change an account\'s package.', 1],
    ['Web Log Retention', 'How long to keep web logs.', 2],
    ['Web Template Editor', 'Default and error page templates.', 2],
  ]],
  ['Multi Account Functions', 'UsersRound', [
    ['Change Multiple Sites\' IP Addresses', 'Bulk IP changes.', 2],
    ['Modify/Upgrade Multiple Accounts', 'Bulk package and limit changes.', 2],
  ]],
  ['Transfers', 'ArrowLeftRight', [
    ['Convert Addon Domain to Account', 'Promote an addon domain to its own account.', 4],
    ['Review Transfers and Restores', 'History and logs of transfer jobs.', 4],
    ['Transfer or Restore a cPanel Account', 'Import an account from a backup or remote server.', 4],
    ['Transfer Tool', 'Migrate many accounts from another server.', 4],
  ]],
  ['Themes', 'Palette', [
    ['Theme Manager', 'Default interface themes and branding.', 5],
  ]],
  ['Packages', 'Package', [
    ['Add a Package', 'Create a hosting plan.', 1],
    ['Delete a Package', 'Remove an unused plan.', 1],
    ['Edit a Package', 'Change plan limits and features.', 1],
    ['Feature Manager', 'Which cPanel features each plan includes.', 1],
  ]],
  ['DNS Functions', 'Globe', [
    ['Add a DNS Zone', 'Create a zone from a template.', 2],
    ['Add an A Entry for Your Hostname', 'Ensure the hostname resolves.', 2],
    ['Delete a DNS Zone', 'Remove a zone.', 2],
    ['DNS Zone Manager', 'Edit records in a zone.', 2],
    ['Edit Zone Templates', 'Templates used for new zones.', 2],
    ['Email DNS Record Manager', 'SPF, DKIM and DMARC helpers.', 2],
    ['Email Routing Configuration', 'Local, backup or remote mail routing.', 2],
    ['Enable DKIM/SPF Globally', 'Apply email authentication to all domains.', 2],
    ['Nameserver Record Report', 'Verify nameserver records.', 2],
    ['Park a Domain', 'Alias a domain onto an account.', 2],
    ['Perform a DNS Cleanup', 'Remove orphaned zones.', 2],
    ['Set Zone TTL', 'Default time-to-live.', 2],
    ['Setup/Edit Domain Forwarding', 'HTTP redirects for domains.', 2],
    ['Synchronize DNS Records', 'Push zones to cluster peers.', 2],
  ]],
  ['Database Services', 'Database', [
    ['Change Database Root Password', 'Rotate the database superuser password.', 2],
    ['Change Database User Password', 'Reset a database user\'s password.', 2],
    ['Database Map Tool', 'Map databases and users to accounts.', 2],
    ['Edit Database Configuration', 'Server configuration tuning.', 2],
    ['Manage Database Access Hosts', 'Remote hosts allowed to connect.', 2],
    ['Manage Database Profiles', 'Local and remote database servers.', 2],
    ['Manage Database Users', 'Create users and grants.', 2],
    ['Manage Databases', 'Create and drop databases.', 2],
    ['phpMyAdmin', 'Web database administration.', 2],
    ['Repair Databases', 'Check and repair tables.', 2],
    ['Show Database Processes', 'Live process list.', 2],
    ['Upgrade Database Version', 'Upgrade the database server.', 2],
  ]],
  ['IP Functions', 'Wifi', [
    ['IPv6 Ranges', 'Manage IPv6 address ranges.', 4],
    ['Add a New IP Address', 'Bind an additional IP to the server.', 4],
    ['Assign IPv6 Address', 'Give an account an IPv6 address.', 4],
    ['Configure Remote Service IPs', 'IPs for remote services.', 4],
    ['IP Migration Wizard', 'Renumber the server\'s IPs.', 4],
    ['Rebuild the IP Address Pool', 'Resynchronise free and used IPs.', 4],
    ['Show IP Address Usage', 'Which account uses each IP.', 4],
    ['Show or Delete Current IP Addresses', 'IPs bound to the server.', 4],
    ['Show/Edit Reserved IPs', 'IPs excluded from allocation.', 4],
  ]],
  ['Software', 'Wrench', [
    ['Install a Perl Module', 'Install from CPAN.', 5],
    ['Install Distro Packages', 'Install OS packages.', 5],
    ['Module Installers', 'PHP, Ruby and Perl module installers.', 5],
    ['MultiPHP INI Editor', 'php.ini settings per version and domain.', 5],
    ['MultiPHP Manager', 'PHP version per domain.', 5],
    ['NGINX Manager', 'NGINX reverse proxy and caching.', 5],
    ['Rebuild RPM Database', 'Repair the RPM database.', 5],
    ['System Update', 'Apply operating system updates.', 5],
    ['Update Server Software', 'Update the control panel.', 5],
    ['EasyApache 4', 'Build Apache and PHP profiles.', 5],
  ]],
  ['Application Manager', 'Rocket', [
    ['Application Manager', 'Node.js, Python and built frontend (React, Angular, Vue…) applications per domain: deploy, build, run, proxy and logs.', 2],
    ['Runtime Versions', 'Node.js and Python runtimes available to applications; install and remove managed Node.js versions.', 2],
    ['Application Templates', 'Framework presets (Express, NestJS, Next.js, React, Angular, Vue, Flask, Django, FastAPI…) and custom templates for new applications.', 2],
  ]],
  ['Email', 'Mail', [
    ['Email Deliverability', 'SPF, DKIM and reverse DNS health per domain.', 3],
    ['Filter Incoming Emails by Country', 'Country-based mail filtering.', 3],
    ['Filter Incoming Emails by Domain', 'Domain-based mail filtering.', 3],
    ['Greylisting', 'Delay unknown senders to reduce spam.', 3],
    ['Mail Delivery Reports', 'Trace message delivery.', 3],
    ['Mail Queue Manager', 'View, deliver or delete queued mail.', 3],
    ['Mail Troubleshooter', 'Diagnose delivery to an address.', 3],
    ['Mailbox Conversion', 'Convert mailbox formats.', 3],
    ['Repair Mailbox Permissions', 'Fix mailbox ownership and permissions.', 3],
    ['Spamd Startup Configuration', 'SpamAssassin daemon options.', 3],
    ['View Mail Statistics Summary', 'Mail volume statistics.', 3],
    ['View Relayers', 'Who is relaying mail.', 3],
    ['View Sent Summary', 'Outbound mail summary.', 3],
  ]],
  ['System Health', 'HeartPulse', [
    ['Background Process Killer', 'Kill disallowed background processes.', 2],
    ['Process Manager', 'Inspect, kill and renice processes.', 1],
    ['Show Current Disk Usage', 'Filesystem usage.', 1],
    ['Show Current Running Processes', 'Snapshot of running processes.', 1],
  ]],
  ['cPanel', 'LayoutDashboard', [
    ['Change Log', 'What changed in each release.', 5],
    ['Customization', 'Branding, logos and help links.', 5],
    ['Manage Plugins', 'Install and enable plugins.', 5],
    ['Modify cPanel & WHM News', 'News shown to users.', 5],
    ['Reset a Mailman Password', 'Mailing list admin password.', 5],
    ['Upgrade to Latest Version', 'Upgrade the panel.', 5],
  ]],
  ['SSL/TLS', 'Lock', [
    ['Generate an SSL Certificate and Signing Request', 'Create a key and CSR.', 3],
    ['Install an SSL Certificate on a Domain', 'Deploy a certificate.', 3],
    ['Manage AutoSSL', 'Automatic certificate issuance and renewal.', 3],
    ['Manage SSL Hosts', 'Installed certificates and expiry.', 3],
    ['Purchase and Install an SSL Certificate', 'Buy a certificate from a provider.', 5],
    ['SSL Storage Manager', 'Stored keys, CSRs and certificates.', 3],
    ['SSL/TLS Configuration', 'Protocols, ciphers and HSTS.', 3],
  ]],
  ['Market', 'Store', [
    ['Market Provider Manager', 'Enable marketplace providers.', 5],
  ]],
  ['Restart Services', 'RotateCw', [
    ['Database Server', 'Restart MySQL/MariaDB.', 1],
    ['DNS Server', 'Restart BIND.', 1],
    ['HTTP Server (Apache)', 'Restart Apache.', 1],
    ['IMAP Server', 'Restart Dovecot.', 1],
    ['Mail Server (Exim)', 'Restart Exim.', 1],
    ['Mailing List Manager (Mailman)', 'Restart Mailman.', 1],
    ['PHP-FPM service for Apache', 'Restart PHP-FPM.', 1],
    ['SSH Server (OpenSSH)', 'Restart the SSH daemon.', 1],
  ]],
  ['Development', 'Code', [
    ['OpenAPI Documentation for cPanel', 'User-side API reference.', 5],
    ['OpenAPI Documentation for WHM', 'Admin API reference.', 5],
    ['Apps Managed by AppConfig', 'Registered integration apps.', 5],
    ['cPanel Development Forum', 'Developer community.', 5],
    ['cPanel Plugin File Generator', 'Scaffold a plugin.', 5],
    ['Developer Documentation', 'Developer guides.', 5],
    ['Manage API Tokens', 'Create and revoke API tokens.', 5],
    ['Manage Hooks', 'Event hooks for automation.', 5],
  ]],
  ['Plugins', 'Puzzle', [
    ['ImunifyAV', 'Malware scanner.', 5],
    ['Server Monitoring', 'Metrics and alerts.', 5],
    ['WP Toolkit', 'WordPress management.', 5],
  ]],
];

// Restart Services entries map onto service registry names on the server.
export const RESTART_SERVICE_MAP = {
  'database-server': 'mysql',
  'dns-server': 'named',
  'http-server-apache': 'httpd',
  'imap-server': 'imap',
  'mail-server-exim': 'exim',
  'mailing-list-manager-mailman': 'mailman',
  'php-fpm-service-for-apache': 'php-fpm',
  'ssh-server-openssh': 'sshd',
};

export const CATEGORIES = CATEGORY_DEFS.map(([label, icon, fns], index) => {
  const slug = slugify(label);
  return {
    index: index + 1,
    label,
    slug,
    icon,
    functions: fns.map(([fnLabel, description, phase]) => {
      const fnSlug = slugify(fnLabel);
      return { label: fnLabel, description, phase, slug: fnSlug, key: `${slug}/${fnSlug}`, path: `/${slug}/${fnSlug}`, category: label, categorySlug: slug };
    }),
  };
});

export const FUNCTIONS = CATEGORIES.flatMap((c) => c.functions);
export const FUNCTION_BY_KEY = Object.fromEntries(FUNCTIONS.map((f) => [f.key, f]));
export const FUNCTION_BY_PATH = Object.fromEntries(FUNCTIONS.map((f) => [f.path, f]));

export function searchFunctions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return FUNCTIONS;
  const terms = q.split(/\s+/);
  return FUNCTIONS.filter((f) => {
    const hay = `${f.label} ${f.category} ${f.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
