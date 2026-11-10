# DCABSM command line

This is the full command surface of DCABSM V1: every command, its flags, what it asks and what it prints. Capitalised terms, such as Instance, Release and Regroup, are defined in [GLOSSARY.md](../GLOSSARY.md). How each command works underneath is in the [V1 specification](spec/v1.md), and this page links to its sections.

The example output on this page is illustrative. Versions, times and sizes vary.

## Here be dragons

Read this before you upgrade, roll back or restore an Instance. Your mileage may vary.

- **Restore is DCABSM's own approach.** Actual doesn't document or support restoring a server from its files. DCABSM's restore is built and tested by DCABSM, not by Actual.
- **The server is the source of truth.** After a restore, every device resyncs from the server through Actual's reset dialog, "Syncing has been reset on this cloud file". Click **Revert**. Never click "upload this file to be the latest version": it undoes the restore.
- **Unsynced changes on a device can be lost.** Before a planned upgrade, rollback or restore, open Actual on every device and let it sync.
- **Device behaviour was tested in Chromium.** Firefox and Safari on a Mac get one pass before V1 ships. Mobile browsers are untested.

These warnings come back in the output of `instance upgrade`, `instance rollback` and `instance restore`, and in their sections below.

## Commands at a glance

Commands are `dcabsm <noun> <verb> [args] [flags]`. There are no flat verbs and no short aliases.

| Noun | Command | What it does |
|---|---|---|
| `host` | `host setup [--release <v>] [--backup-dir <path>] [--yes]` | Prepare the Host and install the first Release |
| | `host doctor [--fix] [--yes]` | Check the Host and every Instance, and optionally fix what DCABSM owns |
| | `host check-updates` | Look for a newer Actual Release, Node patch and DCABSM version |
| | `host settings` | Show the Host settings |
| | `host set <key> <value>` | Change one Host setting |
| `instance` | `instance list` | The overview: every Instance, then the last update check |
| | `instance show <name>` | One Instance in detail |
| | `instance create <name> --hostname <host> (--cert <f> --key <f> \| --self-signed) [--release <v>] [--yes]` | Create an Instance |
| | `instance remove <name> [--confirm <name>]` | Take a final Backup, then delete the Instance |
| | `instance start\|stop\|restart <names>\|--all` | Start, stop or restart Instances |
| | `instance logs <name> [-f] [--since <time>]` | Read an Instance's journal |
| | `instance set-hostname <name> <host> [--cert <f> [--key <f>] \| --self-signed]` | Move an Instance to a new hostname |
| | `instance reset-password <name>` | Reset the server password in Actual's own tool |
| | `instance settings <name>` | Show an Instance's settings |
| | `instance set <name> <key> <value> [--yes]` | Change one Instance setting |
| | `instance unset <name> <key> [--yes]` | Return one Instance setting to Actual's default |
| | `instance upgrade <names>\|--all [--to <v>] [--yes]` | Move Instances to a newer Release |
| | `instance rollback <name> [--restore-data] [--confirm <name>]` | Go back one step to the previous Release |
| | `instance restore <name> [<archive>] [--confirm <name>]` | Restore an Instance from a Backup |
| | `instance restore --from <archive>` | Rebuild an Instance from an archive on a new Host |
| | `instance clone <source> <new> --hostname <host> [cert options] [--yes]` | Copy an Instance under a new name and hostname |
| | `instance clone --from <archive> <new> --hostname <host> [cert options]` | Make a new Instance from an archive |
| `backup` | `backup create <names>\|--all` | Take a `manual` Backup |
| | `backup list [<names>]` | List archives |
| | `backup prune [<names>\|--all] [--dry-run]` | Apply Retention by hand |
| | `backup schedule <name> on\|off` | Switch scheduled Backups on or off for one Instance |
| `cert` | `cert test [<names>\|--all]` | Check what each hostname serves |
| | `cert update <names>\|--all --cert <f> [--key <f>]` | Swap in a new certificate |
| `release` | `release list` | Installed Releases, their Node runtime and the Instances on them |
| | `release install <v>` | Install a Release |
| | `release prune [--yes]` | Remove Releases no Instance uses, and unused Node runtimes |
| | `release update-node [--yes]` | Install a Node patch and restart the Instances on it |
| `self` | `self update [--to <ver>] [--yes]` | Update DCABSM itself |
| | `self version` | Print the installed version. `dcabsm --version` does the same |

`dcabsm help` prints this list. `host nightly` also exists: the `dcabsm-nightly` service runs it, and `help` doesn't list it.

Cert options are `--cert <f> --key <f>` or `--self-signed`.

## Rules every command follows

### Root

Every command needs root, usually through `sudo`. Anything else stops at once:

```
error: dcabsm must run as root.
  Try: sudo dcabsm instance list
```

`help`, `dcabsm --version` and `self version` change nothing, so they run without root and before setup.

Every command except `host setup`, `self update` and those three refuses until the Host is set up:

```
error: This Host is not set up yet.
  Run: sudo dcabsm host setup
```

If the Host was last changed by a newer DCABSM, every command refuses and names the version needed (spec 11.4):

```
error: This Host was last changed by a newer DCABSM (layout 4). This is DCABSM 1.2.0 (layout 3).
  Install DCABSM 2.0.0 or newer: sudo dcabsm self update
```

The version named is the one that last migrated the layout (`layoutSince` in `dcabsm.json`). If the Host is on a lower layout than this version expects, every command refuses until `sudo dcabsm self update` has migrated it:

```
error: This Host is on layout 3, and DCABSM 1.2.0 expects layout 4. Its stored state needs migrating first.
  Run: sudo dcabsm self update
```

On an Unsupported Host (spec 10.4), every command except `host doctor` starts with a banner, and `host doctor` shows the mark as a failure:

```
UNSUPPORTED HOST: a safety check was overridden on 2026-10-02. You are on your own.
```

If the Host later runs an OS that is not supported, only `host setup` refuses. Every other command warns on stderr and logs the line, then carries on (spec 10.3):

```
! Fedora Linux 41 on amd64 is not a supported Host. Backup and restore still work, but you are on your own.
```

