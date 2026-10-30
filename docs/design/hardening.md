# Hardening (Security Advisor › Hardening)

Owner's finding (2026-10-30): "make the security side stronger". The Security Advisor only graded;
this page records the one-click items it now applies, what each changes on the host, how it is
reverted, what it never does on its own, and the seams other modules rely on.

## Pieces

| Piece | Where |
|---|---|
| Agent ops `hardening.jails.*`, `hardening.updates.*`, `hardening.sysctl.*`, `hardening.firewall.*` | `agent/src/ops/hardening.js` (op names carry no digits, so Fail2ban's family is `jails`) |
| Allowed roots | `agent/src/lib.js`: `/etc/fail2ban`, `/etc/apt/apt.conf.d`, `/etc/dnf/automatic.conf`, `/etc/sysctl.d` |
| Service `ctx.hardening` | `server/src/services/hardening.js`, created by the Security Center module (`routes/categories/security-center.js`) after `ctx.security` |
| Table `hardening_state`, settings defaults | migration `038_hardening.sql` |
| Capability `fail2ban` | registered by the Security Center module (`fail2ban-client`); installable through the stack catalogue component `fail2ban` (`POST /api/system/capabilities/fail2ban/install`) |
| Job `hardening.reconcile` | registered by the Security Center module; queued at boot when the firewall baseline was left on |
| Routes (root only) | `GET /api/security/hardening`, `GET /hardening/firewall/plan`, `POST /hardening/:item/apply`, `POST /hardening/:item/revert`, `POST /hardening/fail2ban/unban`, `POST /hardening/fail2ban/install` |
| UI | Security Advisor › **Hardening** card (`client/src/pages/security/Hardening.jsx`, anchor `#hardening`) |
| Advisor | one finding per item, `hardening.<item>`, fix link `/security-center/security-advisor#hardening` |

Items: `fail2ban`, `auto-updates`, `ssh`, `sysctl`, `firewall`. Every item answers one of
`applied`, `not_applied`, `not_applicable` (the subsystem is absent or another tool owns the setting)
or `unknown` (the probe failed; the reason is in `detail.reason`), carries `desired` (what the
operator last asked for), `detail` (the live host state) and, after an apply, `previous` (what Revert
restores). The host is changed first; the SQLite row only changes once the agent accepted the change.

## The rules every write follows

- argv only (`exec(bin, argv[])`), every argument from a zod schema with enums for jail names,
  sysctl keys and the firewall policy; ports are integers 1–65535 or `{ from, to }` ranges.
- Paths go through `ctx.assertAllowedPath()`; a file the panel replaces for the first time is kept
  beside it as `<file>.whm-orig`, and every written file carries `Managed by WHM panel (Hardening)`.
- Validate before activate: `fail2ban-client -t`, `apt-config dump`, the kernel's own answer to
  `sysctl -e -p FILE`, a status read-back of the firewall rules. On failure the previous files (and,
  for sysctl, the previous kernel values; for the firewall, the previous policy and chain state) are
  put back and the op fails with `config_invalid` (HTTP 422).
- `destructive: true` on everything that tears down or releases (`*.revert`, `jails.unban`,
  `firewall.apply` because it changes the input policy).
- An audit row per apply, revert and unban (`security.hardening.apply|revert`,
  `security.hardening.fail2ban.unban`) with the parameters, never free text.

## 1. Fail2ban (`fail2ban`)

**Changes.** `/etc/fail2ban/filter.d/whm-panel.conf` (the panel login filter) and
`/etc/fail2ban/jail.d/whm.local` with a `[DEFAULT]` (bantime, findtime, maxretry from the settings
`security.hardening.fail2ban.*`, defaults 3600 / 600 / 5; `ignoreip` = loopback plus the address the
apply came from) and one section per catalogue jail — `sshd` (aggressive mode), `exim`, `dovecot`,
`pure-ftpd`, `proftpd`, `apache-auth`, `apache-badbots`, `whm-panel` — `enabled = true` for the daemons
this host runs (from the capability snapshot; the panel jail is always on), `enabled = false` for the
rest, so a previous selection never lingers. The jail then runs `fail2ban-client -t`,
`systemctl enable --now fail2ban`, `fail2ban-client reload` (falling back to a restart) and checks
`fail2ban-client ping`.

The panel jail watches the journal (`backend = systemd`, `journalmatch = SYSLOG_IDENTIFIER=whm-panel`,
the identifier of `deploy/whm-panel.service`) for pino-http's request line of a failed login:

```
"req":{"id":"…","method":"POST","url":"/api/auth/login","ip":"<HOST>"},"res":{"statusCode":401}
```

`/api/auth/login` and `/api/auth/2fa` answered 401 or 403 count; 200 and 429 (the panel's own rate
limit) do not. `req.ip` is the socket address, so behind a reverse proxy the proxy would be banned:
the jail is for the panel's own listener. A development run (`npm run dev`) logs to the terminal,
not the journal, so the panel jail sees nothing there.

**Status.** installed (`fail2ban-client`), configured (both files managed), running (`ping`), the
jails from `fail2ban-client status` and, per jail, `fail2ban-client status <jail>` → currently/total
banned and the banned addresses, which the card lists with an **Unban** button
(`fail2ban-client set <jail> unbanip <ip>`).

**Revert.** Both files are removed (or the originals restored) and fail2ban reloaded. The service is
left running and enabled: other jails may be in use.

**Never done automatically.** Installing the package (the card offers the stack install, a job the
operator starts), stopping or disabling the service, editing any other jail file, banning or unbanning.

## 2. Automatic security updates (`auto-updates`)

**Debian / Ubuntu.** `/etc/apt/apt.conf.d/20auto-upgrades` (`Update-Package-Lists "1"`,
`Unattended-Upgrade "1"`, `AutocleanInterval "7"`) and `/etc/apt/apt.conf.d/52whm-unattended-upgrades`:
`#clear` of `Allowed-Origins` and `Origins-Pattern`, then the security origins only (Debian
`-security`/`Debian-Security`, Ubuntu `-security`, Ubuntu Pro ESM security pockets),
`Automatic-Reboot "false"`, unused kernels and dependencies removed, `MinimalSteps`. The task named
`50unattended-upgrades`; that file is the package's conffile, which dpkg would prompt about on every
upgrade once edited, and a later file with `#clear` is apt's own way to replace a list, so the
policy lives in `52whm-…` and `50…` is left alone. Validation: `apt-config dump` must parse and show
`APT::Periodic::Unattended-Upgrade "1"`. Activation: `systemctl enable --now apt-daily.timer
apt-daily-upgrade.timer`.

**RHEL family.** dnf-automatic reads only `/etc/dnf/automatic.conf`, so the three keys
(`upgrade_type = security`, `apply_updates = yes`, `download_updates = yes`) are rewritten in place
under `[commands]`, every other line kept; the file is re-parsed after rendering (there is no
`dnf-automatic -t`), then `systemctl enable --now dnf-automatic.timer` (or
`dnf-automatic-install.timer` where that is the one that exists).

**Package missing.** Apply queues `software.pkg.install` for `unattended-upgrades` /
`dnf-automatic` (HTTP 202 with the job) and the card applies the item once the job finishes.

**Status.** package installed, files managed, `apt-config dump` shows the schedule on (Debian) or the
three keys hold (RHEL), timer enabled.

**Revert.** Debian: the `52whm-…` file is removed and the original `20auto-upgrades` restored; where
there was none, the file is rewritten with `Unattended-Upgrade "0"` (apt's default is off anyway).
RHEL: the original `automatic.conf` is restored and the timer disabled.

**Never done automatically.** Non-security updates, reboots, kernel upgrades beyond what the security
pocket ships, distribution upgrades.

## 3. SSH daemon (`ssh`)

**Changes.** Through the existing `sec.sshd.set` op (drop-in `/etc/ssh/sshd_config.d/00-whm.conf`,
`sshd -t`, reload, listener check, shadowing report): `PermitRootLogin prohibit-password`,
`MaxAuthTries 4`, `LoginGraceTime 30`, `X11Forwarding no`. A stricter value already in effect is kept
(`PermitRootLogin no` stays `no`, a lower MaxAuthTries/LoginGraceTime stays). **Refused (422) while
root has no authorized key** (`sec.ssh_keys.list`): the card links to *Manage root's SSH Keys*
instead of showing Apply.

**Status.** From `sshd -T`: PermitRootLogin ∈ {prohibit-password, without-password, no,
forced-commands-only}, MaxAuthTries ≤ 4, LoginGraceTime ≤ 30 s, X11Forwarding no. The previous
managed values of the four keys are stored (`previous_json`) at the first apply.

**Revert.** The four keys are set back to the stored managed values (or removed from the drop-in
when they were not managed before), again through `sec.sshd.set`.

**Never done automatically.** Disabling password authentication (that is the *SSH Password
Authorization Tweak* page, with its own key check), changing the port, generating or authorizing keys.

## 4. Kernel network hardening (`sysctl`)

**Changes.** `/etc/sysctl.d/90-whm-hardening.conf`:

```
net.ipv4.conf.{all,default}.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.{all,default}.accept_redirects = 0
net.ipv4.conf.{all,default}.secure_redirects = 0
net.ipv6.conf.{all,default}.accept_redirects = 0
net.ipv4.conf.{all,default}.send_redirects = 0
net.ipv4.conf.{all,default}.accept_source_route = 0
net.ipv6.conf.{all,default}.accept_source_route = 0
net.ipv4.conf.{all,default}.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
```

The current value of every key that exists under `/proc/sys` is read first; the file is written and
loaded with `sysctl -e -p FILE` (`-e` skips keys this kernel lacks, e.g. IPv6 off). A non-zero exit
removes the file and writes the previous values back with `sysctl -w key=value`. Hosts without any
of the keys (containers) answer `unsupported`.

**Status.** File managed and every available key at its value. A later `sysctl.d` file (`99-*`) or
`/etc/sysctl.conf` wins at boot: the status then lists the keys that differ.

**Revert.** The file is removed and the values recorded at apply time are written back (only
catalogue keys, only digits — the schema rejects anything else).

**Never done automatically.** Anything outside this list (no `kernel.*`, no `fs.*`, no IPv6 disable).
`rp_filter = 1` is strict reverse-path filtering: a multi-homed host with asymmetric routes needs
loose mode (2), which means reverting this item and setting it by hand.

## 5. Firewall baseline (`firewall`)

**Changes.** With the panel's backend (`iptables` when present, else `nft`, the same choice as
cPHulk's `WHM_BLOCK`):

- iptables (and ip6tables when present): chain `WHM_BASELINE` with `-i lo ACCEPT`,
  `conntrack ESTABLISHED,RELATED ACCEPT`, `conntrack INVALID DROP`, ICMP/ICMPv6 ACCEPT, one ACCEPT per
  allowed TCP/UDP port or range; the jump is **appended** to INPUT (`-A`, never `-I`) so `WHM_BLOCK`
  and fail2ban's chains keep precedence; then `-P INPUT DROP`, last.
- nft: `inet whm baseline` is created with `policy accept`, filled with the same rules (port sets
  `{ 22, 80, 49152-65534 }`), then its policy is switched to `drop`. cPHulk's `block` chain runs at
  priority −10, before it.

The allow list (`GET /hardening/firewall/plan`): panel ports (`config.port`/`tlsPort`), every port
sshd listens on (`ss -ltnpH`, falling back to `sshd -T`'s Port), 80/443, 25/465/587 when Exim is
installed, 110/143/993/995 when Dovecot is, 53 tcp+udp when BIND is, 21 and the FTP passive range
(`ctx.web.ftp.settings()`, default 49152–65534) when an FTP server is, 7443 when `whm-hub.service`
exists, plus the operator's `extraTcp`/`extraUdp`. The card shows this table before anything happens.

**Guards (three, independent).** The UI requires the operator to type the SSH port they are
connected on and tick "I can still reach SSH on port N". The API refuses (422) without
`confirmSshPort`, with a port sshd is not listening on, when firewalld or ufw is active (they own
the policy; the item reads `not_applicable`), or when any sshd port would not be in the list. The
agent refuses (`refused`) once more when a declared or a live sshd port is missing from the TCP list
or firewalld/ufw is active — so a direct op call cannot lock the operator out either.

**Persistence.** Like `WHM_BLOCK`, the baseline is kernel state and gone after a reboot. The row's
`desired` flag makes the Security Center module queue `hardening.reconcile` at boot, which re-plans
(fresh sshd ports, stored extras) and re-applies; it never runs the UI confirmation but keeps the
agent guard. While the kernel has lost it the status reads *not applied* with the reason.

**Revert.** The input policy is set back to what it was before the first apply (recorded as
`previous.policy`, ACCEPT unless it was DROP already), the jump removed, the chain flushed and
deleted (nft: the chain deleted), and `desired` cleared so boot leaves it alone.

**Never done automatically.** Applying without the confirmation (the reconcile job only re-applies
what was confirmed once), touching OUTPUT/FORWARD, firewalld or ufw rule sets, cPHulk's chains,
closing a port sshd listens on.

## Security Advisor

`advisor.scan()` has a `hardening` probe: `ctx.hardening.findings()` returns one finding per item —
`not_applied` → the item's grade (fail2ban, auto-updates, ssh, firewall: warning; sysctl: info) with
the live reason as detail and the fix link to the card; `applied` → ok; `not_applicable` → skipped;
`unknown` → info. Critical findings become security alerts as before; none of these is critical.

## Tests

- `agent/test/hardening-ops.test.js` (35): schema rejections (jails, times, ports, addresses, sysctl
  keys/values, policy), destructive flags, the rendered jail/filter/apt/dnf/sysctl files, the panel
  failregex against real pino lines, parsers (`fail2ban-client status`, `ss -p`, `iptables -S`,
  `nft -j`), and argv order with a mocked `exec`: `fail2ban-client -t` before enable/reload and
  rollback on failure; apt/dnf validation, timers and revert with originals; sysctl load, kernel
  refusal rollback and revert; iptables rules → appended hook → DROP last, teardown order, nft
  accept-then-drop, both SSH guards and the firewalld guard.
- `server/test/hardening.test.js` (25): root-only, status aggregation (not_applicable, unknown,
  installable), fail2ban jail selection/settings/audit/unban/revert, updates apply + 202 install,
  SSH key refusal, never-loosen and revert of previous values, sysctl previous values, the firewall
  plan, confirmation guard, extras, previous policy, firewalld/ufw refusal, reconcile at boot, and
  the advisor findings.
- `client/test/hardening.test.jsx` (7): the card with every status, banned addresses + Unban, Install
  vs Apply vs the keys link, Apply… for the firewall, the confirmation modal with the port table and
  the disabled apply button, the install prompt, and the Security Advisor page carrying the card.
