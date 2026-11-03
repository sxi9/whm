// Where a signed-in principal lands and which shell a path belongs to. Login.jsx
// and Layout.jsx use these once the integrator wires /panel into the router
// (design §6.2): a role-user session never lands on an admin route and an admin
// is never bounced into the account panel by a stale `state.from`.

export const PANEL_HOME = '/panel';
export const ADMIN_HOME = '/';

export function isPanelPath(pathname) {
  const p = String(pathname || '');
  return p === PANEL_HOME || p.startsWith(`${PANEL_HOME}/`);
}

export function homePathFor(user) {
  return user?.role === 'user' ? PANEL_HOME : ADMIN_HOME;
}

// True when `pathname` is inside the shell this user belongs to. Admins may open
// /panel too (they reach it through "Log in as"), so only the user role is confined.
export function inShellFor(user, pathname) {
  if (!pathname || typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  if (pathname.startsWith('/login')) return false;
  if (user?.role === 'user') return isPanelPath(pathname);
  return true;
}

// The destination after login: the remembered location when it fits the user's shell, else their home.
export function landingFor(user, from) {
  return from && inShellFor(user, from) ? from : homePathFor(user);
}
