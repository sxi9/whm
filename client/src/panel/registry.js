import { lazy } from 'react';

// Panel pages are discovered from client/src/pages/panel/<group>/<function>.jsx —
// the file path IS the function id from panel/nav.js (key 'panel:<group>/<function>'),
// so adding a page never edits this file. A page default-exports a component that
// receives { fn }. Shared pieces of a group go one level deeper (e.g.
// pages/panel/email/parts/*.jsx): the glob only matches depth two. The admin
// registry (pages/registry.js, './fn/*/*.jsx') is untouched.
const discovered = import.meta.glob('../pages/panel/*/*.jsx');

export const PANEL_PAGE_REGISTRY = Object.fromEntries(Object.entries(discovered).map(([file, loader]) => {
  const m = file.match(/^\.\.\/pages\/panel\/([^/]+)\/([^/]+)\.jsx$/);
  return [`panel:${m[1]}/${m[2]}`, lazy(loader)];
}));

// Keys without the lazy wrappers, for tests that run outside Vite's glob transform.
export function registryKeysFrom(files) {
  return files.map((file) => file.match(/^(?:\.\.\/)?pages\/panel\/([^/]+)\/([^/]+)\.jsx$/)).filter(Boolean).map((m) => `panel:${m[1]}/${m[2]}`);
}