### Choosing Instances

Commands that take `<names>|--all` take one or more Instance names, or `--all` for every Instance. With neither, they refuse:

```
error: Name one or more Instances, or use --all.
  Example: sudo dcabsm instance upgrade family test
```

An unknown name refuses with a pointer to `instance list`. Commands that work on several Instances do them one at a time, so only one is down at once, and end with a summary.

### Confirming

- **Destructive commands** ask you to type the Instance name: `instance remove`, `instance restore` and `instance rollback --restore-data`. Scripts pass `--confirm <name>`.

  ```
  Type the Instance name family to confirm:
  ```

  A name that doesn't match cancels with "The name did not match. Nothing changed."

- **Other prompts** are `[y/N]`, with no as the default, and `--yes` answers them. "Cancelled. Nothing changed." exits 1.
- The restart prompt after `instance set` and `instance unset` is `[Y/n]`, with yes as the default.
- **With no terminal** and no flag, a prompt refuses before anything changes:

  ```
  error: No terminal to confirm on.
    Re-run with --yes to proceed without asking.
  ```

### Output

Steps print one line each:

| Mark | Meaning |
|---|---|
| `✓` | done, or the check passed |
| `✗` | failed |
| `!` | a warning |
| `·` | information |

Errors print one line, then an indented hint that gives the full next command:

```
error: test has an unfinished Release change (upgrade, 26.10.0 → 26.11.0).
  Only rollback can run now: sudo dcabsm instance rollback test
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | failure, or cancelled at a prompt |
| `2` | usage error, or a refusal before anything changed |

`host doctor` has its own codes: `0` pass or notes only, `1` warnings, `2` any failure.

### Network

Ordinary commands never use the network. Only `host check-updates`, Release and Node installs, `instance upgrade` and `self update` do.

### Locking

Commands that change state take a Host-wide lock, so two can't change things at once. `host doctor` without `--fix` takes no lock and is safe to run at any time.

If another command holds the lock, an interactive command fails at once with exit 1, naming the holder (its pid and command line), and does not wait:

```
error: Another dcabsm command is running (pid 4121: dcabsm instance upgrade --all).
  Wait for it to finish, then run again: sudo dcabsm backup create --all
```

For `host doctor --fix` the message adds "host doctor --fix did not run: this is the lock, not a problem on the Host.", because exit 1 also means warnings there.

A lock left behind by a process that has died is taken over. Only the Nightly run waits for the lock, for up to 10 minutes (spec 8.2).

### Logging

Every changing command logs one line to journald when it ends, with the command and its outcome (`ok`, `failed` or `cancelled`), under the `dcabsm` tag:

```
dcabsm: backup create: ok
```

Read them with `journalctl -t dcabsm`. A failure to log never fails the command. The Nightly run's summary is the journal of its service: `journalctl -u dcabsm-nightly`.

## Installing DCABSM

`install.sh` is not a `dcabsm` command, but it is the first thing a System Admin runs. Read it first, then run `sudo bash install.sh`. The README lists the same steps by hand.

```
DCABSM installer: 1.2.0 for Debian 13, amd64
Signing key fingerprint:
  XXXX XXXX XXXX XXXX XXXX  XXXX XXXX XXXX XXXX XXXX
Compare it with the README or https://keys.openpgp.org before going on.
Does it match? [y/N] y
  ✓ Downloaded dcabsm-1.2.0-linux-amd64.tar.gz, SHA256SUMS, SHA256SUMS.sig
  ✓ Signature good (gpgv)
  ✓ Checksum good
  ✓ Extracted to /opt/dcabsm/1.2.0/
  ✓ /usr/local/bin/dcabsm → /opt/dcabsm/1.2.0/bin/dcabsm

Next: sudo dcabsm host setup
```

`--yes` skips the fingerprint question. It keeps the key as `/opt/dcabsm/<ver>/share/dcabsm-signing-key.gpg`: the installed key that `self update` trusts. It never runs setup and never touches apt. If DCABSM is already installed, it points to `sudo dcabsm self update` and stops. See spec 11.3.

## host

### host setup

`host setup [--release <v>] [--backup-dir <path>] [--yes]`

Prepares the Host: installs Nginx, `openssl` and `xz-utils`, creates `/etc/dcabsm` and `/srv/dcabsm`, writes the units and Nginx files, and installs the first Release with its Node runtime. It runs every check that can refuse before it changes anything, then shows the plan and asks once.

```
Setup checks (nothing changes yet)
  ✓ Debian 13 (trixie), amd64, VM
  ✓ Not the Proxmox VE host, not a container
  ✓ Nginx: apt's candidate is Debian's 1.26.3
  ✓ Nothing else listening on 80 or 443

Plan
  · Install nginx, openssl and xz-utils with apt
  · Create /etc/dcabsm and /srv/dcabsm
  · Backups in /srv/dcabsm/backups
  · Write dcabsm@.service, dcabsm-nightly.timer (03:30), Nginx conf.d files
  · Install Actual 26.11.1 with its Node runtime
