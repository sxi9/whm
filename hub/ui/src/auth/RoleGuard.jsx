import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loading } from '../components/Common.jsx';
import { useAuth, areaOf, loginPathFor, homeOf } from './AuthContext.jsx';

// Pure decision so the matrix is testable without a DOM:
// ok | login (no session or a session of another kind) | forbidden (right area, wrong role).
export function guardDecision(session, area, roles = null) {
  if (!session) return 'login';
  if (areaOf(session) !== area) return 'login';
  if (roles && session.kind === 'portal' && !roles.includes(session.user?.role)) return 'forbidden';
  return 'ok';
}

// Where a portal session that must still enrol an authenticator is sent, or
// null when it may stay where it is (its own Security page, or no obligation).
export function enrolRedirect(session, area, pathname) {
  if (!session || session.kind !== 'portal' || !session.totpEnrolRequired || session.totpEnabled) return null;
  const security = `/${area}/security`;
  return pathname === security ? null : `${security}?enrol=1`;
}

export function RequireArea({ area, roles = null, children }) {
  const { session, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <div className="app-loading"><Loading text="Checking your session…" /></div>;
  const decision = guardDecision(session, area, roles);
  if (decision === 'login') {
    // A session of another kind goes to its own home rather than to a login page it cannot use.
    const to = session ? homeOf(session) : `${loginPathFor(area)}?next=${encodeURIComponent(location.pathname)}`;
    return <Navigate to={to} replace />;
  }
  if (decision === 'forbidden') return <ForbiddenPage />;
  const enrol = enrolRedirect(session, area, location.pathname);
  if (enrol) return <Navigate to={enrol} replace />;
  return children || <Outlet />;
}

export function ForbiddenPage() {
  return (
    <div className="content">
      <div className="banner banner-error" role="alert"><div><strong>Your role cannot open this page.</strong><p className="muted">Ask a vendor administrator for access.</p></div></div>
    </div>
  );
}

// "/" sends a signed-in user to their area and everyone else to the portal login.
export function RootRedirect() {
  const { session, ready } = useAuth();
  if (!ready) return <div className="app-loading"><Loading /></div>;
  return <Navigate to={homeOf(session)} replace />;
}
