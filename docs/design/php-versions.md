# Installing PHP versions from the panel — sources, ops, service, UI

Owner's finding (2026-10-30): "all the software like PHP Versions installer must be there, same on the
others". MultiPHP Manager only listed the versions already on the host; there was no way to add PHP
8.1/8.2/8.3/8.4/8.5 from the panel. This page records what now exists, why each choice was made and
what other units must know.

## The one source per family

| Family | Source | How it is enabled (agent argv, never a shell) | What it offers |
|---|---|---|---|
| Ubuntu (ID `ubuntu`, or `ID_LIKE` containing `ubuntu`, e.g. Linux Mint) | `ppa:ondrej/php` | `apt-get install … software-properties-common` when `add-apt-repository` is missing, then `add-apt-repository -y -n ppa:ondrej/php`, then `apt-get update -q` | `php7.4-*` … `php8.5-*` for every supported Ubuntu release (`UBUNTU_CODENAME`) |
| Debian (every other apt host) | `packages.sury.org/php` (same maintainer) | `curl -fsSL --max-time 60 -o <tmp> https://packages.sury.org/php/apt.gpg` into `/etc/apt/keyrings/whm-sury-php.gpg` (0644; `.asc` when the download is armored, since apt reads armored keys only from `.asc`), then `/etc/apt/sources.list.d/whm-sury-php.list` = `deb [signed-by=<keyring>] https://packages.sury.org/php/ <VERSION_CODENAME> main`, then `apt-get update -q`. `curl` + `ca-certificates` are installed first when neither curl nor wget exists. | `php7.4-*` … `php8.5-*` for bullseye/bookworm/trixie |
| RHEL family (AlmaLinux, Rocky, CentOS Stream, RHEL, CloudLinux, Oracle; `dnf` or `yum`) | Remi, SCL packages | `dnf -y -q install -- epel-release` (RHEL proper: the EPEL URL for the OS major when the package does not resolve), `dnf -y -q install -- https://rpms.remirepo.net/enterprise/remi-release-<major>.rpm` (Fedora: `…/fedora/remi-release-<major>.rpm`), best effort `dnf config-manager --set-enabled crb` (EL9) / `powertools` (EL8), then `dnf -y -q makecache` | `php74-php-*` … `php85-php-*` from `remi-safe`, one tree per branch under `/opt/remi/php8x` + `/etc/opt/remi/php8x` |

Why SCL packages and not the modular stream on the RHEL family: `dnf module enable php:remi-8.3`
replaces the single system PHP; it cannot put 8.2 and 8.4 next to each other, which is what MultiPHP
is for. The SCL trees are exactly what `discoverPhp()` (`agent/src/ops/pkg.js`, id `php83`, label
`Remi php83`, unit `php83-php-fpm`) and the web category's `phpLayout()` (`agent/src/ops/web.js`,
`/etc/opt/remi/php83/php-fpm.d`, socket dir `/var/opt/remi/php83/run/php-fpm`) already read, so a branch
installed this way is a pool target immediately. The stock `php-fpm` (`/etc/php-fpm.d`) stays what it was.

The catalog is a constant in `pkg.js` (`PHP_SOURCES`, `PHP_BRANCHES = 7.4 … 8.5`, `PHP_EXTENSIONS`).
Nothing from the API reaches argv except the branch (`/^\d\.\d$/`) and the source key
(`enum ondrej | sury | remi`); a source that does not fit the host is refused with `unsupported`.

## Agent ops (`agent/src/ops/pkg.js`)

