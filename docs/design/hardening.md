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
  beside it as `<file>.whm-orig` (`<file>.whm-orig.disabled` under `apt.conf.d`, the one suffix apt
  skips without a notice), and every written file carries `Managed by WHM panel (Hardening)`.
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
`security.hardening.fail2ban.*`, defaults 3600 / 600 / 5; `ignoreip` = loopback only; `banaction` /
`banaction_allports` = `nftables-multiport` / `nftables-allports` when the panel's firewall backend is
nft, `iptables-multiport` / `iptables-allports` otherwise — fail2ban's stock action and
fail2ban-firewalld's `00-firewalld.conf` both fail where that tool is not in charge, and `jail.d/*.local`
is read after every `*.conf`) and one section per catalogue jail — `sshd` (aggressive mode), `exim`,
`dovecot`, `pure-ftpd`, `proftpd`, `apache-auth`, `apache-badbots`, `whm-panel` — `enabled = true` for
the daemons this host runs (from the capability snapshot; the panel jail is always on), `enabled =
false` for the rest, so a previous selection never lingers. Only the `whm-panel` jail carries an extra
`ignoreip`: the body's `ignoreIps` (validated as IP/CIDR) or, by default, the address the apply came
from (`::ffff:` IPv4-mapped form stripped) — it keeps the operator from banning themselves out of the
panel and exempts them from nothing else; the card lists it (*Never banned from the panel*). The jail
then runs `fail2ban-client -t`, `systemctl enable --now fail2ban`, `fail2ban-client reload` (falling
back to a restart) and checks `fail2ban-client ping`.

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
(`fail2ban-client set <jail> unbanip <ip>`), and `ignoreIps` (the panel jail's exemptions).

**Revert.** Both files are removed (or the originals restored) and fail2ban reloaded. The service is
left running and enabled: other jails may be in use.

**Never done automatically.** Installing the package (the card offers the stack install, a job the
operator starts), stopping or disabling the service, editing any other jail file, banning or unbanning.

## 2. Automatic security updates (`auto-updates`)

**Debian / Ubuntu.** `/etc/apt/apt.conf.d/20auto-upgrades` (`Update-Package-Lists "1"`,
`Unattended-Upgrade "1"`, `AutocleanInterval "7"`) and `/etc/apt/apt.conf.d/52whm-unattended-upgrades`:
`#clear` of `Allowed-Origins` and `Origins-Pattern`, then the security origins only (Debian
`-security`/`Debian-Security`, Ubuntu `-security`, Ubuntu Pro ESM security pockets matched by origin +
archive only — esm.ubuntu.com carries no `Ubuntu Pro` label),
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
(`PermitRootLogin no` and `forced-commands-only` stay, a lower MaxAuthTries/LoginGraceTime stays).
**Refused (422) while root could not log in with a key** (`sshKeyLoginBlocked`): no authorized key
(`sec.ssh_keys.list`), effective `PubkeyAuthentication no`, an `AuthenticationMethods` list without a
chain that still works once passwords are refused (`publickey` without `password` /
`keyboard-interactive`), or an `AuthorizedKeysFile` that does not read `/root/.ssh/authorized_keys`
(`%h`/`%u` resolved). The same reason is `detail.blocked` in the status: the card hides Apply, *Apply N
recommended* skips the item, and it links to *Manage root's SSH Keys* (no key) or *SSH Password
Authorization Tweak* (sshd setting).

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
  `conntrack ESTABLISHED,RELATED ACCEPT`, `conntrack INVALID DROP`, ICMP/ICMPv6 ACCEPT, for ip6tables
  the DHCPv6 client reply (`-s fe80::/10 -d fe80::/10 udp 547 → 546`, which conntrack never marks
  ESTABLISHED), one ACCEPT per allowed TCP/UDP port or range; the jump is **appended** to INPUT (`-A`,
  never `-I`) so `WHM_BLOCK` and fail2ban's chains keep precedence; then `-P INPUT DROP`, last.
- nft: `inet whm baseline` is created with `policy accept`, filled with the same rules (port sets
  `{ 22, 80, 49152-65534 }`, the DHCPv6 rule as `ip6 saddr fe80::/10 ip6 daddr fe80::/10 udp sport
  547 udp dport 546 accept`), then its policy is switched to `drop`. cPHulk's `block` chain runs at
  priority −10, before it.

The allow list (`GET /hardening/firewall/plan`): panel ports (`config.port`/`tlsPort`), every port
SSH is reachable on — the listeners of **root's real sshd** from `ss -ltnpeH` (a row with `uid:` is a
non-root socket; each `pid=` must have `/proc/<pid>/status` Uid 0 and `/proc/<pid>/exe` = the
installed sshd, so a tenant's program calling itself `sshd` opens nothing) merged with the
`ListenStream` ports of an active `ssh.socket`/`sshd.socket` (`systemctl show -p Listen`, the listener
Ubuntu holds in pid 1 until the first connection; `sshSource` then names the socket unit), falling
back to `sshd -T`'s Port only when neither answers — 80/443, 25/465/587 when Exim is installed,
110/143/993/995 when Dovecot is, 53 tcp+udp when BIND or PowerDNS is, 21 and the FTP passive range
(`ctx.web.ftp.settings()`, default 49152–65534) when an FTP server is, the ports `whm-hub.service`'s
process listens on away from loopback (`MainPID` matched against the `ss` rows; 7443 only when nothing
can be read), plus the operator's `extraTcp`/`extraUdp` (both fields in the confirmation modal). The
built-in DHCPv6 rule is listed in the plan (`builtin`) but never sent as a port. The card shows this
table before anything happens.

**Guards (three, independent).** The UI requires the operator to type the SSH port they are
connected on and tick "I can still reach SSH on port N". The API refuses (422) without
`confirmSshPort`, with a port sshd is not listening on, when firewalld or ufw is active (they own
the policy; the item reads `not_applicable`), or when any sshd port would not be in the list. The
agent refuses (`refused`) once more when a declared or a live sshd port (same root-sshd / socket-unit
rule) is missing from the TCP list or firewalld/ufw is active — so a direct op call cannot lock the
operator out either. A failed apply (a rejected rule, a read-back that is not *applied*) tears the
chain down and sets each family's INPUT policy back to what was captured from `-S INPUT` before the
change (ACCEPT only when nothing could be captured), so a host that already ran `-P INPUT DROP` is
not left open.

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

- `agent/test/hardening-ops.test.js` (45): schema rejections (jails, times, ports, addresses, sysctl
  keys/values, policy), destructive flags, the rendered jail/filter/apt/dnf/sysctl files (panel-only
  `ignoreip`, `banaction` per backend, ESM origins without a label), the panel failregex against real
  pino lines, parsers (`fail2ban-client status`, `ss -ltnpeH` rows, the root-sshd pid check against a
  fake `/proc`, `systemctl show -p Listen`, `iptables -S`, `nft -j` with the DHCPv6 rule left out), and
  argv order with a mocked `exec`: `fail2ban-client -t` before enable/reload and rollback on failure;
  apt/dnf validation, timers, revert with originals and an apt.conf.d that holds only names apt reads
  or skips silently; sysctl load, kernel refusal rollback and revert; iptables rules → DHCPv6 (v6
  only) → appended hook → DROP last, teardown to the captured policy per family, nft
  accept-then-drop, both SSH guards, a tenant listener named sshd ignored, the socket-activated port
  honoured, the hub port from its live listener, and the firewalld guard.
- `server/test/hardening.test.js` (31): root-only, status aggregation (not_applicable, unknown,
  installable), fail2ban jail selection/settings/audit/unban/revert, the panel-jail exemption
  (`::ffff:` stripped, explicit `ignoreIps` validated), updates apply + 202 install, SSH refusals (no
  key, PubkeyAuthentication off, AuthenticationMethods, AuthorizedKeysFile) mirrored as `blocked`,
  never-loosen including forced-commands-only, revert of previous values, sysctl previous values, the
  firewall plan (builtin DHCPv6 row, PowerDNS, hub port from the live listener, socket-unit source),
  confirmation guard, extras, previous policy, firewalld/ufw refusal, reconcile at boot, and the
  advisor findings.
- `client/test/hardening.test.jsx` (9): the card with every status, banned addresses + Unban, the
  panel-jail exemption line, Install vs Apply vs the keys link vs the password-tweak link, Apply… for
  the firewall, the confirmation modal with the port table (built-in rows, extra TCP/UDP fields, the
  socket-unit source) and the disabled apply button, the install prompt, and the Security Advisor page
  carrying the card.
