import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { useBranding, isPanelShell } from './pages/cpanel/branding.js';
import { FUNCTIONS } from './nav.js';
import { PAGE_REGISTRY } from './pages/registry.js';
import { HomePage } from './pages/Home.jsx';
import { LoginPage } from './pages/Login.jsx';
import { ResetRequestPage } from './pages/auth/ResetRequest.jsx';
import { ResetConfirmPage } from './pages/auth/ResetConfirm.jsx';
import { ChangePasswordPage } from './pages/ChangePassword.jsx';
import { FunctionPage, NotFoundPage } from './pages/FunctionPage.jsx';
import { AuditLogPage } from './pages/AuditLog.jsx';
import PluginPage from './pages/plugins/PluginPage.jsx';
import { panelRoutes } from './panel/routes.jsx';

// One route per function, generated from nav.js. A registered page gets its
// component; everything else renders the generic FunctionPage.
const functionRoutes = FUNCTIONS.map((fn) => {
  const Page = PAGE_REGISTRY[fn.key];
  return { path: fn.path.slice(1), element: Page ? <Page fn={fn} /> : <FunctionPage fn={fn} /> };
});

// The account-panel listener (port 2083) serves only /panel: the server 302s a
// full page load of `/`, this covers an in-app navigation to it.
export function IndexRoute() {
  const branding = useBranding();
  if (isPanelShell(branding)) return <Navigate to="/panel" replace />;
  return <HomePage />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/login/reset', element: <ResetRequestPage /> },
  { path: '/login/reset/:token', element: <ResetConfirmPage /> },
  ...panelRoutes,
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <IndexRoute /> },
      { path: 'change-password', element: <ChangePasswordPage /> },
      { path: 'audit-log', element: <AuditLogPage /> },
      ...functionRoutes,
      // Enabled plugins register pages at runtime; one dynamic route serves them all.
      { path: 'plugins/:pluginId/*', element: <PluginPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