| Op | Args | Does | Returns |
|---|---|---|---|
| `pkg.php.sources.detect` | `{ branches? }` | Reads `/etc/os-release` (`WHM_OS_RELEASE_FILE` in tests), picks the source, checks whether it is configured (apt: active lines of `sources.list` + `sources.list.d/*`; commented lines are ignored and a deb822 stanza is dropped as a whole when it carries `Enabled: no` anywhere — software-properties appends it after the URIs line; rpm: `rpm -q remi-release`), asks the package manager about every branch's `-fpm` package **and** the `php-fpm` meta-package in **one** call (`apt-cache policy -- php7.4-fpm … php8.5-fpm php-fpm` / `rpm -q --qf … --` + `dnf -q -y list --`), reads the stock branch from the **distribution's own** entry of `php-fpm`'s version table (`apt-cache depends -- php-fpm=<archive version>`; once the PPA is enabled its meta-package is the candidate and would otherwise move the "distribution" pill; plain `apt-cache depends -- php-fpm` when no archive entry exists; rpm: the `php-fpm` package version). On Debian, when the sury paths are outside the agent's roots, `source.supported` is `false` with the reason instead of a job failing with `path_not_allowed` | `{ manager, family, os: { id, name, versionId, codename }, source: { key, label, url, flavor, codename, major, supported, reason, configured }, stock, branches: PHP_BRANCHES, versions: [{ version, id, package, fpmUnit, offered, installed, candidate, installedVersion, origin, source: 'distro'|'ondrej'|'sury'|'remi'|null }] }` |
| `pkg.php.source.enable` | `{ source, wait }` | Idempotent: when the source is already configured only the index refresh runs. Otherwise the family's steps above; the refresh honours `wait: false` (detached run, polled through `pkg.run.status`). A synchronous refresh that exits non-zero right after the entry was added (apt ≥ 1.1 fails every later `apt-get update` on an entry without a Release file) **removes what this call added again** (`disablePhpSource`: `add-apt-repository -r -y -n ppa:ondrej/php` / the sury list + keyring / `dnf -y -q remove -- remi-release`) and answers `refused` with the package manager's error and `details.steps` (`rollback: …`); a pre-existing entry is never removed (`command_failed`) | `{ source, label, changed, alreadyConfigured, steps: [{ step, ok, path?, output? }], background, run? | code, output }` |
| `pkg.php.source.rollback` (destructive) | `{ source }` | The same undo for the detached path: the service's install job calls it when the refresh run fails after `changed: true`. Only the catalogued entry/keyring/release package is touched | `{ source, label, steps, configured }` |
| `pkg.php.install` | `{ version, extensions?, wait }` | Names = `php8.3-{fpm,cli,common}` + `php8.3-<ext>` (Debian) or `php83-php-{fpm,cli,common}` + `php83-php-<ext>` (Remi); `extensions` are suffixes (`/^[a-z][a-z0-9-]{0,31}$/`, the service passes the stack catalog's php component, the agent's `PHP_EXTENSIONS` is the fallback). One offers query; names no repository offers are **skipped**, never fail the transaction; the `-fpm` package missing means `unsupported` before anything runs. `apt-get install -y -q <dpkg opts> -- …` / `dnf -y -q install -- …`; synchronous runs also `systemctl enable --now <fpmUnit>.service` | `{ version, id, packages, skipped, alreadyInstalled, fpmUnit, prefix, unit: { unit, enabled, note }, … }` |
| `pkg.php.remove` (destructive) | `{ version, purge?, wait }` | Only a `debian` or `remi` layout entry of `discoverPhp()` whose `packagePrefix` matches; refuses (`refused`) the branch `/usr/bin/php` resolves to; `systemctl disable --now <unit>`; removes every installed package with the prefix (`apt-get remove|purge -y -q … --` / `dnf -y -q remove --`) | `{ version, id, packages, purge, fpmUnit, … }` |