Go ahead? [y/N] y
  ✓ apt: nginx, openssl, xz-utils
  ✓ Created /etc/dcabsm/dcabsm.json (layout 3) and /srv/dcabsm
  ✓ Units written; dcabsm-nightly.timer enabled
  ✓ Nginx: nginx -t passed, started, enabled
  ✓ Installed Node runtime 24.11.2 (checked with gpgv against nodejs.org's keys)
  ✓ Installed Release 26.11.1 with npm --ignore-scripts, tied to Node 24.11.2
  ✓ Native modules load: bcrypt, argon2, better-sqlite3

Next: sudo dcabsm instance create <name> --hostname <host> --cert <file> --key <file>
```

- `--release <v>` installs that Release instead of the latest stable one.
- `--backup-dir <path>` moves the backup directory. It can only be set on the first run. A re-run with a different path is refused, because moving Backups is a Manual System Admin task.
- Setup is safe to re-run. It does only what's missing, and a re-run after a failure carries on. On a Host that is already set up, it prints "Every check passes; nothing to do."
- **Refusals** (spec 10.3) name what was found and exit 2 with nothing changed: an unsupported OS or architecture, the Proxmox VE host, a container, nginx.org's Nginx package, anything else on port 80 or 443, an Nginx config that fails `nginx -t`, any TurnKey appliance other than Core or Node.js, and TurnKey before its first-boot setup has finished (`RUN_FIRSTBOOT` in `/etc/default/inithooks` is not `false`, or `turnkey-init-fence` is still running).
- **Edited files.** If a file DCABSM owns was edited by hand, setup shows a diff and asks `replace (old copy saved to /etc/dcabsm/replaced/) or keep? [r/k]`. Keep leaves a warning that `host doctor` keeps raising. With no terminal, `--yes` replaces, and without it setup stops before any change and lists the files.
- **On TurnKey** (spec 10.7), the plan adds one line, and the same "Go ahead?" covers it:

  ```
  · Disable TurnKey's nodejs Nginx site, pm2-node.service and confconsole's Let's Encrypt renewal job (nothing is deleted)
  ```

  The line names only the pieces that are in place. On Core with no renewal job there is no line and nothing extra to confirm.

### host doctor

`host doctor [--fix] [--yes]`

Checks the Host and every Instance against the list in spec 10.6. Without `--fix` it is read-only and takes no lock.

```
Read-only. Takes no lock.
  ✓ Debian 13 (trixie), amd64, VM
  ✓ Nginx 1.26.3 from Debian, running and enabled, nginx -t passes
  ✓ Owned files match
  ✓ Ownership and modes
  ✓ Releases 26.10.0, 26.11.0 load native modules
  · Node 24.11.2 is available (runtimes on 24.11.1)
  ! Leftover .installing-26.11.1 folder  (host doctor --fix)
  ! Backups share a disk with Instance data (/dev/vda1)
  ! Firewall active without 443 allowed: manual System Admin task, e.g. ufw allow 443/tcp
  ✓ family: config, vhost, ownership, port, certificate 212 days
  · test: self-signed certificate, not trusted by system CAs
  ✓ Scheduled backups newer than 48 hours for every Instance

exit 1: 0 pass or notes, 1 warnings, 2 failures
```

- `--fix` takes the lock and asks for each problem it can fix: `fix / skip / all? [f/s/a]`. Files get a diff first, and old copies are saved to `/etc/dcabsm/replaced/`. `--yes` fixes everything. With no terminal and no `--yes`, it refuses.
- `--fix` fixes only what DCABSM owns. The one exception is the three TurnKey pieces in spec 10.7, which it disables again after asking if they come back.
- When `--fix` regenerates an Instance's `config.json`, it asks separately whether to restart that Instance. Otherwise it reports "restart needed".
- Some problems are a Manual System Admin task, such as opening the firewall. Doctor says so and never changes firewall rules.
- On TurnKey, the OS line names the appliance, for example "TurnKey Node.js 19.0 (Debian 13), amd64, VM". Doctor warns for each disabled piece that is back, and notes `webmin-nginx` if installed.

### host check-updates

`host check-updates`

The only command that uses the network to look for updates.

```
  ✓ Actual 26.11.1 is available (newest installed: 26.11.0)
  ✓ DCABSM 1.3.0 is available (this is 1.2.0): sudo dcabsm self update
  ✓ Node 24.11.2 patch for Node 24 (family, test run 24.11.1): sudo dcabsm release update-node
  · instance list shows this result until the next check. Ordinary commands never use the network.
```

If npm can't be reached, it warns and still checks the rest.

### host settings and host set

`host settings` shows the Host settings. `host set <key> <value>` changes one.

```
  backup-dir           /srv/dcabsm/backups  (set at setup)
  nightly-time         03:30
  keep-scheduled       14
  keep-pre-upgrade     5
  keep-pre-restore     5
  keep-pre-clone       5
```

| Key | Value |
|---|---|
| `nightly-time` | `HH:MM`, Host local time. Changing it regenerates the timer |
| `keep-scheduled`, `keep-pre-upgrade`, `keep-pre-restore`, `keep-pre-clone` | Retention count, never below 1 (spec 8.3) |

`backup-dir` is shown but can only be set by `host setup --backup-dir`. Any other key gets "Unknown setting".

## instance

### instance list

`instance list`

The overview. There is no separate status command.

```
INSTANCE  STATE    RELEASE  HOSTNAME                 PORT   CERT              LAST SCHEDULED
family    active   26.11.0  budget.example.org       15127  212d              11-07 03:30 UTC
test      stopped  26.10.0  test.budget.example.org  15128  300d self-signed  11-07 03:31 UTC

DCABSM 1.2.0 · Nightly run 03:30 · last check 2026-11-07 12:00 UTC
→ Actual 26.11.1 is available: sudo dcabsm instance upgrade <names>|--all
→ DCABSM 1.3.0 is available: sudo dcabsm self update
→ Node 24.11.2 patch for Node 24: sudo dcabsm release update-node
```

- An Instance with an unfinished Release change shows `CHANGING` as its state. `start` and `restart` refuse it and point to `instance upgrade` or `instance rollback`; `stop` still works.
- LAST SCHEDULED shows `off` when scheduled Backups are off, and `none` when there are none. It warns when an Instance with scheduled Backups on has none newer than 48 hours.
- The Unsupported Host mark is always shown.
- With no Instances, it points to `instance create`.

### instance show

`instance show <name>`

```
family  active
  Hostname           https://budget.example.org
  Release            26.11.0 (Node 24.11.1)
  Port               127.0.0.1:15127
  Account            dcabsm-family
  Certificate        212 days left, covers budget.example.org, *.budget.example.org
  Scheduled backups  on, newest 20261107T033000Z-scheduled-26.11.0.tar.gz
  Backups            1 pre-upgrade, 1 manual, 2 scheduled
  Login              password
  Settings           upload-sync-limit-mb 100
```

It lists the Instance settings the System Admin set, and marks any the current Release doesn't use as "not used by <release>". An unfinished Release change shows as a warning with the `instance rollback` command.

### instance create

`instance create <name> --hostname <host> (--cert <f> --key <f> | --self-signed) [--release <v>] [--yes]`

```
Create shop
  ✓ Account dcabsm-shop
  ✓ Instance on Release 26.11.0, port 15129
  ✓ Certificate for shop.example.org, 89 days left
  ✓ Nginx: nginx -t passed, reloaded
  ✓ Started and verified: /health UP, /info 26.11.0 (11s)

Set the server password now? [Y/n]
If you paste a password, press Enter separately.
Handing the terminal to Actual's reset tool as dcabsm-shop. DCABSM never sees the password.
Enter a new password:
Confirm the new password:
Password changed successfully.
  ✓ Anyone signed in has to sign in again with the new password.
Scheduled backups are on.
```

- **Name.** A lowercase letter first, then lowercase letters, digits or hyphens, 24 characters at most. It can never change. Cloning and then removing the original acts as a rename.
- **Hostname.** Required. It must be a lowercase DNS name, with no wildcard and no trailing dot, and is refused if another Instance or another Nginx site already uses it.
- **First password.** On a terminal, after Verification, `create` offers to set the server password through Actual's own tool, the same as `instance reset-password`. With no terminal or with `--yes` it doesn't ask. A new Instance is never OpenID-only, so there is no OpenID check. Declining, or a reset that fails, doesn't fail `create`: it exits as it would without the offer and prints the warning below instead of the password steps.
- **First visit.** Until the password is set, the first person to open the hostname sets it. Create the Instance before DNS points at the Host, or set the password at once. When the password isn't set, `create` ends with:

  ```
  Open https://shop.example.org now to set the server password: until it is set, whoever opens it first sets it.
  ```

- **Certificate.** Every Instance must have one. With neither `--cert`/`--key` nor `--self-signed`, it asks on a terminal and refuses otherwise:

  ```
  No certificate given for shop.example.org. Every Instance must have one.
    [1] self-signed now  [2] cancel (re-run with --cert/--key):
  ```

  A certificate that is expired, doesn't cover the hostname or doesn't match the key is refused with nothing changed (spec 5.6), and so is a passphrase-protected key. A chain the system CAs don't trust only prints a warning. `--cert` and `--key` go together. The full chain and the key are copied into the Instance's `nginx/`, root-only.
- **Self-signed** prints:

  ```
  Self-signed: browsers warn on each device, and may warn again later. Actual works after you proceed,
  but offline use and installing as an app need a certificate the device trusts. Bring one later: sudo dcabsm cert update <name> --cert <file> --key <file>
  ```

- **Release.** `--release <v>` picks one, installing it if missing. The default is the newest installed Release.
- **A failed start.** If `nginx -t` fails, everything made is removed. If the start or Verification fails after the Nginx reload, the Instance stays and the command exits 1 with the next steps: `sudo dcabsm instance logs <name>`, then fix it and `sudo dcabsm instance start <name>`, or `sudo dcabsm instance remove <name>`. If the Release's Node is missing on disk, the message says so.
- There are no flags for Instance settings. Use `instance set` afterwards.

### instance remove

`instance remove <name> [--confirm <name>]`

```
Remove test
  · Takes a final backup, then deletes the Instance, its account dcabsm-test and its Nginx site.
  · Its backups stay in /srv/dcabsm/backups/test.removed-<time>/ until you delete them by hand.
Type the Instance name test to confirm: test
  ✓ Free space: 41 GB, backup needs ~9 MB
  ✓ Backup final: 20261107T141500Z-final-26.10.0.tar.gz (9 MB)
  ✓ Nginx site removed, nginx -t passed, reloaded
  ✓ Deleted Instance and account dcabsm-test
  ✓ Backups moved to /srv/dcabsm/backups/test.removed-20261107T141500Z/
```

An Instance that has never started has no data, so remove takes no final Backup and says so. Deleting `.removed-` folders is a Manual System Admin task. `host doctor` lists them with their size. A new Instance with the same name starts with no Backups.

### instance start, stop and restart

`instance start|stop|restart <names>|--all`

```
  ✓ Started and verified: /health UP, /info 26.11.0 (9s)
  ✓ Stopped test. It stays stopped after a reboot, and its hostname shows Nginx's 502 until started.
```

Start and restart verify each Instance (spec 6.2). `stop` also stops the Instance starting at boot, and `start` turns that back on, so a stopped Instance stays stopped after a reboot. There is no maintenance page. All three refuse for an Instance with an unfinished Release change.

### instance logs

`instance logs <name> [-f] [--since <time>]`

Reads the Instance's journal with `journalctl -u dcabsm@<name>`. Without `--since` it shows the last 50 lines. `-f` follows. `--since` takes anything `journalctl` accepts, such as `"15 min ago"`.

### instance set-hostname

`instance set-hostname <name> <host> [--cert <f> [--key <f>] | --self-signed]`

Moves an Instance to a new hostname. If the current certificate covers the new hostname, no certificate options are needed. Otherwise give a new one, or answer the same certificate prompt as `instance create`. Actual doesn't restart.

```
  ✓ Certificate covers kids.example.org
  ✓ Nginx: nginx -t passed, reloaded
  ✓ Served certificate for kids.example.org confirmed
  · Devices must use https://kids.example.org now. Budgets on the old hostname stay in those browsers until removed.
  ! OpenID: if this Instance uses it, update the hostname in Actual's OpenID settings and the provider's redirect URL.
```

Actual's OpenID settings still name the old hostname, so OpenID login fails until they and the provider are updated. Password login keeps working.

### instance reset-password

`instance reset-password <name>`

Hands the terminal to Actual's own reset tool, run as the Instance account, so DCABSM never sees the password.

```
Handing the terminal to Actual's reset tool as dcabsm-family. DCABSM never sees the password.
If you paste a password, press Enter separately.
Enter a new password:
Confirm the new password:
Password changed successfully.
```

It refuses:

- with no terminal: "Password reset needs a terminal: you type the new password straight into Actual."
- on an Instance that has never started (no `server-files/account.sqlite` yet), which has no password yet, with a pointer to its hostname
- on an OpenID-only Instance, where Actual's `auth` table has an `openid` row and no `password` row: "Reset passwords with your OpenID provider."

DCABSM runs `runuser -u dcabsm-<name> -- env ... actual-server --config <path> --reset-password` from the Instance's Release with the terminal attached. On a started Instance that has no password yet, the same tool sets the first one. When it succeeds, DCABSM adds one line: anyone signed in has to sign in again.

### instance settings, set and unset

`instance settings <name>`, `instance set <name> <key> <value> [--yes]`, `instance unset <name> <key> [--yes]`

An Instance exposes a fixed list of Actual's settings (spec 4.11). Everything else keeps the Release's own default.

| Key | Actual key | Actual default | Value | From |
|---|---|---|---|---|
| `upload-sync-limit-mb` | `upload.fileSizeSyncLimitMB` | 20 | whole number 1–1024 | 26.10.0 |
| `upload-encrypted-sync-limit-mb` | `upload.syncEncryptedFileSizeLimitMB` | 50 | whole number 1–1024 | 26.10.0 |
| `upload-limit-mb` | `upload.fileSizeLimitMB` | 20 | whole number 1–1024 | 26.10.0 |
| `openid-enforce` | `enforceOpenId` | false | `true` or `false` | 26.10.0 |
| `openid-user-creation` | `userCreationMode` | manual | `manual` or `login` | 26.10.0 |
| `simplefin-allowed-networks` | `simplefinAllowedNetworks` | empty | comma-separated IPs and CIDRs | 26.11.0 |

`instance settings` shows every key, whether its value is Actual's default or was set, and whether the current Release uses it:

```
KEY                             ACTUAL KEY                          VALUE    SOURCE   USED
upload-sync-limit-mb            upload.fileSizeSyncLimitMB          100      set      yes
upload-encrypted-sync-limit-mb  upload.syncEncryptedFileSizeLimitMB 50       default  yes
upload-limit-mb                 upload.fileSizeLimitMB              20       default  yes
openid-enforce                  enforceOpenId                       false    default  yes
openid-user-creation            userCreationMode                    manual   default  yes
simplefin-allowed-networks      simplefinAllowedNetworks            (empty)  default  not used by 26.10.0
```

`instance set` checks the value, writes it and regenerates `config.json`. `instance unset` returns a key to Actual's default, whatever the Release. Actual reads its config only at startup, so after either one:

```
  ✓ upload-sync-limit-mb = 100 for family
  ✓ Nginx: client_max_body_size 101m, nginx -t passed, reloaded
Restart family now? [Y/n]
```

- `--yes` restarts without asking. With no terminal and no `--yes`, it reports "restart needed".
- A stopped Instance isn't started. The output says the change applies on the next start.
- After an upload-limit change, Nginx reloads at once with the new body size limit. If `nginx -t` fails, the old vhost goes back.
- A key the current Release doesn't know is refused: "needs 26.11.0, family runs 26.10.0".
- An unknown key gets "unknown setting". Keys DCABSM sets itself, and `loginMethod`, `https.*`, `webRoot`, `env`, `mode` and `projectRoot`, can never be set.
- Both refuse while the Instance has an unfinished Release change.
- After a rollback or restore to an older Release, a setting it doesn't know is kept in the Instance record but not used, and the output says "not used by <release>". A later Upgrade uses it again with no action needed.

#### Setting up OpenID

OpenID is set up in Actual's own web UI, not through DCABSM ([ADR-0005](adr/0005-openid-belongs-to-actual.md)). Actual stores it, client secret included, in the Instance's `server-files/`, so Backups and Clones carry it.

1. With your OpenID provider, register a client for the Instance with the redirect URL `https://<hostname>`, the Instance's own hostname.
2. Log in to the Instance as its server owner, and switch the server to OpenID in Actual's settings, giving the provider's details. Actual's own documentation has the exact steps for your Release.
3. If you want, set `openid-enforce` and `openid-user-creation` with `instance set`.

Actual's header login is never available behind DCABSM: the vhost strips the header and `config.json` rules it out (spec 4.4).

### instance upgrade

`instance upgrade <names>|--all [--to <v>] [--yes]`

Moves Instances to a newer Release, one at a time. Each one stops for its Pre-upgrade backup and the switch, in one outage. **Read [Here be dragons](#here-be-dragons) first.**

```
Upgrade to Actual 26.11.1
  family     26.11.0 → 26.11.1
  test       26.10.0 → 26.11.1  (stopped; returns to stopped)
  Release notes: https://actualbudget.org/docs/releases
  Each Instance stops for its Pre-upgrade backup and the switch, one at a time.
Continue? [y/N] y
  ✓ Installed Release 26.11.1 with npm --ignore-scripts, tied to Node 24.11.2
  ✓ Native modules load: bcrypt, argon2, better-sqlite3

family
  ✓ Free space: 41 GB, backup needs ~118 MB
  ✓ Stopped family
  ✓ Backup pre-upgrade: 20261107T140300Z-pre-upgrade-26.11.0.tar.gz (118 MB)
  ✓ Switched to 26.11.1, config.json regenerated
  ✓ Started and verified: /health UP, /info 26.11.1 (12s)

test
  ...

Summary
INSTANCE  RESULT
family    upgraded
test      upgraded

On every device
  · Open tabs show Actual's banner "A new version of Actual is available". Click Update now, or reload twice.
```

- **Target.** The default is the latest stable Release on npm. `--to <v>` picks another. If npm can't be reached, it fails and lists the installed Releases to use with `--to`.
- **Never backwards.** An older target is refused, with a pointer to `instance rollback`. An Instance already on the target is skipped.
- **Failure.** If verification fails, DCABSM rolls that Instance back automatically, from its Pre-upgrade backup, with nothing lost. It stops there and leaves the rest untouched:

  ```
    ✗ Not verified within 120s: unit active, but /health never answered (expected /info 26.11.1)
    ! Rolling back automatically
    ✓ Restored data from 20261107T140300Z-pre-upgrade-26.11.0.tar.gz
    ✓ Switched back to 26.11.0
    ✓ Started and verified: /health UP, /info 26.11.0 (10s)

  Summary
  INSTANCE  RESULT
  family    failed, back on 26.11.0
  test      not started
  error: Upgrade of family failed and was rolled back. Its data is as it was before the upgrade.
    Why: sudo dcabsm instance logs family --since "15 min ago"
  ```

  If the automatic rollback also fails, the Instance stays stopped, the Backup is kept and named, and the command exits 1.
- **Not enough space** for the Backup fails before the Instance stops. DCABSM never deletes Backups to make room.
- An Instance that has never started has no data, so it just switches Release, with no Backup.

### instance rollback

`instance rollback <name> [--restore-data] [--confirm <name>]`

Goes one step back, to the Release recorded in the Instance's newest Pre-upgrade backup. **Read [Here be dragons](#here-be-dragons) first.**

By default it keeps the current data:

```
Roll back family: 26.11.1 → 26.11.0, keeping current data
Continue? [y/N] y
  ✓ Stopped family
  ✓ Switched to 26.11.0
  ✓ Started and verified: /health UP, /info 26.11.0 (9s)

On every device
  · Open tabs show Actual's banner "A new version of Actual is available". Click Update now, or reload twice.
```

An older Actual server refuses data from a newer server migration, so this can fail. DCABSM then returns to the newer Release, with the data unchanged:

```
  ✗ 26.11.0 would not start on the current data (a newer server migration ran since)
  ✓ Returned to 26.11.1
  ✓ Started and verified: /health UP, /info 26.11.1 (9s)
error: family is still on 26.11.1, data unchanged.
  To go back by restoring the Pre-upgrade backup from 2026-11-07 14:03 UTC: sudo dcabsm instance rollback family --restore-data
```

`--restore-data` replaces all data with the Pre-upgrade backup, after taking a `pre-restore` Backup, and regroups. It is the only path that loses data, so it asks for the name:

```
Roll back family: 26.11.1 → 26.11.0, restoring data
  ! Replaces all data with the Pre-upgrade backup from 2026-11-07 14:03 UTC. Changes since then are lost.
  · Open Actual on every device and let it sync before you go on.
Type the Instance name family to confirm: family
  ...
  ✓ Restored data from 20261107T140300Z-pre-upgrade-26.11.0.tar.gz
  ✓ Regrouped 2 Budget files
```

It ends with the same device advice as [instance restore](#instance-restore).

- If the newest Pre-upgrade backup is already on the current Release, there is nothing to roll back, and it points to `instance restore`.
- A Release removed by `release prune` is reinstalled from npm.
- **After an interruption**, such as a reboot during an Upgrade or restore, `instance rollback <name>` is the only command that runs for that Instance, and it finishes the job safely (spec 6.6).
- Any Instance setting the older Release doesn't know is listed as "not used by <release>".

<a id="restore"></a>
### instance restore

`instance restore <name> [<archive>] [--confirm <name>]`

Restores an Instance from a Backup: the newest archive in its backup directory, or any archive given by path. **Read [Here be dragons](#here-be-dragons) first.**

```
Restore family from 20261107T033000Z-scheduled-26.11.0.tar.gz
  Backup taken 2026-11-07 03:30 UTC on Release 26.11.0
  Keeps hostname budget.example.org, port 15127 and the current certificate.
  ! Everything changed since 2026-11-07 03:30 UTC is lost, on the server and on every device.
  ! Here be dragons: Actual doesn't document restoring a server from its files. This is DCABSM's own approach.
  · Open Actual on every device and let it sync before you go on.
Type the Instance name family to confirm: family
  ✓ Free space: 41 GB, backup needs ~118 MB
  ✓ Stopped family
  ✓ Backup pre-restore: 20261107T141000Z-pre-restore-26.11.0.tar.gz (118 MB)
  ✓ Replaced data, server-files and user-files; ownership set for dcabsm-family
  ✓ Regrouped 2 Budget files
  ✓ Started and verified: /health UP, /info 26.11.0 (10s)

On every device
  · Actual shows "Syncing has been reset on this cloud file". Click Revert.
  · Never click "upload this file to be the latest version": it undoes the restore.
  · Unsynced changes on a device are lost. A budget created after the backup comes back if a device registers it.
  · Here be dragons: tested in Chromium only. Firefox, Safari and mobile are untested. See docs/cli.md#restore.
```

- It keeps the current hostname, port, Instance settings and certificate, so a restore can't bring back an expired certificate or an old hostname.
- If the archive is on another Release, the Instance moves to it, installing it if missing. Afterwards it suggests `instance upgrade` to move forward again.
- If verification fails, DCABSM restores the `pre-restore` Backup automatically.
- A stopped Instance returns to stopped.
- A path given where the name belongs is refused, with a pointer to `--from`.

### instance restore --from

`instance restore --from <archive>`

Rebuilds an Instance from an archive when no Instance of that name exists, for example on a new Host after a disaster. The name comes from the archive, with no override.

```
Rebuild Instance family from 20261107T033000Z-scheduled-26.11.0.tar.gz
  ✓ Archive manifest: format 1, Instance family, hostname budget.example.org, Release 26.11.0
  ✓ Account dcabsm-family; ownership set from its name
  ✓ Port 15127 is free, kept
  ✓ Hostname budget.example.org is not used by another site
  ✓ Certificate from the archive: 212 days left
  ✓ Nginx: nginx -t passed, reloaded
  ✓ Regrouped 2 Budget files
  ✓ Started and verified: /health UP, /info 26.11.0 (12s)
  · Point DNS for budget.example.org at this Host.
```

It ends with the same device advice as `instance restore`. If an Instance of that name already exists:

```
error: The archive is of Instance family, and an Instance named family already exists here.
  Restore into it: sudo dcabsm instance restore family /mnt/usb/20261107T033000Z-scheduled-26.11.0.tar.gz
  Or make a new Instance from the archive: sudo dcabsm instance clone --from /mnt/usb/20261107T033000Z-scheduled-26.11.0.tar.gz <new-name> --hostname <host>
```

It keeps the archive's Instance record, hostname, settings and certificate, and takes a new port if the archived one is in use. An expired certificate from the archive is kept, with a warning pointing to `cert update`, so a rebuild is never blocked. An archive written by a newer DCABSM is refused, with a pointer to `self update`.

### instance clone

`instance clone <source> <new> --hostname <host> [cert options] [--yes]`
`instance clone --from <archive> <new> --hostname <host> [cert options]`

Makes a new Instance from a copy of another, with its own name, account, port and hostname, on the source's Release and with its Instance settings. From a source Instance, it first takes a `pre-clone` Backup, which stops the source for a few seconds. From an archive, it takes no Backup.

```
Clone family → family-test
  · family stops for a few seconds while it is backed up.
Continue? [y/N] y
  ✓ Free space: 41 GB, backup needs ~118 MB
  ✓ Stopped family
  ✓ Backup pre-clone: 20261107T142000Z-pre-clone-26.11.0.tar.gz (118 MB)
  ✓ Started family
  ✓ Account dcabsm-family-test, port 15129, Release 26.11.0
  ✓ Certificate: copied from family (it covers try.budget.example.org)
  ✓ Regrouped 2 Budget files
  ✓ Nginx: nginx -t passed, reloaded
  ✓ Started and verified: /health UP, /info 26.11.0 (11s)

  ! Logins are copied: everyone who can log in to family can log in to family-test, with the same passwords.
```

- `--hostname` is required. A clone always gets its own hostname, checked as in `instance create`.
- The source's certificate is copied only if it covers the new hostname, such as a wildcard. Otherwise give `--cert`/`--key` or `--self-signed`, or answer the certificate prompt.
- Everything inside Actual is copied, including users, passwords and OpenID settings. The OpenID settings name the source's hostname, so if the source uses OpenID, update them in the clone and add its redirect URL at the provider.

## backup

Archives are unencrypted `.tar.gz` files, as sensitive as root on the Host. They hold every budget, every login, the Instance's private key, and the OpenID client secret and bank-sync credentials that Actual stores. Every Backup stops the Instance for a few seconds (spec 7.3).

### backup create

`backup create <names>|--all`

```
Back up family, test
  · Each running Instance stops for a few seconds while it is archived, one at a time.
  ✓ Free space: 41 GB, backup needs ~118 MB
  ✓ Stopped family
  ✓ Backup manual: 20261107T141200Z-manual-26.11.0.tar.gz (118 MB)
  ✓ Started family
  ✓ Free space: 41 GB, backup needs ~9 MB
  ✓ Backup manual: 20261107T141300Z-manual-26.10.0.tar.gz (9 MB)

Summary
INSTANCE  RESULT  ARCHIVE
family    ok      20261107T141200Z-manual-26.11.0.tar.gz
test      ok      20261107T141300Z-manual-26.10.0.tar.gz
  · Archives are unencrypted and as sensitive as root on this Host. They live in /srv/dcabsm/backups/<name>/.
```

A stopped Instance is archived without being started; so is one in `failed`. An Instance in `activating`, `reloading` or `deactivating` counts as running. An Instance that has never started is skipped (no data) and the exit stays 0. The Summary ends with a count line, for example `1 backed up, 1 skipped (no data), 0 failed`. It carries on past a failure and exits 1 if any Backup failed. Not enough space fails before the Instance stops:

```
  ✗ Not enough space in /srv/dcabsm/backups for a backup of family (needs ~118 MB, 80 MB free). family was not stopped.
```

`manual` Backups are never pruned. Deleting them is a Manual System Admin task.

### backup list

`backup list [<names>]`

```
family
ARCHIVE                                     KIND         RELEASE  SIZE
20261020T101500Z-pre-upgrade-26.10.0.tar.gz  pre-upgrade  26.10.0  112 MB
20261101T090000Z-manual-26.11.0.tar.gz       manual       26.11.0  115 MB
20261107T033000Z-scheduled-26.11.0.tar.gz    scheduled    26.11.0  118 MB
test.removed-20261107T141500Z/  2 archives, kept until you delete them
```

Archives are named `<UTC time>-<kind>-<release>.tar.gz`. The kinds are `manual`, `scheduled`, `pre-upgrade`, `pre-restore`, `pre-clone` and `final` (spec 7.2).

### backup prune

`backup prune [<names>|--all] [--dry-run]`

Applies Retention by hand, with the same counts as the Nightly run (spec 8.3). With no names it covers every Instance. `--dry-run` lists what would be deleted.

```
  · Would delete family/20261001T033000Z-scheduled-26.10.0.tar.gz
```

With nothing to delete: "Nothing to prune. Keeping newest 14 scheduled, 5 pre-upgrade, 5 pre-restore, 5 pre-clone; manual backups are never pruned."

### backup schedule

`backup schedule <name> on|off`

```
  ✓ Scheduled backups off for test. Retention still prunes its old backups.
```

## cert

### cert test

`cert test [<names>|--all]`

Connects to `127.0.0.1:443` with each hostname and checks what is served. With no names it covers every Instance.

```
family  budget.example.org
  ✓ Served certificate matches budget.example.org and the file on disk
  ✓ 212 days left
  ✓ Hostname resolves to this Host
test  test.budget.example.org
  ✓ Served certificate matches test.budget.example.org and the file on disk
  ✓ 300 days left
  · Not trusted by system CAs (self-signed)
  ✓ Hostname resolves to this Host
```

Expired, mismatched or unreachable is a failure and exits 1. Under 30 days left, or a hostname that doesn't resolve, is a warning. Untrusted is a note.

### cert update

`cert update <names>|--all --cert <f> [--key <f>]`

Swaps in a new certificate. Without `--key`, the current key is checked against the new certificate. Actual doesn't restart. A certbot deploy hook can run this command.

```
Update certificate for family, family-test
  ✓ family: valid, covers budget.example.org, matches the current key
  ✓ family-test: valid, covers try.budget.example.org, matches the current key
  ✓ Swapped files, nginx -t passed, reloaded
  ✓ family: now serving the new certificate (confirmed in 1s)
  ✓ family-test: now serving the new certificate (confirmed in 1s)
  · Actual was not restarted.
```

Every named Instance is checked before anything changes. An expired or not-yet-valid certificate, a hostname it doesn't cover, a key that doesn't match or a passphrase-protected key stops the command with nothing changed for any Instance. An untrusted chain only warns. If the new certificate isn't served within 5 seconds, the old files go back.

## release

### release list

`release list`

```
RELEASE  NODE     USED BY
26.10.0  24.11.1  test
26.11.0  24.11.1  family
```

### release install

`release install <v>`

Installs one stable Release with its Node runtime and checks its native modules load. A version older than 26.10.0 is refused: "26.9.0 is older than 26.10.0, the oldest Release DCABSM supports."

### release prune

`release prune [--yes]`

```
  · Release 26.10.0
  · Node runtime 22.20.0
Remove these unused Releases and any Node runtime no Release uses? [y/N] y
  ✓ Removed Release 26.10.0
  ✓ Removed Node runtime 22.20.0
  · A rollback to a removed Release reinstalls it from npm, without its old lockfile.
```

It keeps a Release that an unfinished Release change still names, as the from or the to Release. A Node runtime goes when no remaining Release uses it, including an older patch of a major that a kept Release uses. DCABSM's own Node is never touched. Without a terminal it needs `--yes`. With nothing to remove: "No unused Releases."

### release update-node

`release update-node [--yes]`

Installs a newer patch of a Node major that installed Releases use, then restarts the running Instances on it, one at a time. It skips an Instance with an unfinished Release change and names it.

```
Node 24.11.1 → 24.11.2
  Restarts, one at a time: family, test (stopped, stays stopped)
Continue? [y/N] y
  ✓ Installed Node 24.11.2, checked with gpgv
  ✓ node/24 → 24.11.2
  ✓ Restarted family
  ✓ Started and verified: /health UP, /info 26.11.0 (9s)
```

## self

### self update

`self update [--to <ver>] [--yes]`

Updates DCABSM itself. It never changes an Instance's Release and never restarts an Instance.

```
Self-update DCABSM 1.2.0 → 1.3.0
  · Never changes an Instance's Release or restarts an Instance.
Continue? [y/N] y
  ✓ Downloaded dcabsm-1.3.0-linux-amd64.tar.gz
  ✓ Signature good, checked with gpgv against the installed key
  ✓ Extracted to /opt/dcabsm/1.3.0/
  ✓ /usr/local/bin/dcabsm → /opt/dcabsm/1.3.0/
  ✓ Owned files refreshed: dcabsm@.service, dcabsm-nightly.timer, 2 vhost.conf (nginx -t passed, reloaded)

  ! Restart needed: family (its generated config.json changed). Run: sudo dcabsm instance restart family
  ✓ Removed /opt/dcabsm/1.1.0/ (keeps current and previous)
```

It needs no `--yes` on a terminal; scripts pass `--yes`. Without `--to` it takes the latest stable version from GitHub.

- It checks `SHA256SUMS.sig` with `gpgv` only against the key already installed (`/opt/dcabsm/<current>/share/dcabsm-signing-key.gpg`), never one from the download, then checks the tarball against `SHA256SUMS`. A bad signature or checksum stops with nothing changed:

  ```
  error: The signature on SHA256SUMS does not verify against the installed key.
    Nothing was changed. DCABSM only trusts the key it already has. gpgv: ...
  ```

- A new signing key can ship in the tarball as `share/dcabsm-signing-key.gpg`. It was vouched for by the old key, so the new version keeps it and later updates check against it. A tarball without one inherits the installed key.
- Each version knows the layout version it expects (`self version` shows it). When the new version expects a higher layout than the Host stores, the update migrates forward, after copying `/etc/dcabsm` aside: "Copied /etc/dcabsm aside, migrated layout 3 → 4". The migration runs with the new version's own code, under the lock, before the symlink moves. If it fails, or any later step fails (the symlink switch, the refresh), `/etc/dcabsm` is put back, the new version is removed and the symlink stays on the old one:

  ```
  error: Migrating layout 3 → 4 failed: <reason>
    /etc/dcabsm was put back as it was. The symlink stays on 1.2.0.
  ```

- Until a migration has run, every other command refuses (see "Rules every command follows"). Only `self update`, `self version` and `--version` run. Migrations only go forward: a version whose layout is lower than the Host's is refused.
- `--to <ver>` moves to any stable version, older or newer, only on the same layout:

  ```
  error: DCABSM 2.0.0 uses layout 4; this Host is on layout 3.
    Moving to a new layout is only done to the latest version: sudo dcabsm self update
  ```

- Without `--to`, a latest version equal to the running one reports `DCABSM <ver> is already installed.` (exit 0). A latest version older than the running one is refused (exit 2) as "ahead of the latest", with the `--to` command that would go down. Going down needs an explicit `--to`.
- `--to <running version>` with a lower stored layout migrates in place: it copies `/etc/dcabsm` aside, runs the migration and the refresh, and puts the copy back if either fails. Nothing is downloaded.
- After the switch the new version rewrites the owned files and every Instance's `config.json` and `vhost.conf` (nginx -t first; the old files go back if it fails). An Instance whose `config.json` changed and that is running is listed as "Restart needed". An owned file edited by hand is kept, with a warning to review it with `host doctor --fix`.
- It keeps the new and the previous version in `/opt/dcabsm/` and removes the rest.
- Two hidden commands, `self migrate` and `self refresh`, are the steps the new version runs for the update. They refuse to run outside it.

### self version

`self version`, or `dcabsm --version`:

```
DCABSM 1.2.0 (layout 3)
```

## Tab completion

bash completion is installed with DCABSM. `dcabsm <Tab>` and `sudo dcabsm <Tab>` complete nouns, verbs, flags, Instance names, Release versions, and `on` or `off` after `backup schedule <name>`. Backup archive names don't complete, because the backup directory is root-only. `host doctor` notes a Host without the `bash-completion` package.
