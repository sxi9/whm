import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Shell } from './shell/Shell.jsx';
import { RequireArea, RootRedirect } from './auth/RoleGuard.jsx';
import { AREA_ROLES } from './auth/AuthContext.jsx';
import { PortalLoginPage, DeveloperLoginPage } from './auth/Login.jsx';

import AdminDashboard from './pages/admin/Dashboard.jsx';
import AdminLicenses from './pages/admin/Licenses.jsx';
import AdminLicenseDetail from './pages/admin/LicenseDetail.jsx';
import AdminCustomers from './pages/admin/Customers.jsx';
import AdminResellers from './pages/admin/Resellers.jsx';
import AdminProducts from './pages/admin/Products.jsx';
import AdminTrials from './pages/admin/Trials.jsx';
import AdminIntegrations from './pages/admin/Integrations.jsx';
import AdminReports from './pages/admin/Reports.jsx';
import AdminAudit from './pages/admin/Audit.jsx';
import AdminVerificationQueue from './pages/admin/VerificationQueue.jsx';
import AdminDevelopers from './pages/admin/Developers.jsx';
import AdminReviewQueue from './pages/admin/ReviewQueue.jsx';
import AdminReviewDetail from './pages/admin/ReviewDetail.jsx';
import AdminCatalog from './pages/admin/Catalog.jsx';
import AdminRevocations from './pages/admin/Revocations.jsx';
import AdminEntitlements from './pages/admin/Entitlements.jsx';
import AdminPayouts from './pages/admin/Payouts.jsx';
import AdminReviewModeration from './pages/admin/ReviewModeration.jsx';
import AdminSigningKeys from './pages/admin/SigningKeys.jsx';

import ResellerDashboard from './pages/reseller/Dashboard.jsx';
import ResellerLicenses from './pages/reseller/Licenses.jsx';
import ResellerCustomers from './pages/reseller/Customers.jsx';
import ResellerActivations from './pages/reseller/Activations.jsx';
import ResellerApiKeys from './pages/reseller/ApiKeys.jsx';
import ResellerStatement from './pages/reseller/Statement.jsx';

import DevRegister from './pages/dev/Register.jsx';
import DevVerifyEmail from './pages/dev/VerifyEmail.jsx';
import DevProfile from './pages/dev/Profile.jsx';
import DevSecurity from './pages/dev/Security.jsx';
import DevVerification from './pages/dev/Verification.jsx';
import DevKeys from './pages/dev/Keys.jsx';
import DevPlugins from './pages/dev/Plugins.jsx';
import DevPluginEdit from './pages/dev/PluginEdit.jsx';
import DevVersions from './pages/dev/Versions.jsx';
import DevVersionDetail from './pages/dev/VersionDetail.jsx';
import DevUpload from './pages/dev/Upload.jsx';
import DevStats from './pages/dev/Stats.jsx';
import DevPayouts from './pages/dev/Payouts.jsx';
import DevApiKeys from './pages/dev/ApiKeys.jsx';
import DevWebhooks from './pages/dev/Webhooks.jsx';

// Three guarded areas under one SPA. Paths below are the single source of
// truth for the sidebar (shell/nav.js links point here) and for the tests.
export const routes = [
  { path: '/', element: <RootRedirect /> },
  { path: '/login', element: <PortalLoginPage /> },
  { path: '/dev/login', element: <DeveloperLoginPage /> },
  { path: '/dev/register', element: <DevRegister /> },
  { path: '/dev/verify-email', element: <DevVerifyEmail /> },
  { path: '/dev/password-reset', element: <DevSecurity mode="reset" /> },
  {
    path: '/admin',
    element: <RequireArea area="admin" roles={AREA_ROLES.admin}><Shell area="admin" /></RequireArea>,
    children: [
      { index: true, element: <AdminDashboard /> },
      { path: 'licenses', element: <AdminLicenses /> },
      { path: 'licenses/:id', element: <AdminLicenseDetail /> },
      { path: 'customers', element: <AdminCustomers /> },
      { path: 'resellers', element: <AdminResellers /> },
      { path: 'products', element: <AdminProducts /> },
      { path: 'trials', element: <AdminTrials /> },
      { path: 'integrations', element: <AdminIntegrations /> },
      { path: 'reports', element: <AdminReports /> },
      { path: 'audit', element: <AdminAudit /> },
      { path: 'signing-keys', element: <AdminSigningKeys /> },
      { path: 'market/verifications', element: <AdminVerificationQueue /> },
      { path: 'market/developers', element: <AdminDevelopers /> },
      { path: 'market/developers/:id', element: <AdminDevelopers /> },
      { path: 'market/reviews', element: <AdminReviewQueue /> },
      { path: 'market/reviews/:id', element: <AdminReviewDetail /> },
      { path: 'market/catalog', element: <AdminCatalog /> },
      { path: 'market/catalog/:id', element: <AdminCatalog /> },
      { path: 'market/revocations', element: <AdminRevocations /> },
      { path: 'market/entitlements', element: <AdminEntitlements /> },
      { path: 'market/payouts', element: <AdminPayouts /> },
      { path: 'market/plugin-reviews', element: <AdminReviewModeration /> },
      { path: '*', element: <Navigate to="/admin" replace /> },
    ],
  },
  {
    path: '/reseller',
    element: <RequireArea area="reseller" roles={AREA_ROLES.reseller}><Shell area="reseller" /></RequireArea>,
    children: [
      { index: true, element: <ResellerDashboard /> },
      { path: 'licenses', element: <ResellerLicenses /> },
      { path: 'licenses/:id', element: <ResellerLicenses /> },
      { path: 'customers', element: <ResellerCustomers /> },
      { path: 'activations', element: <ResellerActivations /> },
      { path: 'api-keys', element: <ResellerApiKeys /> },
      { path: 'statement', element: <ResellerStatement /> },
      { path: '*', element: <Navigate to="/reseller" replace /> },
    ],
  },
  {
    path: '/dev',
    element: <RequireArea area="dev"><Shell area="dev" /></RequireArea>,
    children: [
      { index: true, element: <DevProfile /> },
      { path: 'security', element: <DevSecurity /> },
      { path: 'verification', element: <DevVerification /> },
      { path: 'keys', element: <DevKeys /> },
      { path: 'plugins', element: <DevPlugins /> },
      { path: 'plugins/:id', element: <DevPluginEdit /> },
      { path: 'plugins/:id/versions', element: <DevVersions /> },
      { path: 'plugins/:id/versions/:v', element: <DevVersionDetail /> },
      { path: 'plugins/:id/upload', element: <DevUpload /> },
      { path: 'plugins/:id/stats', element: <DevStats /> },
      { path: 'upload', element: <DevUpload /> },
      { path: 'stats', element: <DevStats /> },
      { path: 'payouts', element: <DevPayouts /> },
      { path: 'api-keys', element: <DevApiKeys /> },
      { path: 'webhooks', element: <DevWebhooks /> },
      { path: '*', element: <Navigate to="/dev" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function createRouter() {
  return createBrowserRouter(routes);
}

// Flat list of every concrete path (for tests and the sidebar check).
export function flattenPaths(list = routes, prefix = '') {
  const out = [];
  for (const r of list) {
    const full = r.index ? prefix : r.path?.startsWith('/') ? r.path : `${prefix}/${r.path || ''}`.replace(/\/+/g, '/');
    if (r.path !== '*') out.push(full);
    if (r.children) out.push(...flattenPaths(r.children, full));
  }
  return out;
}
