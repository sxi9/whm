# Screenshots

Updated 2026-10-27 at commit `2e995d3`. All images are captured automatically (Playwright) against the built interface served by the API, and each carries a label bar naming the screen, whether it is live or a placeholder, the date and the commit. They are regenerated at every milestone (`e2e/screenshots.sh`).

- **[Every page →](pages/README.md)** — all 212 function pages grouped by category (212/212 live) plus core pages.

## Flow

Login → dashboard → creating an account through the form → lists, status pages, configuration and search.

<table><tr><td align="center" valign="top" width="33%"><a href="01-login.png"><img src="01-login.png" width="400" alt="Login"></a><br><sub><b>Login</b></sub></td><td align="center" valign="top" width="33%"><a href="02-dashboard.png"><img src="02-dashboard.png" width="400" alt="Home dashboard"></a><br><sub><b>Home dashboard</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="02-dashboard-full.png"><img src="02-dashboard-full.png" width="400" alt="Home dashboard (full page)"></a><br><sub><b>Home dashboard (full page)</b></sub></td><td align="center" valign="top" width="33%"><a href="03-create-account-form.png"><img src="03-create-account-form.png" width="400" alt="Create a New Account — form"></a><br><sub><b>Create a New Account — form</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="04-create-account-result.png"><img src="04-create-account-result.png" width="400" alt="Create a New Account — result"></a><br><sub><b>Create a New Account — result</b></sub></td><td align="center" valign="top" width="33%"><a href="05-list-accounts.png"><img src="05-list-accounts.png" width="400" alt="List Accounts"></a><br><sub><b>List Accounts</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="06-service-status.png"><img src="06-service-status.png" width="400" alt="Service Status"></a><br><sub><b>Service Status</b></sub></td><td align="center" valign="top" width="33%"><a href="07-server-information.png"><img src="07-server-information.png" width="400" alt="Server Information"></a><br><sub><b>Server Information</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="08-feature-manager.png"><img src="08-feature-manager.png" width="400" alt="Feature Manager"></a><br><sub><b>Feature Manager</b></sub></td><td align="center" valign="top" width="33%"><a href="09-tweak-settings.png"><img src="09-tweak-settings.png" width="400" alt="Tweak Settings"></a><br><sub><b>Tweak Settings</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="10-wp-toolkit-plugin.png"><img src="10-wp-toolkit-plugin.png" width="400" alt="WP Toolkit (bundled plugin page)"></a><br><sub><b>WP Toolkit (bundled plugin page)</b></sub></td><td align="center" valign="top" width="33%"><a href="11-sidebar-search.png"><img src="11-sidebar-search.png" width="400" alt="Sidebar search"></a><br><sub><b>Sidebar search</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="12-top-search.png"><img src="12-top-search.png" width="400" alt="Global search"></a><br><sub><b>Global search</b></sub></td><td align="center" valign="top" width="33%"><a href="13-restart-service.png"><img src="13-restart-service.png" width="400" alt="Restart HTTP Server (Apache)"></a><br><sub><b>Restart HTTP Server (Apache)</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="14-process-manager.png"><img src="14-process-manager.png" width="400" alt="Process Manager"></a><br><sub><b>Process Manager</b></sub></td><td align="center" valign="top" width="33%"><a href="15-license-tab.png"><img src="15-license-tab.png" width="400" alt="Basic WebHost Manager Setup — License tab"></a><br><sub><b>Basic WebHost Manager Setup — License tab</b></sub></td></tr>
<tr><td align="center" valign="top" width="33%"><a href="16-manage-plugins-marketplace.png"><img src="16-manage-plugins-marketplace.png" width="400" alt="Manage Plugins — Marketplace tab"></a><br><sub><b>Manage Plugins — Marketplace tab</b></sub></td><td align="center" valign="top" width="33%"><a href="17-whm-marketplace.png"><img src="17-whm-marketplace.png" width="400" alt="WHM Marketplace"></a><br><sub><b>WHM Marketplace</b></sub></td></tr></table>

## Regenerate

```bash
BASE=http://127.0.0.1:2086 PASSWORD='<root password>' bash e2e/screenshots.sh   # flow shots + every page + galleries
```
