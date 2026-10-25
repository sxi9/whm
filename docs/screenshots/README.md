# Screenshots

Captured by `e2e/ui-check.cjs` (Playwright, 1440×900) against the built interface served by
the API in development mode on 2026-10-25. The host had none of the managed daemons
installed, so service rows read "Not installed" — on a provisioned server they show PID,
memory, restarts and Start/Stop/Restart actions.

| File | What it shows |
|---|---|
| [01-login.png](01-login.png) | Login page |
| [02-dashboard.png](02-dashboard.png) | Home: Favorites, Tools grid, Statistics panel (live load/memory/disk/OS), service status dots |
| [02-dashboard-full.png](02-dashboard-full.png) | Home, full page: all 30 categories in the Tools grid |
| [03-create-account-form.png](03-create-account-form.png) | Create a New Account — auto-suggested username, password strength meter and generator, package selector |
| [04-create-account-result.png](04-create-account-result.png) | Account created — real Linux user provisioned; per-step provisioning status |
| [05-list-accounts.png](05-list-accounts.png) | List Accounts — sortable, searchable, row actions (Modify, Suspend, Password, Upgrade, Terminate) |
| [06-service-status.png](06-service-status.png) | Service Status — monitored services and their state |
| [07-server-information.png](07-server-information.png) | Server Information — load, uptime, memory/swap meters, disks, network interfaces |
| [08-feature-manager.png](08-feature-manager.png) | Feature Manager — per-plan feature toggles |
| [09-tweak-settings.png](09-tweak-settings.png) | Tweak Settings — grouped switches with sticky Save/Reset |
| [10-generic-function-page.png](10-generic-function-page.png) | Placeholder shown by functions whose screen is scheduled for a later build phase |
| [11-sidebar-search.png](11-sidebar-search.png) | Sidebar filter narrowing the categories to matching functions |
| [12-top-search.png](12-top-search.png) | Global search (Alt + /) with keyboard navigation |
| [13-restart-service.png](13-restart-service.png) | Restart Services › HTTP Server (Apache) — action page with current state |
| [14-process-manager.png](14-process-manager.png) | Process Manager — live processes with kill / force kill / renice |

Regenerate: `BASE=http://127.0.0.1:2086 PASSWORD='<root password>' OUT=docs/screenshots node e2e/ui-check.cjs`.
