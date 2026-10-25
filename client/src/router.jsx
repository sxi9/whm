import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { FUNCTIONS } from './nav.js';
import { PAGE_REGISTRY } from './pages/registry.js';
import { HomePage } from './pages/Home.jsx';
import { LoginPage } from './pages/Login.jsx';
import { ChangePasswordPage } from './pages/ChangePassword.jsx';
import { FunctionPage, NotFoundPage } from './pages/FunctionPage.jsx';
import { AuditLogPage } from './pages/AuditLog.jsx';

// One route per function, generated from nav.js. A registered page gets its
// component; everything else renders the generic FunctionPage.
const functionRoutes = FUNCTIONS.map((fn) => {
  const Page = PAGE_REGISTRY[fn.key];
  return { path: fn.path.slice(1), element: Page ? <Page fn={fn} /> : <FunctionPage fn={fn} /> };
});

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'change-password', element: <ChangePasswordPage /> },
      { path: 'audit-log', element: <AuditLogPage /> },
      ...functionRoutes,
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
