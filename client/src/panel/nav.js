// Single source of truth for the account panel navigation (design §6.1): nav
// groups → functions. Sidebar, home grid, search, router and page registry are
// derived from here. Import-free ESM on purpose: e2e/panel-check.cjs loads it
// from Node to enumerate every panel path.

export const PANEL_BASE = '/panel';
export const PANEL_KEY_PREFIX = 'panel';

export function slugify(label) {
  return label
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['’™®]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The algorithm nav.js uses for the 212 admin entries, parametrised so the same
// defs shape serves both shells. With the defaults it reproduces the admin
// entries byte for byte (test/panel-nav.test.js checks); the integrator moves it
// into nav.js when wiring the router. A fourth element `{ slug, feature }` on a
// function pins its slug when the label changes and names the plan feature that
// gates it (missing feature keys mean enabled, cPanel semantics).
export function buildNav(defs, { basePath = '', keyPrefix = '' } = {}) {
  return defs.map(([label, icon, fns, opts], index) => {
    const slug = opts?.slug || slugify(label);
    return {
      index: index + 1,
      label,
      slug,
      icon,
      functions: fns.map(([fnLabel, description, phase, fnOpts]) => {
        const fnSlug = fnOpts?.slug || slugify(fnLabel);
        const fn = {
          label: fnLabel, description, phase, slug: fnSlug,
          key: keyPrefix ? `${keyPrefix}:${slug}/${fnSlug}` : `${slug}/${fnSlug}`,
          path: `${basePath}/${slug}/${fnSlug}`,
          category: label, categorySlug: slug,
        };
        if (fnOpts?.feature) fn.feature = fnOpts.feature;
        return fn;
      }),
    };
  });
}

// [label, icon, [[label, description, phase, { slug?, feature? }]], { slug? }]
export const PANEL_CATEGORY_DEFS = [
  ['Overview', 'LayoutDashboard', [
    ['Dashboard', 'Usage at a glance, your domains and quick links.', 1],
    ['Account details', 'Your account, plan limits and included features.', 1, { slug: 'account' }],
    ['Preferences', 'Contact addresses, language and notifications.', 1, { slug: 'preferences' }],
  ]],
  ['Domains', 'Globe', [
    ['Domains', 'Every domain on this account and where it is served from.', 1],
    ['Addon domains', 'Host additional websites on this account.', 1, { feature: 'addondomains' }],
    ['Subdomains', 'Sections of your sites under their own hostname.', 1, { feature: 'subdomains' }],
    ['Parked domains', 'Aliases that show the same site as another domain.', 1, { feature: 'parkeddomains' }],
    ['Redirects', 'Send visitors from one address to another.', 1, { feature: 'redirects' }],
  ]],
  ['DNS', 'Network', [
    ['Zone editor', 'A, AAAA, CNAME, MX, TXT, SRV and CAA records for your domains.', 1, { slug: 'zone-editor' }],
  ]],
  ['SSL', 'Lock', [
    ['SSL status', 'Certificates installed on each domain.', 1, { slug: 'status', feature: 'sslmanager' }],
    ['Install certificate', 'Issue a free certificate or install your own.', 1, { slug: 'install', feature: 'sslmanager' }],
    ['Certificates', 'Certificates, keys and signing requests stored for this account.', 1, { slug: 'certificates', feature: 'sslmanager' }],
  ]],
  ['Files', 'FolderOpen', [
    ['File manager', 'Browse, upload, edit and organise the files of your sites.', 1, { feature: 'filemanager' }],
    ['Disk usage', 'Which folders use the most space.', 1],
    ['Directory privacy', 'Ask visitors for a username and password before a folder opens.', 1, { feature: 'dirprivacy' }],
    ['Indexes', 'Whether a folder without an index page lists its files.', 1, { feature: 'indexmanager' }],
  ]],
  ['Email', 'Mail', [
    ['Email accounts', 'Mailboxes on your domains.', 1, { slug: 'accounts', feature: 'emailaccts' }],
    ['Forwarders', 'Copy or redirect incoming mail to another address.', 1, { feature: 'forwarders' }],
    ['Default address', 'What happens to mail for addresses that do not exist.', 1, { feature: 'defaultaddress' }],
    ['Autoresponders', 'Automatic replies while you are away.', 1, { feature: 'autoresponders' }],
    ['Email filters', 'Sort, forward or discard incoming mail per mailbox.', 1, { slug: 'filters', feature: 'emailfilters' }],
    ['Account-wide filters', 'Rules that apply to every mailbox on this account.', 1, { slug: 'global-filters', feature: 'emailfilters' }],
    ['Spam filters', 'Scoring thresholds, allow and block lists.', 1, { slug: 'spam', feature: 'spamassassin' }],
    ['Deliverability', 'SPF, DKIM and DMARC records for your domains.', 1],
    ['Email routing', 'Deliver mail for a domain here or at another mail server.', 1, { slug: 'routing' }],
    ['Webmail', 'Read your mail in the browser.', 1],
    ['Mail usage', 'Messages sent and delivered recently.', 1, { slug: 'usage' }],
  ]],
  ['Databases', 'Database', [
    ['Databases', 'Databases on this account.', 1, { feature: 'mysql' }],
    ['Database users', 'Users and the privileges they hold on each database.', 1, { slug: 'users', feature: 'mysql' }],
    ['Remote hosts', 'Hosts allowed to connect to your databases from outside.', 1, { slug: 'remote-hosts', feature: 'mysql' }],
    ['phpMyAdmin', 'Open the database administration tool.', 1, { slug: 'phpmyadmin', feature: 'phpmyadmin' }],
  ]],
  ['FTP', 'HardDriveUpload', [
    ['FTP accounts', 'Extra logins limited to a folder of your account.', 1, { slug: 'accounts', feature: 'ftpaccts' }],
  ]],
  ['Cron', 'Clock', [
    ['Cron jobs', 'Commands that run on a schedule.', 1, { feature: 'cron' }],
  ]],
  ['Backups', 'Archive', [
    ['Backups', 'Generate and download backups of your account.', 1, { feature: 'backup' }],
    ['Restore', 'Put files back from a backup or an uploaded archive.', 1, { feature: 'backup' }],
  ]],
  ['Logs', 'ScrollText', [
    ['Access logs', 'Web server access and error logs for your domains.', 1, { feature: 'rawlog' }],
    ['Bandwidth', 'Traffic per month against your plan.', 1],
    ['Visitors', 'Who visits your sites: visitors, pages, referrers and the full report.', 1, { feature: 'webstats' }],
  ]],
  ['PHP', 'Code', [
    ['PHP versions', 'The PHP version each domain runs.', 1, { slug: 'versions', feature: 'phpversion' }],
    ['PHP settings', 'Per-domain .user.ini directives.', 1, { slug: 'ini', feature: 'phpversion' }],
  ]],
  ['Security', 'Shield', [
    ['Password', 'Change the password for this account.', 1, { feature: 'passwordchange' }],
    ['Two-factor authentication', 'Protect sign-in with a one-time code.', 1, { slug: 'two-factor' }],
    ['SSH keys', 'Public keys allowed to open a shell on this account.', 1, { feature: 'ssh' }],
    ['Sessions', 'Where this account is signed in.', 1],
    ['API tokens', 'Tokens for scripts that use the panel API.', 1, { slug: 'tokens', feature: 'api' }],
    ['IP blocker', 'Keep addresses and ranges away from your sites.', 1, { feature: 'ipblocker' }],
  ]],
  ['Usage', 'Gauge', [
    ['Usage', 'Disk, bandwidth and object counts against your plan.', 1],
  ]],
  ['Advanced', 'Wrench', [
    ['Error pages', 'Your own pages for 404 and the other error responses.', 1, { feature: 'errpgs' }],
  ]],
  ['Software', 'Package', [
    ['WordPress', 'Install, update and remove WordPress on your domains.', 1, { feature: 'wordpress' }],
  ]],
];

export const PANEL_CATEGORIES = buildNav(PANEL_CATEGORY_DEFS, { basePath: PANEL_BASE, keyPrefix: PANEL_KEY_PREFIX });
export const PANEL_FUNCTIONS = PANEL_CATEGORIES.flatMap((c) => c.functions);
export const PANEL_FUNCTION_BY_KEY = Object.fromEntries(PANEL_FUNCTIONS.map((f) => [f.key, f]));
export const PANEL_FUNCTION_BY_PATH = Object.fromEntries(PANEL_FUNCTIONS.map((f) => [f.path, f]));
export const PANEL_CATEGORY_BY_SLUG = Object.fromEntries(PANEL_CATEGORIES.map((c) => [c.slug, c]));

// 'panel:overview/dashboard' → 'overview/dashboard' (the i18n and registry id).
export function panelId(fnOrKey) {
  const key = typeof fnOrKey === 'string' ? fnOrKey : fnOrKey?.key;
  return key ? key.replace(/^panel:/, '') : '';
}

// Plan features gate functions: a missing key means enabled.
export function featureEnabled(features, feature) {
  if (!feature) return true;
  if (!features || typeof features !== 'object') return true;
  return features[feature] !== false;
}

export function visibleCategories(features) {
  return PANEL_CATEGORIES
    .map((c) => ({ ...c, functions: c.functions.filter((f) => featureEnabled(features, f.feature)) }))
    .filter((c) => c.functions.length > 0);
}

export function searchPanelFunctions(query, features) {
  const q = String(query || '').trim().toLowerCase();
  const pool = features ? visibleCategories(features).flatMap((c) => c.functions) : PANEL_FUNCTIONS;
  if (!q) return pool;
  const terms = q.split(/\s+/);
  return pool.filter((f) => {
    const hay = `${f.label} ${f.category} ${f.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// Well-known panel shell paths (not functions) the layout and the router share.
export const PANEL_PATHS = {
  home: PANEL_BASE,
  password: `${PANEL_BASE}/security/password`,
  twoFactor: `${PANEL_BASE}/security/two-factor`,
  changePassword: `${PANEL_BASE}/change-password`,
};