Parsers exported for tests: `parseAptPolicyBlocks` (multi-package `apt-cache policy`, origin = first
repository line under the candidate's entry, never `/var/lib/dpkg/status`), `parseDnfList` (`Installed
Packages` / `Available Packages`, wrapped long names), `readOsRelease`, `phpSourceFor`, `phpPackageNames`.

**Allowed roots (integrator):** the sury path writes `/etc/apt/keyrings/whm-sury-php.{gpg,asc}` and
`/etc/apt/sources.list.d/whm-sury-php.list` through `ctx.assertAllowedPath(..., 'write')`. Those two
directories are not in `DEFAULT_ALLOWED_ROOTS` (`agent/src/lib.js`) yet; until they are added
`pkg.php.sources.detect` reports `source.supported: false` with the reason ("the agent may not write
/etc/apt/keyrings; add /etc/apt/keyrings and /etc/apt/sources.list.d to its allowed roots"), the card shows
the source as *unavailable* and Install stays disabled on Debian instead of a job failing with
`path_not_allowed`. Ubuntu (`add-apt-repository`) and Remi (`dnf install <rpm>`) write nothing through the
agent. Tests point `WHM_APT_ROOT` under `/tmp/whm` the way `WHM_PKG_RUN_DIR` already does.

**Ghost trees (integrator):** the removal job purges (`purge: true`), so dpkg drops `/etc/php/X.Y/fpm/pool.d`
with the conffiles. `phpLayout()` in `agent/src/ops/web.js` still lists any `/etc/php/<v>/fpm/pool.d`
directory as an FPM tree without checking for the `php-fpm<v>` binary; a tree left by a manual
`apt-get remove` would still be offered as a pool target (`resolvePhpVersion` falls back to the highest
tree). It should require `hasBinary('php-fpm<v>')` (Debian) / `<d>-php-fpm` (Remi) before listing a tree.

## Service (`server/src/services/software.js`, `ctx.software.php`)

- `installable()` — `requirePkg()` only (works with no PHP on the host, which is when it matters most):
  merges `pkg.php.sources.detect` with `php.versions()` (installed ids, labels, advisories, default) and the
  usage of every pinning store. Each row: `{ version, id, label, offered, installed, installedVersion,
  candidate, source, fpmUnit, layout, stock, isDefault, isCliDefault, inUse, usage, inUseDetail, advisories,
  removable }`; `removable` = installed, no removal blocker (below), layout `debian`/`remi`. Installed trees
  outside the catalog (`ea-php74`, `rh-php73`, `system`) are appended read-only. `recent` = the last ten
  install/remove jobs.
- **Usage (`phpUsageOf(id, branch)`)** — a branch is assigned to sites through five stores, and the web
  category normalises every one of them to the branch (`'8.3'`, `'php83'`, `'ea-php83'` all render with the
  8.3 tree) before it picks the FPM tree, so the count does the same (`branchOfPin`):
  `account_domains.php_version = id` (MultiPHP's explicit choice), `web_vhosts.php_version` (rendered vhosts
  pinned by Modify / Upgrade-Downgrade Account through `ctx.web.setPhpVersion`; a domain with both rows counts
  once), `web_php_pools.version` (pools the web category wrote), `packages.php_version` (hosting packages)
  and `accounts.plan_snapshot_json.php_version` (the plan applied at creation / Modify Account, which
  `resolvePhpVersion` reads **before** the system default), plus `ctx.web.apache.settings().defaultPhpVersion`.
  The tables are queried directly behind a `sqlite_master` guard (an integrator may replace the two web
  queries with a `ctx.web.phpVersionUsage(branch)` later). `usage = { domains, vhosts, pools, packages[],
  accounts, apachePin, total }`, `inUse = total`, `inUseDetail` = e.g. `"1 domain, 2 rendered vhosts, package
  'biz', 3 accounts whose plan pins it, Apache Configuration's web default"` — shown in the card's *In use by*
  column and in the 409.
- `installVersion(branch, user, req)` — 422 for a branch outside `PHP_BRANCHES` (mirrored from the agent;
  the API accepted `0.0`/`9.9` before and the job enabled the source for them); 409 when the id (`8.3` /
  `php83`) is already installed; 409 when another package-manager job (`software.php.*`, `software.pkg.*`,
  `software.system.update`, `software.nginx.install`, `software.ea4.build`) is queued or running (apt/dnf
  hold one lock; `assertPackageManagerFree()`); otherwise enqueues `software.php.install { version }` (202),
  audit `software.php.install`.
- Job `software.php.install`: `php.versions()` snapshot (`before`: `effectiveDefault`, `defaultId`) → detect
  → if the branch is not offered: not in the agent's `branches` → fail before anything is enabled; no source
  → fail; source configured → fail ("not offered by <source> for <os>"); else `pkg.php.source.enable`
  (`runLongOp`, output streamed; **when the detached refresh fails after `changed: true` the job calls
  `pkg.php.source.rollback` and logs the steps, then fails**) and detect again → `pkg.php.install { version,
  extensions }` → `svc.enable <fpmUnit>` (the detached run cannot enable it itself) → `capabilities.refresh()`,
  `web.phpfpm.detect` (logged), `ctx.web.detect(true)` → **`keepPreviousDefault`**: php8.4-cli's postinst
  registers `/usr/bin/php` with alternatives priority 84 > 83, so in auto mode (every host where nobody ran
  `--set`) the CLI flips to the new branch and `effectiveDefault` / `resolvePhpVersion` would follow it while
  `php.default_version` names nothing installed (the seed `ea-php83`). The job therefore pins
  `php.default_version` to `before.effectiveDefault` when the configured value is not an installed id, and
  calls `pkg.php.default.set { version: before.defaultId }` when `defaultId` changed (alternatives go to
  manual mode, so later installs do not flip it either). Result `{ version, id, packages, skipped, fpmUnit,
  unitEnabled, source, sourceEnabled, defaultKept: { effectiveDefault, pinned, cliRestored } | null }`.
- `removeVersion(id, user, req)` — 404 unknown id; then `phpRemovalCheck(id)`: 409 system default; 409 CLI
  default (`/usr/bin/php`); 409 "still used by <inUseDetail>"; 422 for a non-versioned layout; 409 while the
  package manager is held; else `software.php.remove { id, version }` (202), audit `software.php.remove`.
  **The job runs the same `phpRemovalCheck` again** (system default, CLI default and every usage store — a
  default set or a pin added while the job waited behind other jobs stops it: "PHP 8.2 is now used by …
  (nothing was removed)"), then `pkg.php.remove { version, purge: true }` (dpkg drops the conffiles and the
  empty `pool.d`, so `phpLayout()` stops offering the tree), then refreshes detection like the install.
- The extension list comes from `componentByKey('php').packages[family]` in `server/src/lib/stack-catalog.js`
  (`php-mysql` → `mysql`, `fpm/cli/common` dropped): one catalog, as decided on 2026-10-30.

Routes (`server/src/routes/categories/software.js`, all `requireRoot`): `GET /api/software/php/installable`,
`POST /api/software/php/install { version }` (202), `DELETE /api/software/php/versions/:id` (202).
Resellers get 403 on all three; the PHP version dropdown they use is unchanged.

## UI

- **MultiPHP Manager** › *Install a PHP version* (`PhpInstallCard`, root only): the source pill
  (enabled / not enabled yet / unavailable), OS + package manager + the distribution's own branch, one row
  per catalog branch with status (installed · version / available · candidate / not offered), source,
  *In use by* (`inUseDetail`, every pinning store), and **Install** / **Remove**. `phpRowAction(v, source)`
  decides: Install is live for an offered branch and for any branch while the source is not enabled yet
  (the job enables it); disabled with the reason when the enabled source does not carry it. Remove is live
  only for `removable` rows, otherwise disabled with "system default" / "CLI default (/usr/bin/php)" /
  "used by <inUseDetail>" / "not a versioned package set". `phpRowLocked(action, runner)` disables every
  row button while a request is in flight (`runner.busy`) **and while the started job is still running**
  (`runner.running`, set by `useJobRunner.start` on the 202 and cleared by the job log's end): a second
  apt-get/dnf would only fail on the package-manager lock, and the server refuses it with 409 as well.
  Confirm dialogs explain the job (the install keeps domains, new accounts and the system default where they
  are and points `/usr/bin/php` back if the install moved it; the removal purges the package set and names
  the stores that would block it); removal asks to type the id. The job log is inline (`useJobRunner` +
  `JobPanel`); finishing refetches versions, domains, pools and the card. Previous installs/removals are
  listed with a *Log* button. A 501 (no package manager) renders the capability notice. The card renders
  even when `/php/versions` answers 501 (no PHP yet): the installed-versions card shows the `Install PHP`
  prompt (stack component) and the card offers the specific branches.
- **MultiPHP INI Editor**: unchanged except the version picker now says "No PHP installed", has a *Re-detect
  versions* button and a link to the installer. The editor fetches on mount, so a version installed on the
  Manager page is listed as soon as the editor is opened.
- **"Same on the others"** — pages reviewed for an install path:
  - `module-installers.jsx`: `InstallerCard` (`client/src/pages/software/Shared.jsx`) now installs the
    missing tool itself: `MODULE_TOOL_PACKAGES[kind][family]` (`pecl` → `php-pear` + `php-dev`/`php-devel`,
    `pear` → `php-pear`, `gem` → `ruby`, `pip` → `python3-pip`; `installPackages` overrides) through
    `POST /software/pkg/install` on the shared runner; the family comes from `/software/pkg/detect`, fetched
    only for a missing tool; "no package manager" is explained instead of a button. The page file itself is
    untouched; its runner has no `onFinished`, so the card asks for a reload after the job.
  - `nginx-manager.jsx`: has *Install NGINX* (`POST /software/nginx/install`). Nothing to add.
  - `easyapache-4.jsx`: builds profiles (`pkg.install` per profile diff). Nothing to add.
  - `rebuild-rpm-database.jsx`: correctly reports "not an RPM-based system" on apt hosts; nothing to install.
  - `install-a-perl-module.jsx` (**not in this unit's file list**): shows a banner "No CPAN client — install
    cpanminus from Install Distro Packages" without a button. Suggested: a *Install cpanminus* button that
    posts `/software/pkg/install { packages: ['cpanminus'] }` (`perl-App-cpanminus` on rhel) through its
    runner, the same way `InstallerCard` now does; or render `CapabilityNotice` with `capability="cpan"`
    once `cpan` has a stack-catalog component (it has none, so the notice would show no button today).

## Tests

- `agent/test/pkg-php-install.test.js` (19): schema rejections (source keys, branches, extensions, extra
  keys, the rollback op), `capability_missing` without a package manager, catalog helpers + both parsers
  (the policy parser's per-entry `versions`, a PPA entry above the archive entry), and the full argv of every
  path with `exec`/`hasBinary` mocked and `/etc/os-release` + `/etc/apt` redirected under `/tmp/whm`:
  Ubuntu (detection from sources files incl. commented lines, a deb822 stanza with `Enabled: no` after its
  URIs line, `# Enabled: no` as a comment and a second active stanza; the stock branch from the archive entry
  with the PPA's meta-package as candidate and the plain fallback; `software-properties-common` →
  `add-apt-repository -y -n ppa:ondrej/php` → `apt-get update -q`, idempotence, mismatched sources refused,
  a failed refresh → `add-apt-repository -r` + `refused` and a pre-existing entry left alone, the rollback op,
  install argv with skipped names, unsupported branch refused before apt-get), Debian (key fetched to a random
  temp name and renamed 0644, `.asc` for armored, non-key download refused and cleaned up, curl installed
  when missing, `path_not_allowed` outside the roots **and** the detection answering `supported: false` there,
  a failed refresh removing list + keyring, the rollback op after a detached enable), Remi (rpm/dnf detection
  with `php-fpm` in the one list call, epel → remi-release URL per major → crb/powertools → makecache, EPEL
  URL fallback on RHEL 8, a failed makecache removing remi-release, SCL install argv, yum argv shape).
  `agent/test/pkg.test.js` (44) carries the injection list against the five ops and the destructive flags.
- `server/test/software.test.js` (51): job types registered, reseller 403 on the three routes, 422 on bad
  branches/ids, 501 `pkg` without a package manager, the installable list (flags, the usage breakdown incl.
  the seeded package / plan pins, read-only ea4 tree, no-PHP host), the five pinning stores one by one (pool,
  rendered vhost, the same site with both rows counted once, package in `ea-php82` spelling + plan snapshot,
  Apache pin) each giving 409 with the store named and `removable: false`, the job's re-check for a pin
  added while queued, 422 for `9.9` + the job's catalog guard with no source touched, 409 while a package job
  is queued (install and remove), the install job's op order (`pkg.php.versions`, `pkg.detect`,
  `pkg.php.versions`, `pkg.php.sources.detect`, `pkg.php.source.enable`, `pkg.php.sources.detect`,
  `pkg.php.install`, `svc.enable`, `web.phpfpm.detect`, `pkg.php.versions`, `pkg.php.default.set`) with the
  stack catalog's extension suffixes, the previous default kept (`php.default_version` pinned from `ea-php83`
  to `8.3`, `pkg.php.default.set { version: '8.3' }` after the mock install flipped `/usr/bin/php` to 8.4, no
  call for an older branch), 409 for an installed branch, a configured source that lacks the branch failing
  the job without re-enabling, a failed detached refresh → `pkg.php.source.rollback` (never for a
  pre-existing entry), removal refusals (404 / system default / CLI default / in use / non-versioned 422),
  the removal job with `purge: true`, audit rows and the job-time re-checks (usage, system default, CLI
  default).
- `client/test/multiphp-install.test.jsx` (9): the card's rows/buttons/reasons, `phpRowAction` with and
  without `inUseDetail`, the *In use by* column, `phpRowLocked` (busy / running / disabled) and the
  runner's idle state, the 501 notice and loading line, the page with no PHP (501) still offering installs,
  the reseller view without the card, the INI editor's empty state, and `InstallerCard`'s tool-install path
  for both families.
