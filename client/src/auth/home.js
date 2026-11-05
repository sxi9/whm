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

export const PANEL_SHELL = 'panel';

// `shell` is the origin's shell from GET /api/branding: the account-panel
// listener (port 2083) serves only /panel, so every role lands there; an admin
// with a session on that origin sees the panel's own "no account" state.
export function homePathFor(user, shell) {
  if (shell === PANEL_SHELL) return PANEL_HOME;
  return user?.role === 'user' ? PANEL_HOME : ADMIN_HOME;
}

// True when `pathname` is inside the shell this user belongs to. Admins may open
// /panel too (they reach it through "Log in as"), so only the user role is confined.
export function inShellFor(user, pathname, shell) {
  if (!pathname || typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  if (pathname.startsWith('/login')) return false;
  if (shell === PANEL_SHELL || user?.role === 'user') return isPanelPath(pathname);
  return true;
}

// The destination after login: the remembered location when it fits the user's shell, else their home.
export function landingFor(user, from, shell) {
  return from && inShellFor(user, from, shell) ? from : homePathFor(user, shell);
}
