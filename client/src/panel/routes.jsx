import { Navigate } from 'react-router-dom';
import { PanelLayout } from './PanelLayout.jsx';
import { PanelHome } from './PanelHome.jsx';
import { PanelFunctionPage, PanelNotFoundPage } from './PanelPage.jsx';
import { PANEL_FUNCTIONS, PANEL_PATHS } from './nav.js';
import { PANEL_PAGE_REGISTRY } from './registry.js';

// One route per panel function, generated from panel/nav.js; a registered page
// gets its component, everything else the generic placeholder.
export const panelFunctionRoutes = PANEL_FUNCTIONS.map((fn) => {
  const Page = PANEL_PAGE_REGISTRY[fn.key];
  return { path: fn.path.slice('/panel/'.length), element: Page ? <Page fn={fn} /> : <PanelFunctionPage fn={fn} /> };
});

// Spread into createBrowserRouter([...]) BEFORE the admin '/' entry (design §6.2);
// the only routing edit the integrator makes is `...panelRoutes` in router.jsx.
export const panelRoutes = [
  {
    path: '/panel',
    element: <PanelLayout />,
    children: [
      { index: true, element: <PanelHome /> },
      { path: 'change-password', element: <Navigate to={PANEL_PATHS.password} replace /> },
      ...panelFunctionRoutes,
      { path: '*', element: <PanelNotFoundPage /> },
    ],
  },
];
