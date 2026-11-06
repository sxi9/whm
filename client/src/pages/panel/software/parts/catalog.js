// The one-click installer catalog as the panel sees it. The server keeps the
// matching catalog (release pins, checksums, pipeline) in services/panel-software.js
// (WordPress) and services/panel-installers.js (`APPS`); an entry here only says
// how the shared page talks to it and what it calls things.
//
//   id          catalog key (= the server's app id and the `?app=` tab)
//   feature     plan feature that gates the tab (`installers` opens the page; a missing key means enabled)
//   api         list: GET (rows carry `app` when the list is shared, the page filters), install: POST,
//               remove(id): DELETE ?confirm=true&database=, update(id): POST or null, stream(jobId): the
//               account's job stream path. Per-app install state comes from `meta.catalog[]` when the
//               list is shared, from `meta` itself otherwise.
//   fields      the install form fields the app takes beside domain + folder
//   passwordMin shortest administrator password the app accepts
//   configFile  the file whose presence makes a directory count as an install (what the list explains)
//   idPrefix    DOM id prefix of the install form (defaults to the id)
//   cli         requirements flag that enables in-panel updates (null: the app updates from its own dashboard)
//   setup       'panel' when the job finishes the install itself, 'web' when the job delivers files +
//               configured database and the page hands the visitor to the app's own web installer
//   label/vendor/cliLabel are proper names and stay untranslated.
const shared = (id) => ({
  list: '/software/installers', install: `/software/installers/${id}`, remove: (installId) => `/software/installers/${encodeURIComponent(installId)}`, update: null,
  stream: (jobId) => `/panel/software/installers/jobs/${jobId}/stream`,
});

export const INSTALLER_CATALOG = [
  {
    id: 'wordpress', idPrefix: 'wp', label: 'WordPress', vendor: 'wordpress.org', feature: 'wordpress', configFile: 'wp-config.php', adminPath: 'wp-admin/', cli: 'wpcli', cliLabel: 'WP-CLI', setup: 'panel',
    fields: ['title', 'adminUser', 'adminEmail', 'adminPassword'], passwordMin: 8,
    api: { list: '/software/wordpress', install: '/software/wordpress', remove: (installId) => `/software/wordpress/${encodeURIComponent(installId)}`, update: (installId) => `/software/wordpress/${encodeURIComponent(installId)}/update`, stream: (jobId) => `/panel/software/wordpress/jobs/${jobId}/stream` },
  },
  { id: 'joomla', label: 'Joomla', vendor: 'downloads.joomla.org', feature: 'installers', configFile: 'configuration.php', adminPath: 'administrator/', cli: null, cliLabel: null, setup: 'panel', fields: ['title', 'adminUser', 'adminEmail', 'adminPassword'], passwordMin: 12, api: shared('joomla') },
  { id: 'drupal', label: 'Drupal', vendor: 'ftp.drupal.org', feature: 'installers', configFile: 'sites/default/settings.php', adminPath: 'user/login', cli: null, cliLabel: null, setup: 'web', fields: [], passwordMin: null, api: shared('drupal') },
];

export const INSTALLER_BY_ID = Object.fromEntries(INSTALLER_CATALOG.map((a) => [a.id, a]));
export const DEFAULT_INSTALLER = INSTALLER_CATALOG[0].id;

export const INSTALLERS_PATH = '/panel/software/installers';
export const installerPath = (id) => (id === DEFAULT_INSTALLER ? `${INSTALLERS_PATH}` : `${INSTALLERS_PATH}?app=${encodeURIComponent(id)}`);

// The tabs a plan shows: the page's own feature opens the catalog, each app
// additionally needs its own feature when the plan names one.
export function visibleInstallers(hasFeature = () => true) {
  return INSTALLER_CATALOG.filter((a) => !a.feature || hasFeature(a.feature));
}

export function resolveInstaller(id, hasFeature) {
  const list = visibleInstallers(hasFeature);
  return list.find((a) => a.id === id) || INSTALLER_BY_ID[id] || list[0] || INSTALLER_CATALOG[0];
}

// The app's own slice of a list answer: its rows, and its install state
// (a shared list carries one `meta.catalog[]` entry per app).
export function appSlice(app, data, meta) {
  const rows = (data || []).filter((r) => !r.app || r.app === app.id);
  const entry = Array.isArray(meta?.catalog) ? meta.catalog.find((c) => c.id === app.id) || null : null;
  const state = meta ? { requirements: meta.requirements || {}, canInstall: entry ? Boolean(entry.canInstall) : Boolean(meta.canInstall), hint: (entry ? entry.hint : meta.hint) || null, version: entry?.version ?? meta.version ?? null } : null;
  return { rows, state };
}
