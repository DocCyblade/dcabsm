# Development

DCABSM is TypeScript on Node 24, bundled by esbuild into one JS file. It has no runtime dependencies. The exact Node patch is in `.node-version`, and CI and the bundle target use it.

| Command          | What it does                                  |
| ---------------- | --------------------------------------------- |
| `npm ci`         | Install the tools                             |
| `npm run check`  | Typecheck, lint, format check and unit tests  |
| `npm test`       | Unit tests only (Vitest)                      |
| `npm run build`  | Bundle to `dist/dcabsm.js`                    |
| `npm run format` | Format `src`, `test` and `scripts` with oxfmt |

## Layout

- `src/table.ts`: the one noun → verb table. It drives `help` and routing. To build a command, set its `run`.
- `src/cli.ts`: routing, the root and setup guards, and the lock-and-log wrapper for changing commands.
- `src/context.ts`: the `Context` every command gets. The command runner and the fetcher are the only two seams (spec 13.1); it also carries the architecture, environment and clock.
- `src/real.ts`: the production command runner, fetcher and terminal. `src/main.ts` wires them in.
- `src/errors.ts`, `src/help.ts`, `src/version.ts`: exit codes and error text, the `help` text, and the version and layout number.
- `src/completion.ts`: generates the bash completion script from the table. `scripts/build.mjs` writes it to `dist/share/bash-completion/completions/dcabsm`. The real-bash test needs bash 5 and `bash-completion`, and skips without them (macOS ships bash 3.2).
- `scripts/build.mjs`: the esbuild bundle; it injects the version from `package.json`.
- `scripts/package.ts`, `scripts/tarball.ts`: `npm run package` (after `npm run build`) builds `dist/release/dcabsm-<ver>-linux-{amd64,arm64}.tar.gz` and `SHA256SUMS`. It fetches the Node in `.node-version`, checks it with `gpgv` against `scripts/node-release-keys.asc` (Node's active release keys; the fingerprints are in `scripts/node-release-keys.list`), and ships those keys as `share/node-release-keys.gpg`. Nothing is signed there; CI never signs.
- `install.sh`: the first-install script (spec 11.3). Its top block holds the only release-time placeholders (GitHub owner, key fingerprint, key keyring). `test/install.test.ts` fills them in and runs it under bash on a temporary root, with `curl`, `gpgv`, `uname` and `id` stubbed.
- `src/host/`: Host-level code. `os.ts` holds the supported OS table (spec 1.4), `checks.ts` the refusals (10.3), `setup.ts` `host setup`, `config.ts` `dcabsm.json`, and `notices.ts` the banner and OS warning every other command prints. `checks.ts` holds the one list of Host checks (`hostChecks`) that setup and `host doctor` share: each has a test, a severity and an optional fix. `health.ts` and `tree.ts` hold the doctor-only checks, and `doctor.ts` runs the list, asks about fixes and sets the exit code. `settings.ts` is `host settings` and `host set`, and `nightly.ts` is the Nightly run (`host nightly`, which takes the lock per Instance with `acquireLockWaiting`).
- `src/host/system.ts`: what the package manager and service manager say (`isInstalled`, Nginx state, `nginxTestFailure`, `systemctl`), shared by setup, doctor and `instance create`.
- `src/host/updates.ts`: `host check-updates` (the one command that uses the network for updates), the stored result and the `instance list` footer built from it.
- `src/self/`: `update.ts` is `self update` (download, `gpgv` against the installed key, extract, migrate, switch, refresh, prune); `layout.ts` is the layout gate `cli.ts` runs before every command; `migrations.ts` holds the `MIGRATIONS` table (add the step for layout n there when `LAYOUT` rises) and the hidden `self migrate`; `refresh.ts` is the hidden `self refresh`. The old version downloads and verifies, but the new version's own binary runs `migrate` and `refresh`, so each uses the new code.
- `src/instance/`: the `instance` commands. `create.ts` makes one, `list.ts` lists and shows, `remove.ts` removes one, `controls.ts` is start, stop, restart and logs, `settings.ts` is `settings`, `set` and `unset` with `setting-table.ts` as the one table of settings (spec 4.11), `record.ts` reads `instance.json`, names, the `.changing-release` check and `runningRelease`, `files.ts` renders and writes `config.json` and the vhost, `verify.ts` is Verification (spec 6.2) and `startVerified`, the start every command shares, `resolve-names.ts` resolves `<names>|--all`, `upgrade.ts` is `instance upgrade` with `upgrade-plan.ts` (target, preflight) and `upgrade-one.ts` (one Instance, with the automatic rollback), `switch.ts` repoints `release` and regenerates `config.json`, and `start-gate.ts` lifts the `.changing-release` rule for one start, `restore-data.ts` replaces the data directories from an archive and does not Regroup (a failed Upgrade rolls back with it, since nothing was lost). `restore.ts` is `instance restore` in place: it takes the `pre-restore` Backup, calls `restore-data.ts`, then `regroup.ts` (spec 7.5: new group ids for the Budget files so devices re-sync), and rolls back automatically if Verification fails. `device-advice.ts` holds the advice shown before and after a restore (spec 7.6). `set-hostname.ts` is `instance set-hostname` (spec 4.9), which puts its files back if Nginx or the served certificate check fails. `record.ts` also holds the `.changing-release` marker read and write and `writeRecord`; `files.ts` also holds `writeVhost`.
- `src/cert.ts`: reads and checks a bring-your-own certificate and key (spec 5.5).
- `src/certs/`: `provide.ts` holds what `instance create` and `instance set-hostname` share: the hostname-in-use check and choosing, writing and reporting an Instance's certificate. `update.ts` is `cert update`, `test.ts` is `cert test`, and `probe.ts` holds what they share with `instance list`: resolving `<names>|--all`, reading what Nginx serves on `127.0.0.1:443`, and the CERT column. The served chain and DNS answers come through the fetcher seam.
- `src/backup/`: `archive.ts` holds archive names, the backup directory and manifest reading, `create.ts` is `backup create` and `takeBackup`, and `list.ts` is `backup list`. `schedule.ts` is `backup schedule` (turns the scheduled Backups of one Instance on or off in its record). `retention.ts` holds the Retention counts and the pruning rules (spec 8.3), shared with the Nightly run, and `prune.ts` is `backup prune`.
- `src/columns.ts`: the one column formatter the list and summary tables share.
- `src/args.ts`, `src/fsutil.ts`, `src/fetchutil.ts`, `src/output.ts`: flag parsing, file and directory helpers (`readTextOr` reads a file or gives undefined), the checked fetch, and the step marks.
- `src/paths.ts`: every path hangs off one root. `DCABSM_ROOT` moves it; the default is `/`. In the shipped completion script it is a test seam only: it lets the real-bash tests run under a temporary root.
- `src/prompt.ts`, `src/lock.ts`, `src/log.ts`: the helpers every command shares. `lock.ts` has `acquireLock` (fails at once) and `acquireLockWaiting` (retries for up to 10 minutes; the Nightly run uses it).
- `src/rollback.ts`: `snapshotFiles` reads the files a change can touch and `putBack` writes them back, for `cert update` and `instance set-hostname`.
- `test/container/`: the container layer (spec 13.2, 13.3), CI only in practice; see below.
- `test/helpers.ts`: a `Context` on a temporary root with a faked runner and fetcher. Tests assert on the files left behind.

## Container layer

`test/container/run.sh <debian-13|ubuntu-24.04|ubuntu-26.04> [--live]` runs the real `dcabsm` as root in a privileged systemd container (spec 13.2). It needs Linux, Docker, passwordless `sudo` (the mirror listens on port 443) and the tarballs from `npm run build && npm run package`. CI runs it for all three OSes on `ubuntu-24.04` and `ubuntu-24.04-arm` (job `containers` in `ci.yml`), and `live.yml` runs `--live` every Monday.

- `Dockerfile`: one image per OS, systemd as PID 1 and the few tools a fresh Host has. DCABSM and Nginx are not in it.
- `pins.json`, `pins.ts`: the pinned Releases. `pins.ts` fetches nodejs.org's signed files for the Node in `.node-version`, each Release's registry document and an npm cache holding every pinned Release, into `.cache/container-pins/<arch>`. CI caches that directory, keyed on `pins.json` and `.node-version`.
- `mirror.ts`: a static HTTPS server that stands in for `registry.npmjs.org`, `nodejs.org`, `raw.githubusercontent.com`, `api.github.com` and `github.com`. The container's `--add-host` points those names at it, and a throwaway CA makes `dcabsm` and `curl` trust it. npm runs offline against the cache.
- `run.sh`: builds the image, makes the throwaway CA and signing key, fills in `install.sh`'s placeholders, stages the CI-built tarball and a copy of it that calls itself the next patch version (for `self update`), starts the mirror, boots the container and runs the journey.
- `journey.sh`: runs inside the container with `DCABSM_ALLOW_CONTAINER=1`. It installs with `install.sh`, checks that setup refuses without the override, sets up the Host, expects `host doctor` to show the Unsupported Host mark, creates two Instances (one self-signed, one with `--cert`) on two Releases, checks HTTPS through the real Nginx, and exercises `release install` and `prune`, `stop` and `start`, `backup create`, `instance set`, the `reset-password` refusal and `self update`.

`scripts/remote-test.sh [<os>...] [--live] [--no-reset]` runs the same journey on a private Proxmox test VM instead of in CI: it rolls the VM back to its clean snapshot, copies the working tree over, builds the tarballs there and runs `run.sh` for each OS (all three by default). It reads the VM, its SSH alias and its API token from `~/.config/test-vms.env`, outside the repo; `TVM=<NAME>` picks another VM.

`--live` skips the mirror and the signing key. The tarball is unpacked where `install.sh` would put it, and setup installs the newest Release and Node from the live sources. Container runs are not evidence of support (spec 13.2).

## Before the first release

The `release guard` job fails a `v*` tag while any of this is undone:

1. Set the GitHub owner: `GITHUB_OWNER` in `install.sh`.
2. Generate the signing key.
3. Fill `KEY_FINGERPRINT` and `KEY_KEYRING_B64` in `install.sh` (`gpg --export <fpr> | base64 | tr -d '\n'`).
4. Replace the `XXXX` fingerprint in `README.md` and `docs/cli.md`.
