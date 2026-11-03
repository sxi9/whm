import { createContext, useContext } from 'react';

// Which shell a page renders in. The admin shell is the default (so every existing
// page keeps working untouched); PanelLayout provides the /panel values. PageHeader
// in components/Common.jsx reads `home` and `i18nPrefix` from here once the
// integrator wires it (design §6.3); PanelPageHeader reads it today.
export const ADMIN_SHELL = Object.freeze({ name: 'admin', home: '/', i18nPrefix: 'fn', categoryPrefix: 'category', favoritesKey: 'whm.favorites' });
export const PANEL_SHELL = Object.freeze({ name: 'panel', home: '/panel', i18nPrefix: 'panel', categoryPrefix: 'panel-category', favoritesKey: 'whm.panel.favorites' });

export const ShellContext = createContext(ADMIN_SHELL);

export function useShell() {
  return useContext(ShellContext) || ADMIN_SHELL;
}
